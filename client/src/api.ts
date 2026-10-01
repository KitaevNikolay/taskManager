export interface Employee {
  id: number;
  name: string;
  department: string | null;
  email: string | null;
  position: string | null;
  photo: string | null;
  sort_order: number;
  is_buffer: number;
  dayoff_granted: number;
  dayoff?: { granted: number; used: number; left: number };
  absence_now?: Absence | null;
  absence_next?: Absence | null;
  open_count?: number;
  overdue_count?: number;
  in_progress_count?: number;
}

export type AbsenceType = 'vacation' | 'dayoff' | 'sick';
export interface Absence {
  id: number;
  employee_id: number;
  type: AbsenceType;
  date_from: string;
  date_to: string;
  comment: string | null;
  days?: number;
  shifted?: number;
}
export const ABSENCE_TYPES: Record<AbsenceType, { label: string; color: string }> = {
  vacation: { label: 'Отпуск', color: '#2e9d4f' },
  dayoff: { label: 'Отгул', color: '#2f6fed' },
  sick: { label: 'Больничный', color: '#d9822b' },
};

export interface Stage {
  id: number;
  entity_id: number;
  title: string;
  sort: number;
  color: string;
}

export interface Task {
  id: number;
  title: string;
  status: number;
  stage_id: number | null;
  group_id: number | null;
  group_name: string | null;
  responsible_id: number | null;
  responsible_name: string | null;
  responsible_icon: string | null;
  creator_name: string | null;
  priority: number | null;
  parent_id: number | null;
  created_date: string | null;
  changed_date: string | null;
  activity_date: string | null;
  closed_date: string | null;
  deadline: string | null;
  start_date_plan: string | null;
  end_date_plan: string | null;
  time_estimate: number | null;
  depends_on: number[];
  tags: string[];
  responsible_since: string | null;
  stage_since: string | null;
  unread_alerts: number;
  queue_pos: number | null;
  is_employee: boolean;
  /** Оповещения по задаче: on — всегда, off — никогда, null — по общим правилам */
  notify: 'on' | 'off' | null;
}

export interface Alert {
  id: number;
  type: string;
  task_id: number | null;
  employee_id: number | null;
  note_id?: number | null;
  title: string;
  message: string | null;
  author: string | null;
  created_at: string;
  read_at: string | null;
  task_title?: string;
  employee_name?: string;
}

export interface Meta {
  portalUrl: string;
  groupId: number;
  selfUserId: number;
  stages: Stage[];
  allStages: Stage[];
  workStageId: number | null;
  pauseStageId: number | null;
  statusNames: Record<number, string>;
  sync: { running: boolean; lastSyncAt: string | null; lastError: string | null };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/login') window.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(res.status, data.error || res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => req<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T>(url: string) => req<T>('DELETE', url),
};

// ---------- Форматирование ----------
const TZ = 'Europe/Moscow';
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const daysSince = (iso: string | null | undefined) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3) : null;
export function relTime(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return fmtDateTime(iso);
}
/** YYYY-MM-DD по Москве */
export const toYmd = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ }) : '';

export type DeadlineState = 'overdue' | 'soon' | 'ok' | null;
export function deadlineState(t: Pick<Task, 'deadline' | 'status'>, warnHours = 24): DeadlineState {
  if (!t.deadline || t.status === 5) return null;
  const left = new Date(t.deadline).getTime() - Date.now();
  if (left < 0) return 'overdue';
  if (left < warnHours * 3600e3) return 'soon';
  return 'ok';
}

export const ALERT_TYPES: Record<string, { label: string; tone: string }> = {
  change: { label: 'Изменение', tone: 'info' },
  comment: { label: 'Комментарий', tone: 'info' },
  assigned: { label: 'Назначение', tone: 'accent' },
  new: { label: 'Новая задача', tone: 'accent' },
  stale: { label: 'Долго на сотруднике', tone: 'warn' },
  idle: { label: 'Нет движения', tone: 'warn' },
  deadline_soon: { label: 'Скоро срок', tone: 'warn' },
  overdue: { label: 'Просрочено', tone: 'danger' },
  absence: { label: 'Срок в отсутствие', tone: 'warn' },
  note: { label: 'Напоминание', tone: 'accent' },
};

// ---------- Календарь (даты YYYY-MM-DD) ----------
export const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export const isWeekend = (ymd: string) => [0, 6].includes(new Date(ymd + 'T00:00:00Z').getUTCDay());
/** Календарные дни между датами, обе границы включены */
export const daysCount = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400e3) + 1;
export const fmtYmd = (ymd: string) => ymd.split('-').reverse().join('.');
export const fmtYmdShort = (ymd: string) => ymd.slice(8, 10) + '.' + ymd.slice(5, 7);
