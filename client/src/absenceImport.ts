// Разбор файла с отсутствиями (xlsx / csv / json) в таблицу, распознавание колонок, дат, типов и сотрудников.
import type { AbsenceType, Employee } from './api';

export type Cell = string | number | boolean | Date | null;
export type Field = 'employee' | 'empId' | 'type' | 'from' | 'to' | 'days' | 'comment';
export type Mapping = Record<Field, number | null>;

export const FIELD_LABELS: Record<Field, string> = {
  employee: 'Сотрудник (ФИО)',
  empId: 'ID в Битрикс24',
  type: 'Тип',
  from: 'Дата начала',
  to: 'Дата окончания',
  days: 'Количество дней',
  comment: 'Комментарий',
};

// ---------- Чтение файла ----------
export async function readTable(file: File): Promise<Cell[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser');
    return (await readSheet(file)) as Cell[][];
  }
  if (name.endsWith('.xls')) throw new Error('Старый формат .xls не поддерживается — сохраните файл как .xlsx или .csv');
  const text = decode(await file.arrayBuffer());
  if (name.endsWith('.json') || /^\s*[[{]/.test(text)) return jsonToTable(text);
  return parseCsv(text);
}

/** UTF-8, а если не получилось — Windows-1251 (так сохраняет CSV русский Excel) */
function decode(buf: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function parseCsv(text: string): Cell[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', '\t', ','].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r): Cell[] => r.map((v) => (v.trim() === '' ? null : v.trim()))).filter((r) => r.some((v) => v !== null));
}

function jsonToTable(text: string): Cell[][] {
  let data = JSON.parse(text);
  if (!Array.isArray(data)) data = data.absences || data.items || data.data || data.rows;
  if (!Array.isArray(data)) throw new Error('В JSON ожидается массив записей или объект с полем absences');
  // У записей могут быть разные имена полей (date_from / from / start) — сводим к единым колонкам
  const fields = Object.keys(FIELD_LABELS) as Field[];
  const recs = data.map((o: Record<string, unknown>) => {
    const rec: Partial<Record<Field, Cell>> = {};
    for (const [k, v] of Object.entries(o || {})) {
      const f = fieldOf(k);
      if (f && (rec[f] === undefined || rec[f] === null)) rec[f] = (v ?? null) as Cell;
    }
    return rec;
  });
  const used = fields.filter((f) => recs.some((r: Partial<Record<Field, Cell>>) => r[f] !== undefined));
  return [used.map((f) => FIELD_LABELS[f]), ...recs.map((r: Partial<Record<Field, Cell>>) => used.map((f) => r[f] ?? null))];
}

// ---------- Колонки ----------
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const SYNONYMS: Record<Field, string[]> = {
  employee: ['сотрудник', 'фио', 'ф и о', 'работник', 'фамилия имя отчество', 'фамилия имя', 'employee', 'name', 'full name', 'исполнитель'],
  empId: ['id', 'id сотрудника', 'id в битрикс', 'id в битрикс24', 'битрикс id', 'b24', 'b24 id', 'bitrix id', 'bitrix', 'employee id', 'employee_id', 'user id'],
  type: ['тип', 'вид', 'тип отсутствия', 'вид отсутствия', 'вид отпуска', 'type', 'kind'],
  from: ['с', 'начало', 'дата начала', 'с даты', 'начало отпуска', 'дата начала отпуска', 'запланированная дата', 'from', 'start', 'date from', 'date_from', 'start date'],
  to: ['по', 'окончание', 'дата окончания', 'по дату', 'конец', 'окончание отпуска', 'дата окончания отпуска', 'to', 'end', 'date to', 'date_to', 'end date'],
  days: ['дней', 'дни', 'кол во дней', 'количество дней', 'количество календарных дней', 'календарных дней', 'длительность', 'days', 'duration'],
  comment: ['комментарий', 'примечание', 'заметка', 'описание', 'comment', 'note', 'notes'],
};

function fieldOf(header: unknown): Field | null {
  const h = norm(header);
  if (!h) return null;
  for (const f of Object.keys(SYNONYMS) as Field[]) if (SYNONYMS[f].includes(h)) return f;
  for (const f of Object.keys(SYNONYMS) as Field[]) {
    if (SYNONYMS[f].some((s) => s.length > 3 && (h.startsWith(s) || h.includes(s)))) return f;
  }
  return null;
}

/** Строка заголовков: первая из первых 15, где узнаётся хотя бы 2 колонки (сверху может быть шапка документа) */
export function detect(rows: Cell[][]): { headerIdx: number; mapping: Mapping } {
  let best = { idx: 0, score: -1 };
  rows.slice(0, 15).forEach((r, idx) => {
    const score = new Set(r.map(fieldOf).filter(Boolean)).size;
    if (score > best.score) best = { idx, score };
  });
  const headerIdx = best.score >= 2 ? best.idx : 0;
  return { headerIdx, mapping: mapHeaders(rows[headerIdx] || []) };
}

/** Сопоставление колонок по строке заголовков */
export function mapHeaders(header: Cell[]): Mapping {
  const mapping: Mapping = { employee: null, empId: null, type: null, from: null, to: null, days: null, comment: null };
  header.forEach((h, i) => {
    const f = fieldOf(h);
    if (f && mapping[f] === null) mapping[f] = i;
  });
  return mapping;
}

// ---------- Значения ----------
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

export function parseDate(v: Cell): string | null {
  if (v === null || v === '') return null;
  if (v instanceof Date) return isNaN(+v) ? null : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') {
    // Порядковый номер дня Excel (1 = 01.01.1900)
    if (v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400e3);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([а-яё]+)\s+(\d{4})/.exec(s);
  if (m) {
    const mi = MONTHS.findIndex((p) => m![2].replace('ё', 'е').startsWith(p));
    if (mi >= 0) return ymd(+m[3], mi + 1, +m[1]);
  }
  return null;
}

export function parseType(v: Cell): AbsenceType | null {
  const s = norm(v);
  if (!s) return 'vacation';
  if (/отпуск|vacation|holiday|ежегодн|отдых/.test(s)) return 'vacation';
  if (/отгул|day ?off|выходн/.test(s)) return 'dayoff';
  if (/больнич|sick|болезн|нетрудоспособ/.test(s)) return 'sick';
  return null;
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

/** Поиск сотрудника по ФИО: порядок слов не важен, «ё» = «е», отчество и инициалы допускаются */
export function matchEmployee(raw: Cell, employees: Employee[]): { id: number | null; reason?: string } {
  const toks = norm(raw).split(' ').filter(Boolean);
  if (!toks.length) return { id: null, reason: 'Не указан сотрудник' };
  const scored = employees.map((e) => {
    const et = norm(e.name).split(' ').filter(Boolean);
    const full = et.every((t) => toks.includes(t));
    // «Китаев Н.А.» — фамилия совпала, остальные слова сходятся по первой букве
    const initials = !full && et.some((t) => toks.includes(t)) && toks.filter((t) => !et.includes(t)).every((t) => t.length <= 2 && et.some((x) => x.startsWith(t)));
    return { e, score: full ? 2 : initials ? 1 : 0 };
  }).filter((x) => x.score > 0);
  if (!scored.length) return { id: null, reason: `Не найден: «${String(raw).trim()}»` };
  const top = Math.max(...scored.map((x) => x.score));
  const best = scored.filter((x) => x.score === top);
  if (best.length > 1) return { id: null, reason: `Несколько совпадений: ${best.map((x) => x.e.name).join(', ')}` };
  return { id: best[0].e.id };
}

export interface ParsedRow {
  line: number; // номер строки в файле (с 1)
  employeeRaw: string;
  employee_id: number | null;
  type: AbsenceType | null;
  date_from: string | null;
  date_to: string | null;
  comment: string;
  /** Не найден сотрудник (можно выбрать вручную) */
  empError: string | null;
  /** Ошибка в типе или датах */
  dataError: string | null;
  error: string | null;
}

export function toRows(rows: Cell[][], headerIdx: number, mp: Mapping, employees: Employee[]): ParsedRow[] {
  const get = (r: Cell[], f: Field) => (mp[f] === null ? null : r[mp[f]!] ?? null);
  const ids = new Set(employees.map((e) => e.id));
  const blank = (r: Cell[]) => [get(r, 'from'), get(r, 'to'), get(r, 'days')].every((v) => v === null || v === '');
  return rows.slice(headerIdx + 1).map((r, i) => ({ r, line: headerIdx + i + 2 })).filter(({ r }) => !blank(r)).map(({ r, line }) => {
    const empRaw = get(r, 'employee');
    const idRaw = Number(get(r, 'empId'));
    let employee_id: number | null = null;
    let empErr: string | undefined;
    if (Number.isInteger(idRaw) && idRaw > 0) {
      if (ids.has(idRaw)) employee_id = idRaw;
      else empErr = `ID ${idRaw} нет в ваших сотрудниках`;
    }
    if (!employee_id && empRaw !== null) {
      const m = matchEmployee(empRaw, employees);
      employee_id = m.id;
      empErr = m.reason;
    }
    if (!employee_id && empRaw === null && !empErr) empErr = 'Не указан сотрудник';
    const type = parseType(get(r, 'type'));
    const date_from = parseDate(get(r, 'from'));
    const daysRaw = get(r, 'days');
    const days = daysRaw === null || daysRaw === '' ? NaN : Number(String(daysRaw).replace(',', '.'));
    // Количество дней главнее даты окончания: окончание = начало + дней − 1 (так же считает формула в шаблоне)
    const date_to = date_from && Number.isFinite(days) && days >= 1 ? addDays(date_from, Math.round(days) - 1) : parseDate(get(r, 'to'));
    const empError = employee_id ? null : empErr || 'Не указан сотрудник';
    const dataError =
      !type ? `Неизвестный тип «${String(get(r, 'type'))}»`
        : !date_from ? `Не распознана дата начала «${String(get(r, 'from') ?? '')}»`
          : daysRaw !== null && daysRaw !== '' && !(days >= 1) ? `Не распознано количество дней «${String(daysRaw)}»`
          : !date_to ? 'Укажите количество дней (или дату окончания)'
            : date_to < date_from ? 'Окончание раньше начала' : null;
    const error = empError || dataError;
    return {
      line,
      employeeRaw: String(empRaw ?? (Number.isFinite(idRaw) && idRaw ? `ID ${idRaw}` : '')).trim(),
      employee_id,
      type,
      date_from,
      date_to,
      comment: String(get(r, 'comment') ?? '').trim(),
      empError,
      dataError,
      error,
    };
  }).filter((p) => p.employeeRaw || p.date_from || p.comment);
}

// ---------- Шаблон для заполнения: все сотрудники пользователя ----------
// Колонки: A Сотрудник, B ID, C Команда, D Тип, E Начало, F Дней, G Окончание (формула), H Комментарий
const TEMPLATE_HEADER = ['Сотрудник', 'ID в Битрикс24', 'Команда', 'Тип', 'Начало', 'Дней', 'Окончание', 'Комментарий'];
/** Сколько строк-периодов отпуска заготовить на каждого сотрудника */
export const TEMPLATE_PERIODS = 4;
const teamOf = (e: Employee) => (e.department || '').trim();

const INSTRUCTION = [
  'Как заполнить',
  '',
  `1. У каждого сотрудника ${TEMPLATE_PERIODS} строки — по строке на каждый период отпуска. Нужно больше — скопируйте строку сотрудника.`,
  '2. Укажите «Начало» (дату первого дня) и «Дней» — количество календарных дней, первый и последний день включительно.',
  '3. «Окончание» считается само по формуле: Начало + Дней − 1. Его не нужно заполнять.',
  '4. Тип: Отпуск, Отгул или Больничный. Если оставить пустым — будет отпуск.',
  '5. Строки без дат при загрузке пропускаются — лишние можно не удалять.',
  '6. Даты: 01.07.2027, 2027-07-01 или обычная дата Excel.',
  '7. Сотрудник определяется по «ID в Битрикс24», а если его нет — по ФИО.',
  '',
  'Загрузить заполненный файл: «Отсутствия» → «Импорт из файла».',
];

/** Шаблон XLSX: по несколько строк-периодов на сотрудника, окончание — формулой; лист с инструкцией */
export async function downloadTemplateXlsx(employees: Employee[]) {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const head = TEMPLATE_HEADER.map((v) => ({ value: v, fontWeight: 'bold' as const, backgroundColor: '#E8F0FE', borderColor: '#B8C7E0', borderStyle: 'thin' }));
  const DATE = 'dd.mm.yyyy';
  const rows: any[] = [];
  employees.forEach((e, ei) => {
    // Полосы по сотрудникам — чтобы строки разных людей не путались
    const bg = ei % 2 ? '#F4F6F9' : '#FFFFFF';
    const cell = (value: unknown, extra: Record<string, unknown> = {}) => ({ value: value ?? undefined, backgroundColor: bg, ...extra });
    for (let p = 0; p < TEMPLATE_PERIODS; p++) {
      const n = rows.length + 2; // номер строки в Excel (1 — заголовок)
      rows.push([
        cell(e.name, p ? { textColor: '#6B7682' } : { fontWeight: 'bold' }),
        cell(e.id, { type: Number }),
        cell(teamOf(e) || null),
        cell('Отпуск'),
        cell(null, { type: Date, format: DATE }),
        cell(null, { type: Number }),
        // Формула в XLSX хранится без «=» (так её пишет и сам Excel)
        { type: 'Formula', value: `IF(AND(E${n}<>"",F${n}<>""),E${n}+F${n}-1,"")`, format: DATE, backgroundColor: '#EEF7F0', textColor: '#2E7D46' },
        cell(null),
      ]);
    }
  });
  await writeExcelFile([
    {
      data: [head, ...rows],
      sheet: 'Отсутствия',
      columns: [{ width: 34 }, { width: 14 }, { width: 22 }, { width: 12 }, { width: 13 }, { width: 8 }, { width: 13 }, { width: 36 }],
      stickyRowsCount: 1,
    },
    { data: INSTRUCTION.map((l, i) => [i === 0 ? { value: l, fontWeight: 'bold' as const } : l]) as any, sheet: 'Как заполнить', columns: [{ width: 120 }] },
  ]).toFile('отсутствия-шаблон.xlsx');
}

/** Шаблон CSV для Excel (разделитель «;», BOM — чтобы Excel понял UTF-8). Окончание посчитается при загрузке. */
export function downloadTemplateCsv(employees: Employee[]) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = employees.flatMap((e) => Array.from({ length: TEMPLATE_PERIODS }, () => [e.name, e.id, teamOf(e), 'Отпуск', '', '', '', '']));
  const lines = [TEMPLATE_HEADER, ...rows].map((r) => r.map(esc).join(';'));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'отсутствия-шаблон.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
