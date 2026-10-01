import { q, getSettings, getMeta, setMeta } from './db.ts';
import { batch, callResult, listTasks, GROUP_ID, TASK_SELECT, BitrixError, type B24Task, type HistoryItem } from './bitrix.ts';
import { emit } from './bus.ts';
import { addAlert, runRules } from './alerts.ts';

export const STATUS_NAMES: Record<number, string> = {
  1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена',
};

const FIELD_NAMES: Record<string, string> = {
  STATUS: 'Статус', STAGE: 'Стадия', RESPONSIBLE_ID: 'Ответственный', DEADLINE: 'Крайний срок', TITLE: 'Название',
  DESCRIPTION: 'Описание', AUDITORS: 'Наблюдатели', ACCOMPLICES: 'Соисполнители', TAGS: 'Теги', GROUP_ID: 'Группа',
  PRIORITY: 'Приоритет', START_DATE_PLAN: 'План. начало', END_DATE_PLAN: 'План. окончание', DEPENDS_ON: 'Зависимости',
  PARENT_ID: 'Родительская задача', RESULT: 'Результат', RESULT_EDIT: 'Результат изменён', RESULT_REMOVE: 'Результат удалён',
  TIME_ESTIMATE: 'Оценка времени', TIME_SPENT_IN_LOGS: 'Затраченное время', CREATED_BY: 'Постановщик',
  FILES: 'Файлы', UF_TASK_WEBDAV_FILES: 'Файлы', CHECKLIST_ITEM_CREATE: 'Чек-лист', CHECKLIST_ITEM_CHECK: 'Чек-лист',
  CHECKLIST_ITEM_UNCHECK: 'Чек-лист', CHECKLIST_ITEM_RENAME: 'Чек-лист', CHECKLIST_ITEM_REMOVE: 'Чек-лист',
};

export const syncState = {
  running: false,
  lastSyncAt: null as string | null,
  lastError: null as string | null,
  lastFullAt: 0,
  selfUserId: 0,
};

const empIds = () => q.all<{ id: number }>('SELECT id FROM employees').map((r) => r.id);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Дата для фильтров Б24: ISO с явным смещением */
function b24Date(d: Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Стадии канбана группы отдела и групп, в которых есть задачи сотрудников */
export async function syncStages() {
  const groups = new Set<number>(q.all<{ g: number }>('SELECT DISTINCT group_id AS g FROM tasks WHERE group_id > 0').map((r) => r.g));
  if (GROUP_ID) groups.add(GROUP_ID);
  if (!groups.size) return;
  const cmds: Record<string, [string, Record<string, unknown>]> = {};
  for (const g of groups) cmds[`g${g}`] = ['task.stages.get', { entityId: g }];
  const { result } = await batch(cmds);
  q.tx(() => {
    for (const g of groups) {
      const stages = result[`g${g}`];
      if (!stages || Array.isArray(stages)) continue; // нет доступа или у группы нет канбана — оставляем как было
      q.run('DELETE FROM stages WHERE entity_id = ?', g);
      for (const st of Object.values<any>(stages)) {
        q.run('INSERT OR REPLACE INTO stages(id, entity_id, title, sort, color, system_type) VALUES(?,?,?,?,?,?)', Number(st.ID), g, st.TITLE, Number(st.SORT), st.COLOR, st.SYSTEM_TYPE);
      }
    }
  });
}

function upsertTask(t: B24Task) {
  const g = t.group && !Array.isArray(t.group) ? t.group : null;
  q.run(
    `INSERT INTO tasks(id, title, status, stage_id, group_id, group_name, responsible_id, responsible_name, responsible_icon,
       creator_id, creator_name, priority, parent_id, created_date, changed_date, activity_date, closed_date, deadline,
       start_date_plan, end_date_plan, time_estimate, tags, synced_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, stage_id=excluded.stage_id,
       group_id=excluded.group_id, group_name=excluded.group_name, responsible_id=excluded.responsible_id,
       responsible_name=excluded.responsible_name, responsible_icon=excluded.responsible_icon, creator_id=excluded.creator_id,
       creator_name=excluded.creator_name, priority=excluded.priority, parent_id=excluded.parent_id,
       created_date=excluded.created_date, changed_date=excluded.changed_date, activity_date=excluded.activity_date,
       closed_date=excluded.closed_date, deadline=excluded.deadline, start_date_plan=excluded.start_date_plan,
       end_date_plan=excluded.end_date_plan, time_estimate=excluded.time_estimate, tags=excluded.tags, synced_at=excluded.synced_at`,
    Number(t.id), t.title, Number(t.status), num(t.stageId), num(t.groupId), g?.name ?? null, num(t.responsibleId),
    t.responsible?.name ?? null, t.responsible?.icon ?? null, num(t.createdBy), t.creator?.name ?? null, num(t.priority),
    num(t.parentId) || null, t.createdDate, t.changedDate, t.activityDate, t.closedDate, t.deadline, t.startDatePlan,
    t.endDatePlan, num(t.timeEstimate), JSON.stringify(Object.values(t.tags || {}).map((x) => x.title)), new Date().toISOString(),
  );
}

function userName(id: string | number | null | undefined): string {
  if (!id) return '—';
  const e = q.get<{ name: string }>('SELECT name FROM employees WHERE id = ?', Number(id));
  if (e) return e.name;
  const t = q.get<{ responsible_name: string }>('SELECT responsible_name FROM tasks WHERE responsible_id = ? AND responsible_name IS NOT NULL LIMIT 1', Number(id));
  return t?.responsible_name || `#${id}`;
}

function fmtValue(field: string, v: string | null): string {
  if (v === null || v === '') return '—';
  if (field === 'STATUS') return STATUS_NAMES[Number(v)] || v;
  if (field === 'RESPONSIBLE_ID' || field === 'CREATED_BY') return userName(v);
  if (field === 'DEADLINE' || field === 'START_DATE_PLAN' || field === 'END_DATE_PLAN') {
    const d = /^\d+$/.test(v) ? new Date(Number(v) * 1000) : new Date(v);
    return isNaN(+d) ? v : d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
  }
  if (field === 'DESCRIPTION') return '';
  return v.length > 80 ? v.slice(0, 80) + '…' : v;
}

function describeChanges(items: HistoryItem[]): string {
  const lines: string[] = [];
  const checklist = items.filter((i) => i.field.startsWith('CHECKLIST_ITEM'));
  for (const i of items) {
    if (i.field.startsWith('CHECKLIST_ITEM')) continue;
    const name = FIELD_NAMES[i.field] || i.field;
    if (i.field === 'NEW') lines.push('Задача создана');
    else if (i.field === 'DESCRIPTION') lines.push('Изменено описание');
    else if (i.field === 'TIME_SPENT_IN_LOGS') lines.push('Учтено время');
    else lines.push(`${name}: ${fmtValue(i.field, i.value?.from)} → ${fmtValue(i.field, i.value?.to)}`);
  }
  if (checklist.length) lines.push(`Чек-лист: ${checklist.length} изм.`);
  return lines.join('\n');
}

interface Details {
  history: HistoryItem[];
  dependsOn: number[];
}

async function fetchDetails(ids: number[]): Promise<Map<number, Details>> {
  const cmds: Record<string, [string, Record<string, unknown>]> = {};
  for (const id of ids) {
    cmds[`h${id}`] = ['tasks.task.history.list', { taskId: id }];
    cmds[`d${id}`] = ['task.item.getdependson', { TASKID: id }];
  }
  const { result } = await batch(cmds);
  const map = new Map<number, Details>();
  for (const id of ids) {
    map.set(id, {
      history: (result[`h${id}`]?.list as HistoryItem[]) || [],
      dependsOn: ((result[`d${id}`] as string[]) || []).map(Number),
    });
  }
  return map;
}

type Prev = { id: number; changed_date: string; activity_date: string; responsible_id: number; last_history_id: number } | undefined;

/** Обработка изменённых задач: запись, история, алерты */
async function processTasks(tasks: B24Task[], { alerts }: { alerts: boolean }) {
  if (!tasks.length) return [];
  const prevMap = new Map<number, Prev>();
  for (const t of tasks) prevMap.set(Number(t.id), q.get('SELECT id, changed_date, activity_date, responsible_id, last_history_id FROM tasks WHERE id = ?', Number(t.id)));

  const changed = tasks.filter((t) => {
    const p = prevMap.get(Number(t.id));
    return !p || p.changed_date !== t.changedDate || p.activity_date !== t.activityDate;
  });
  if (!changed.length) return [];

  const details = await fetchDetails(changed.map((t) => Number(t.id)));
  const employees = new Set(empIds());

  q.tx(() => {
    for (const t of changed) {
      const id = Number(t.id);
      const prev = prevMap.get(id);
      const d = details.get(id)!;
      upsertTask(t);

      const lastResp = [...d.history].reverse().find((h) => h.field === 'RESPONSIBLE_ID');
      const lastStage = [...d.history].reverse().find((h) => h.field === 'STAGE' || h.field === 'NEW');
      const maxHistoryId = d.history.reduce((m, h) => Math.max(m, h.id), 0);
      q.run(
        'UPDATE tasks SET depends_on = ?, responsible_since = ?, stage_since = ?, last_history_id = ? WHERE id = ?',
        JSON.stringify(d.dependsOn), lastResp?.createdDate || t.createdDate, lastStage?.createdDate || t.createdDate, maxHistoryId, id,
      );

      if (!alerts) continue;
      const respId = num(t.responsibleId);
      const empId = respId && employees.has(respId) ? respId : null;

      if (!prev) {
        // Задача впервые попала в выборку. Алертим только о свежих событиях,
        // а не о старых задачах, подтянутых при добавлении сотрудника.
        const lastGroup = [...d.history].reverse().find((h) => h.field === 'GROUP_ID');
        const recent = (iso?: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 6 * 3600e3;
        if (Number(t.groupId) === GROUP_ID) {
          if (!recent(lastGroup?.createdDate || t.createdDate)) continue;
          addAlert({ key: `new:${id}`, type: 'new', taskId: id, employeeId: empId, title: `Новая задача в отделе: ${t.title}`, message: `Ответственный: ${t.responsible?.name || '—'}`, author: t.creator?.name });
        } else if (empId && recent(lastResp?.createdDate || t.createdDate)) {
          addAlert({ key: `assigned:${id}:${respId}`, type: 'assigned', taskId: id, employeeId: empId, title: `Сотруднику назначена задача: ${t.title}`, message: `Ответственный: ${t.responsible?.name}`, author: t.creator?.name });
        }
        continue;
      }

      const fresh = d.history.filter((h) => h.id > prev.last_history_id && Number(h.user?.id) !== syncState.selfUserId);
      if (fresh.length) {
        const byAuthor = new Map<string, HistoryItem[]>();
        for (const h of fresh) {
          const a = [h.user?.lastName, h.user?.name].filter(Boolean).join(' ') || `#${h.user?.id}`;
          byAuthor.set(a, [...(byAuthor.get(a) || []), h]);
        }
        for (const [author, items] of byAuthor) {
          const reassigned = items.some((i) => i.field === 'RESPONSIBLE_ID');
          addAlert({
            key: `change:${id}:${items[items.length - 1].id}`,
            type: reassigned ? 'assigned' : 'change',
            taskId: id,
            employeeId: empId,
            title: `${reassigned ? 'Смена ответственного' : 'Изменения'}: ${t.title}`,
            message: describeChanges(items),
            author,
          });
        }
      } else if (prev.activity_date !== t.activityDate && prev.changed_date === t.changedDate && t.activityDate) {
        // Активность без изменений полей — сообщение/комментарий в чате задачи
        addAlert({ key: `comment:${id}:${t.activityDate}`, type: 'comment', taskId: id, employeeId: empId, title: `Новый комментарий: ${t.title}`, message: 'В чате задачи появилось новое сообщение' });
      }
    }
  });
  return changed.map((t) => Number(t.id));
}

async function fetchScope(extra: Record<string, unknown>[]): Promise<B24Task[]> {
  const ids = empIds();
  const scopes: Record<string, unknown>[] = [];
  if (GROUP_ID) scopes.push({ GROUP_ID });
  if (ids.length) scopes.push({ RESPONSIBLE_ID: ids });
  const byId = new Map<string, B24Task>();
  for (const s of scopes) for (const e of extra) for (const t of await listTasks({ ...s, ...e })) byId.set(t.id, t);
  return [...byId.values()];
}

/** Полная сверка: открытые задачи + закрытые за 30 дней, удаление выпавших из области */
async function fullSync(alerts: boolean) {
  const since = b24Date(new Date(Date.now() - 30 * 86400e3));
  const tasks = await fetchScope([{ '!STATUS': 5 }, { STATUS: 5, '>CLOSED_DATE': since }]);
  const seen = new Set(tasks.map((t) => Number(t.id)));
  const updated = await processTasks(tasks, { alerts });

  // Открытые задачи в БД, которых нет в выборке: закрыты давно, удалены или ушли из области
  const missing = q.all<{ id: number }>('SELECT id FROM tasks WHERE status != 5').map((r) => r.id).filter((id) => !seen.has(id));
  if (missing.length) {
    const cmds: Record<string, [string, Record<string, unknown>]> = {};
    for (const id of missing) cmds[`t${id}`] = ['tasks.task.get', { taskId: id, select: TASK_SELECT }];
    const { result } = await batch(cmds);
    const alive: B24Task[] = [];
    for (const id of missing) {
      const t = result[`t${id}`]?.task as B24Task | undefined;
      const inScope = t && (Number(t.groupId) === GROUP_ID || empIds().includes(Number(t.responsibleId)));
      if (t && inScope) alive.push(t);
      else {
        q.run('DELETE FROM tasks WHERE id = ?', id);
        q.run('DELETE FROM queue WHERE task_id = ?', id);
      }
    }
    updated.push(...(await processTasks(alive, { alerts })));
  }
  await syncStages();
  syncState.lastFullAt = Date.now();
  return updated;
}

async function incrementalSync() {
  const last = getMeta('lastSync');
  const since = b24Date(new Date(new Date(last!).getTime() - 120e3));
  const tasks = await fetchScope([{ '>CHANGED_DATE': since }, { '>ACTIVITY_DATE': since }]);
  return processTasks(tasks, { alerts: true });
}

export async function runSync(opts: { full?: boolean } = {}) {
  if (syncState.running) return;
  syncState.running = true;
  const startedAt = new Date().toISOString();
  try {
    if (!syncState.selfUserId) {
      const me = await callResult<{ ID: string }>('profile').catch(() => null);
      syncState.selfUserId = Number(me?.ID || 0);
    }
    const initialized = !!getMeta('lastSync');
    const needFull = opts.full || !initialized || Date.now() - syncState.lastFullAt > 10 * 60e3;
    const ids = needFull ? await fullSync(initialized) : await incrementalSync();
    setMeta('lastSync', startedAt);
    runRules();
    syncState.lastSyncAt = startedAt;
    syncState.lastError = null;
    if (ids.length) emit({ type: 'tasks', ids });
  } catch (e: any) {
    syncState.lastError = e instanceof BitrixError ? `${e.code}: ${e.message}` : String(e?.message || e);
    console.error('[sync]', syncState.lastError);
  } finally {
    syncState.running = false;
    emit({ type: 'sync', status: publicSyncState() });
  }
}

export const publicSyncState = () => ({
  running: syncState.running,
  lastSyncAt: syncState.lastSyncAt,
  lastError: syncState.lastError,
});

/** Перечитать одну задачу после записи в Б24 (без алертов о собственных действиях) */
export async function refreshTask(id: number) {
  const r = await callResult<{ task: B24Task }>('tasks.task.get', { taskId: id, select: TASK_SELECT });
  // Сбрасываем даты, чтобы processTasks точно перечитал историю и зависимости
  q.run("UPDATE tasks SET changed_date = '' WHERE id = ?", id);
  await processTasks([r.task], { alerts: false });
  emit({ type: 'tasks', ids: [id] });
  return q.get('SELECT * FROM tasks WHERE id = ?', id);
}

let timer: NodeJS.Timeout | null = null;
export function startSyncLoop() {
  const tick = async () => {
    await runSync();
    timer = setTimeout(tick, getSettings().syncIntervalSec * 1000);
  };
  void tick();
}
export function stopSyncLoop() {
  if (timer) clearTimeout(timer);
}
