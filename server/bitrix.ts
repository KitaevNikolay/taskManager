// Клиент REST API Битрикс24 через входящий вебхук.
// Все запросы идут через очередь с ограничением частоты (лимит Б24 ~2 запроса/сек).

const WEBHOOK = (process.env.BITRIX_TASK_WEBHOOK || '').replace(/\/+$/, '');
if (!WEBHOOK) throw new Error('BITRIX_TASK_WEBHOOK не задан в .env');

export const PORTAL_URL = new URL(WEBHOOK).origin;
export const GROUP_ID = Number(process.env.BITRIX_GROUP || 0);

export class BitrixError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MIN_INTERVAL_MS = 350;
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Сериализация в PHP-стиле: filter[GROUP_ID]=28&select[]=ID */
export function toQuery(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v) && v.length === 0) continue;
      parts.push(toQuery(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v === null ? '' : String(v))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await throttle(() =>
        fetch(`${WEBHOOK}/${method}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: toQuery(params),
          signal: AbortSignal.timeout(30000),
        }),
      );
    } catch (e: any) {
      // Сетевой сбой (таймаут соединения, обрыв) — повторяем с паузой
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new BitrixError('NETWORK', `нет связи с порталом (${e?.cause?.code || e?.name || e?.message})`);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = { error: 'HTTP_' + res.status, error_description: res.statusText };
    }
    if (body.error) {
      const retryable = body.error === 'QUERY_LIMIT_EXCEEDED' || res.status >= 500;
      if (retryable && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new BitrixError(body.error, body.error_description || body.error);
    }
    return body as T;
  }
}

/** Вызов, возвращающий только поле result */
export async function callResult<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await call<{ result: T }>(method, params)).result;
}

/** batch: до 50 команд за запрос. Возвращает результаты и ошибки по ключам. */
export async function batch(cmds: Record<string, [string, Record<string, unknown>]>) {
  const keys = Object.keys(cmds);
  const result: Record<string, any> = {};
  const errors: Record<string, any> = {};
  for (let i = 0; i < keys.length; i += 50) {
    const cmd: Record<string, string> = {};
    for (const k of keys.slice(i, i + 50)) cmd[k] = `${cmds[k][0]}?${toQuery(cmds[k][1])}`;
    const r = await callResult<{ result: Record<string, any>; result_error: Record<string, any> }>('batch', { halt: 0, cmd });
    Object.assign(result, Array.isArray(r.result) ? {} : r.result);
    Object.assign(errors, Array.isArray(r.result_error) ? {} : r.result_error);
  }
  return { result, errors };
}

export const TASK_SELECT = [
  'ID', 'TITLE', 'STATUS', 'STAGE_ID', 'GROUP_ID', 'RESPONSIBLE_ID', 'CREATED_BY', 'PRIORITY', 'PARENT_ID',
  'CREATED_DATE', 'CHANGED_DATE', 'ACTIVITY_DATE', 'CLOSED_DATE', 'DEADLINE', 'START_DATE_PLAN', 'END_DATE_PLAN',
  'TIME_ESTIMATE', 'TAGS',
];

export interface B24Task {
  id: string;
  title: string;
  status: string;
  stageId: string;
  groupId: string;
  group?: { id: string; name: string } | [];
  responsibleId: string;
  responsible?: { id: string; name: string; icon?: string; workPosition?: string };
  createdBy: string;
  creator?: { id: string; name: string };
  priority: string;
  parentId: string | null;
  createdDate: string | null;
  changedDate: string | null;
  activityDate: string | null;
  closedDate: string | null;
  deadline: string | null;
  startDatePlan: string | null;
  endDatePlan: string | null;
  timeEstimate: string | null;
  tags?: Record<string, { id: number; title: string }> | [];
}

/** Все страницы tasks.task.list по фильтру */
export async function listTasks(filter: Record<string, unknown>, select = TASK_SELECT): Promise<B24Task[]> {
  const out: B24Task[] = [];
  let start = 0;
  for (;;) {
    const r = await call<{ result: { tasks: B24Task[] }; next?: number }>('tasks.task.list', {
      filter,
      select,
      order: { ID: 'asc' },
      start,
    });
    out.push(...r.result.tasks);
    if (!r.next) break;
    start = r.next;
  }
  return out;
}

export interface HistoryItem {
  id: number;
  createdDate: string;
  field: string;
  value: { from: string | null; to: string | null };
  user: { id: number; name: string; lastName: string };
}
