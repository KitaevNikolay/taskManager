import { useEffect, useMemo, useState } from 'react';
import { ABSENCE_TYPES, api, fmtYmd } from '../api';
import { useApp } from '../App';
import {
  FIELD_LABELS, detect, downloadTemplateCsv, downloadTemplateXlsx, mapHeaders, readTable, toRows,
  type Cell, type Field, type Mapping, type ParsedRow,
} from '../absenceImport';

type Status = 'ok' | 'replace' | 'duplicate' | 'conflict' | 'error';
interface ServerResult { index: number; status: Status; reason?: string; absence_id?: number; impact?: number }

const STATUS_VIEW: Record<Status, { label: string; tone: string }> = {
  ok: { label: 'будет добавлено', tone: 'ok' },
  replace: { label: 'заменит', tone: 'warn' },
  duplicate: { label: 'уже внесено', tone: 'muted' },
  conflict: { label: 'пересекается', tone: 'warn' },
  error: { label: 'ошибка', tone: 'danger' },
};

/** Кнопки скачивания шаблона — со всеми сотрудниками пользователя */
export function TemplateButtons() {
  const { employees, toast } = useApp();
  const xlsx = async () => {
    try {
      await downloadTemplateXlsx(employees);
    } catch (e: any) {
      toast(`Не удалось сформировать файл: ${e.message}`, 'error');
    }
  };
  return (
    <span className="tpl-buttons">
      <button type="button" className="btn sm" onClick={xlsx} disabled={!employees.length}>Шаблон XLSX</button>
      <button type="button" className="btn ghost sm" onClick={() => downloadTemplateCsv(employees)} disabled={!employees.length}>CSV</button>
    </span>
  );
}

export function AbsenceImport({ onClose, onDone, onImpact }: { onClose: () => void; onDone: () => void; onImpact: (absenceId: number) => void }) {
  const { employees, toast, reloadEmployees, bump } = useApp();
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<Cell[][] | null>(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'skip' | 'replace'>('skip');
  const [check, setCheck] = useState<Record<number, ServerResult>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; rows: (ServerResult & { row: ParsedRow })[] } | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const load = async (file: File) => {
    setBusy(true);
    try {
      const t = await readTable(file);
      if (!t.length) throw new Error('Файл пустой');
      const d = detect(t);
      setFileName(file.name);
      setTable(t);
      setHeaderIdx(d.headerIdx);
      setMapping(d.mapping);
      setOverrides({});
      setExcluded(new Set());
      setResult(null);
    } catch (e: any) {
      toast(`Не удалось прочитать файл: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Строки файла с учётом выбранного вручную сотрудника
  const rows = useMemo(() => {
    if (!table || !mapping) return [];
    return toRows(table, headerIdx, mapping, employees).map((r) => {
      const manual = overrides[r.line];
      return manual ? { ...r, employee_id: manual, empError: null, error: r.dataError } : r;
    });
  }, [table, headerIdx, mapping, employees, overrides]);

  const candidates = rows.filter((r) => !r.error && !excluded.has(r.line));

  // Проверка на сервере: пересечения с уже внесёнными, дубли
  useEffect(() => {
    if (!candidates.length) { setCheck({}); return; }
    const t = setTimeout(() => {
      api.post<{ results: ServerResult[] }>('/absences/import', { dryRun: true, conflict: mode, rows: candidates.map(toPayload) })
        .then((r) => setCheck(Object.fromEntries(r.results.map((x) => [candidates[x.index].line, x]))))
        .catch((e) => toast(e.message, 'error'));
    }, 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(candidates.map(toPayload)), mode]); // eslint-disable-line

  const toImport = candidates.filter((r) => ['ok', 'replace'].includes(check[r.line]?.status));

  const doImport = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ results: ServerResult[]; created: number }>('/absences/import', { conflict: mode, rows: toImport.map(toPayload) });
      setResult({ created: r.created, rows: r.results.map((x) => ({ ...x, row: toImport[x.index] })) });
      toast(`Импортировано отсутствий: ${r.created}`, 'ok');
      reloadEmployees();
      bump();
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const empName = (id: number | null) => employees.find((e) => e.id === id)?.name;
  const headers = table?.[headerIdx] || [];
  const colLabel = (i: number) => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}: ${String(headers[i] ?? '').slice(0, 30) || '—'}`;
  const counts = {
    total: rows.length,
    errors: rows.filter((r) => r.error).length,
    ok: toImport.length,
    skipped: candidates.filter((r) => ['duplicate', 'conflict', 'error'].includes(check[r.line]?.status)).length,
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card abs-import">
        <div className="row between">
          <h2>Импорт отсутствий из файла</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>

        {result ? (
          <div className="form">
            <div className="form-hint ok">Добавлено отсутствий: <b>{result.created}</b>.</div>
            {result.rows.some((x) => x.impact) ? (
              <>
                <p className="small">Эти отсутствия затрагивают сроки задач — их можно сдвинуть:</p>
                <div className="imp-result">
                  {result.rows.filter((x) => x.impact && x.absence_id).map((x) => (
                    <div key={x.absence_id} className="abs-item">
                      <i style={{ background: ABSENCE_TYPES[x.row.type!].color }} />
                      <div className="abs-item-main">
                        <b>{empName(x.row.employee_id)}</b> · {ABSENCE_TYPES[x.row.type!].label} {fmtYmd(x.row.date_from!)} – {fmtYmd(x.row.date_to!)}
                        <div className="muted small">задач со сроками в этот период: {x.impact}</div>
                      </div>
                      <button className="btn sm" onClick={() => onImpact(x.absence_id!)}>Сроки</button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted small">Сроки открытых задач эти отсутствия не затрагивают.</p>
            )}
            <div className="row end"><button className="btn primary" onClick={onClose}>Готово</button></div>
          </div>
        ) : (
          <>
            <div
              className={`drop-zone ${drag ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}
            >
              <div>
                <b>{fileName || 'Перетащите файл сюда'}</b>
                <div className="muted small">XLSX, CSV или JSON. Колонки: сотрудник (ФИО или ID в Битрикс24), тип, дата начала, количество дней (окончание посчитается само), комментарий.</div>
              </div>
              <label className="btn">
                Выбрать файл
                <input type="file" accept=".xlsx,.csv,.json,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
              </label>
            </div>
            <div className="row wrap small">
              <span className="muted">Шаблон: у каждого сотрудника строки под периоды отпуска — впишите начало и количество дней, окончание посчитается формулой:</span>
              <TemplateButtons />
            </div>

            {table && mapping && (
              <>
                <details className="imp-mapping" open={mappingIncomplete(mapping)}>
                  <summary>Колонки файла {mappingIncomplete(mapping) && <span className="chip warn">проверьте</span>}</summary>
                  <div className="imp-map-grid">
                    <label className="field">
                      <span>Строка заголовков</span>
                      <select value={headerIdx} onChange={(e) => { const i = Number(e.target.value); setHeaderIdx(i); setMapping(detectAt(table, i)); }}>
                        {table.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter((v) => v !== null).slice(0, 4).map(String).join(' | ').slice(0, 60)}</option>)}
                      </select>
                    </label>
                    {(Object.keys(FIELD_LABELS) as Field[]).map((f) => (
                      <label key={f} className="field">
                        <span>{FIELD_LABELS[f]}</span>
                        <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}>
                          <option value="">— нет —</option>
                          {headers.map((_, i) => <option key={i} value={i}>{colLabel(i)}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </details>

                <div className="imp-summary small">
                  Строк с датами: <b>{counts.total}</b> · к импорту: <b className="ok-text">{counts.ok}</b>
                  {counts.errors > 0 && <> · с ошибками: <b className="danger-text">{counts.errors}</b></>}
                  {counts.skipped > 0 && <> · пропустится: <b>{counts.skipped}</b></>}
                </div>

                <div className="table-wrap imp-table">
                  <table className="table">
                    <thead><tr><th /><th>Стр.</th><th>Сотрудник</th><th>Тип</th><th>С</th><th>По</th><th>Дн.</th><th>Комментарий</th><th>Статус</th></tr></thead>
                    <tbody>
                      {rows.length === 0 && <tr><td colSpan={9} className="muted center">Нет строк с датами. Проверьте колонки выше.</td></tr>}
                      {rows.map((r) => {
                        const st = r.error ? null : check[r.line];
                        const off = excluded.has(r.line);
                        const empError = !!r.empError;
                        return (
                          <tr key={r.line} className={off ? 'row-muted' : r.error ? 'row-danger' : ''}>
                            <td>
                              <input type="checkbox" checked={!off && !r.error} disabled={!!r.error}
                                onChange={() => { const n = new Set(excluded); n.has(r.line) ? n.delete(r.line) : n.add(r.line); setExcluded(n); }} />
                            </td>
                            <td className="muted">{r.line}</td>
                            <td>
                              {empError || overrides[r.line] || (r.employee_id === null && rows.find((x) => x.line === r.line)?.empError) ? (
                                <select value={overrides[r.line] ?? ''} onChange={(e) => setOverrides({ ...overrides, [r.line]: Number(e.target.value) })}>
                                  <option value="">«{r.employeeRaw || '?'}» — выберите…</option>
                                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                                </select>
                              ) : (
                                <span title={r.employeeRaw}>{empName(r.employee_id)}</span>
                              )}
                            </td>
                            <td>{r.type ? ABSENCE_TYPES[r.type].label : '—'}</td>
                            <td>{r.date_from ? fmtYmd(r.date_from) : '—'}</td>
                            <td>{r.date_to ? fmtYmd(r.date_to) : '—'}</td>
                            <td className="nums">{r.date_from && r.date_to ? Math.round((Date.parse(r.date_to) - Date.parse(r.date_from)) / 86400e3) + 1 : ''}</td>
                            <td className="imp-comment" title={r.comment}>{r.comment}</td>
                            <td className="imp-status">
                              {r.error ? <span className="danger-text small">{r.error}</span>
                                : off ? <span className="muted small">не импортировать</span>
                                  : st ? <><span className={`chip ${STATUS_VIEW[st.status].tone}`}>{STATUS_VIEW[st.status].label}</span>{st.reason && <div className="muted small">{st.reason}</div>}</>
                                    : <span className="muted small">проверка…</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="row between wrap">
                  <div className="row wrap small">
                    <span className="muted">Если пересекается с уже внесённым:</span>
                    <label className="check"><input type="radio" checked={mode === 'skip'} onChange={() => setMode('skip')} /> пропустить строку</label>
                    <label className="check"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> заменить внесённое</label>
                  </div>
                  <div className="row">
                    <button className="btn ghost" onClick={onClose}>Отмена</button>
                    <button className="btn primary" disabled={busy || !toImport.length} onClick={doImport}>
                      {busy ? 'Импортирую…' : `Импортировать (${toImport.length})`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Не хватает обязательных колонок: даты начала или сотрудника (номер колонки 0 — тоже выбранная колонка) */
const mappingIncomplete = (m: Mapping) => m.from === null || (m.employee === null && m.empId === null);

const toPayload = (r: ParsedRow) => ({ employee_id: r.employee_id, type: r.type, date_from: r.date_from, date_to: r.date_to, comment: r.comment });

/** Пересобрать сопоставление колонок для выбранной вручную строки заголовков */
const detectAt = (table: Cell[][], idx: number): Mapping => mapHeaders(table[idx] || []);
