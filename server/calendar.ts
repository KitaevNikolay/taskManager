// Рабочий календарь: даты как строки 'YYYY-MM-DD' (по Москве), выходные — сб/вс, плюс дни отсутствий сотрудника.
import { q } from './db.ts';

const TZ = 'Europe/Moscow';
const DAY = 86400e3;

export const todayYmd = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
export const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

export const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const isWeekend = (ymd: string) => {
  const d = new Date(ymd + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6;
};

/** Дата и время по Москве из ISO-строки Б24 */
export function mskParts(iso: string): { ymd: string; time: string } {
  const d = new Date(iso);
  return {
    ymd: d.toLocaleDateString('sv-SE', { timeZone: TZ }),
    time: d.toLocaleTimeString('ru-RU', { timeZone: TZ, hour12: false }),
  };
}
export const mskIso = (ymd: string, time = '18:00:00') => `${ymd}T${time}+03:00`;

/** Все календарные дни в диапазоне [from, to] включительно */
export function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Рабочие дни (без выходных) в диапазоне [from, to] включительно */
export function workdaysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

export interface Absence {
  id: number;
  user_id: number;
  employee_id: number;
  type: 'vacation' | 'dayoff' | 'sick';
  date_from: string;
  date_to: string;
  comment: string | null;
}

export const ABSENCE_NAMES: Record<string, string> = { vacation: 'Отпуск', dayoff: 'Отгул', sick: 'Больничный' };

export const absencesOf = (userId: number, empId: number) =>
  q.all<Absence>('SELECT * FROM absences WHERE user_id = ? AND employee_id = ? ORDER BY date_from', userId, empId);

/** Множество дней, когда сотрудник отсутствует */
export function absentDays(userId: number, empId: number, list = absencesOf(userId, empId)): Set<string> {
  const set = new Set<string>();
  for (const a of list) for (const d of daysIn(a.date_from, a.date_to)) set.add(d);
  return set;
}

/** Отсутствие сотрудника на дату (или null) */
export function absenceOn(userId: number, empId: number, ymd: string): Absence | null {
  return q.get<Absence>('SELECT * FROM absences WHERE user_id = ? AND employee_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1', userId, empId, ymd, ymd) || null;
}

const isOff = (d: string, skip?: Set<string>) => isWeekend(d) || !!skip?.has(d);

/** Ближайший рабочий день начиная с ymd (сам день, если рабочий) */
export function nextWorkday(ymd: string, skip?: Set<string>) {
  let d = ymd;
  while (isOff(d, skip)) d = addDays(d, 1);
  return d;
}

/** Сдвиг на n рабочих дней вперёд, пропуская выходные и дни из skip */
export function addWorkdays(ymd: string, n: number, skip?: Set<string>) {
  let d = ymd;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isOff(d, skip)) left--;
  }
  return d;
}

/** Число рабочих дней между датами включительно (минимум 1) */
export function workdaysBetween(a: string, b: string) {
  return Math.max(1, workdaysIn(a.slice(0, 10), b.slice(0, 10)).length);
}
