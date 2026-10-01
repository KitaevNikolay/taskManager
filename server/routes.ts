import { Router, type Request, type Response } from 'express';
import { q, getSettings, saveSettings } from './db.ts';
import { call, callResult, BitrixError, GROUP_ID, PORTAL_URL } from './bitrix.ts';
import { runSync, refreshTask, publicSyncState, syncState, STATUS_NAMES } from './sync.ts';
import { runRules } from './alerts.ts';
import { bus } from './bus.ts';
import { absencesApi, absenceInfo, dayoffStats } from './absences.ts';
import { notifyApi } from './notify.ts';
import { notesApi } from './notes.ts';
import { absentDays, addWorkdays, nextWorkday, todayYmd, workdaysBetween } from './calendar.ts';

export const api = Router();
api.use(absencesApi);
api.use(notifyApi);
api.use(notesApi);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const int = (v: unknown, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Некорректный ${name}`);
  return n;
};

// ---------- Стадии ----------
/** Стадии, по которым определяем «в работе» и «на паузе» для задач группы отдела */
function specialStages() {
  const st = q.all<{ id: number; title: string }>('SELECT id, title FROM stages WHERE entity_id = ? ORDER BY sort', GROUP_ID);
  return {
    work: st.find((x) => /выполня|в работе/i.test(x.title))?.id ?? null,
    pause: st.find((x) => /пауз/i.test(x.title))?.id ?? null,
  };
}
/** SQL-условие «задача в работе»: для группы — стадия, для остальных — статус */
const inWorkSql = () => {
  const { work } = specialStages();
  return work ? `((t.group_id = ${GROUP_ID} AND t.stage_id = ${work}) OR (COALESCE(t.group_id, 0) != ${GROUP_ID} AND t.status = 3))` : 't.status = 3';
};

// ---------- Мета ----------
api.get('/meta', (_req, res) => {
  const { work, pause } = specialStages();
  res.json({
    portalUrl: PORTAL_URL,
    groupId: GROUP_ID,
    selfUserId: syncState.selfUserId,
    stages: q.all('SELECT * FROM stages WHERE entity_id = ? ORDER BY sort', GROUP_ID),
    allStages: q.all('SELECT * FROM stages ORDER BY entity_id, sort'),
    workStageId: work,
    pauseStageId: pause,
    statusNames: STATUS_NAMES,
    sync: publicSyncState(),
  });
});

// ---------- Сотрудники ----------
api.get('/employees', (_req, res) => {
  const now = new Date().toISOString();
  res.json(
    q.all<any>(
      `SELECT e.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = e.id AND t.status NOT IN (5,7)) AS open_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = e.id AND t.status NOT IN (5,7) AND t.deadline IS NOT NULL AND t.deadline < ?) AS overdue_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = e.id AND t.status NOT IN (5,7) AND ${inWorkSql()}) AS in_progress_count
       FROM employees e ORDER BY e.sort_order, e.name`,
      now,
    ).map((e) => ({ ...e, dayoff: dayoffStats(e.id), ...absenceInfo(e.id) })),
  );
});

api.post('/employees', async (req, res) => {
  const b = req.body || {};
  const id = int(b.id, 'ID сотрудника');
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Укажите ФИО');
  if (q.get('SELECT id FROM employees WHERE id = ?', id)) throw new HttpError(409, 'Сотрудник с таким ID уже добавлен');
  const last = q.get<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM employees')!.m;
  q.run('INSERT INTO employees(id, name, department, email, position, photo, is_buffer, sort_order, dayoff_granted) VALUES(?,?,?,?,?,?,?,?,?)', id, b.name.trim(), b.department, b.email, b.position, b.photo, !!b.is_buffer, last + 1, Number(b.dayoff_granted) || 0);
  res.json(q.get('SELECT * FROM employees WHERE id = ?', id));
  void runSync({ full: true }); // подтянуть задачи нового сотрудника
});

api.put('/employees/:id', (req, res) => {
  const id = int(req.params.id);
  const b = req.body || {};
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Укажите ФИО');
  q.run('UPDATE employees SET name=?, department=?, email=?, position=?, photo=COALESCE(?, photo), is_buffer=?, dayoff_granted=COALESCE(?, dayoff_granted) WHERE id=?',
    b.name.trim(), b.department, b.email, b.position, b.photo, !!b.is_buffer, b.dayoff_granted === undefined || b.dayoff_granted === '' ? null : Number(b.dayoff_granted) || 0, id);
  res.json(q.get('SELECT * FROM employees WHERE id = ?', id));
});

/** Выдать/списать дни отгула (delta может быть отрицательной) */
api.post('/employees/:id/dayoffs', (req, res) => {
  const id = int(req.params.id);
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta) || delta === 0) throw new HttpError(400, 'Укажите количество дней');
  q.run('UPDATE employees SET dayoff_granted = dayoff_granted + ? WHERE id = ?', delta, id);
  res.json(dayoffStats(id));
});

/** Порядок сотрудников на экране */
api.put('/employees-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE employees SET sort_order = ? WHERE id = ?', i + 1, id)));
  res.json({ ok: true });
});

api.delete('/employees/:id', (req, res) => {
  const id = int(req.params.id);
  q.run('DELETE FROM employees WHERE id = ?', id);
  q.run('DELETE FROM queue WHERE employee_id = ?', id);
  res.json({ ok: true });
});

/** Данные сотрудника из Б24. user.get требует скоуп user; без него — ФИО и должность из задач. */
api.get('/bitrix/user/:id', async (req, res) => {
  const id = int(req.params.id);
  try {
    const [u] = await callResult<any[]>('user.get', { ID: id });
    if (!u) throw new HttpError(404, 'Пользователь не найден в Битрикс24');
    let department: string | null = null;
    const depId = Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT[0] : null;
    if (depId) {
      const deps = await callResult<any[]>('department.get', { ID: depId }).catch(() => []);
      department = deps[0]?.NAME ?? null;
    }
    res.json({
      id,
      name: [u.LAST_NAME, u.NAME, u.SECOND_NAME].filter(Boolean).join(' '),
      email: u.EMAIL || null,
      position: u.WORK_POSITION || null,
      department,
      photo: u.PERSONAL_PHOTO || null,
      source: 'user',
      missing: department ? [] : ['department'],
    });
  } catch (e) {
    if (!(e instanceof BitrixError) || e.code !== 'insufficient_scope') throw e;
    // Фолбэк: ищем любую задачу, где пользователь ответственный
    const r = await call<any>('tasks.task.list', { filter: { RESPONSIBLE_ID: id }, select: ['ID', 'RESPONSIBLE_ID'], start: -1 });
    const resp = r.result?.tasks?.[0]?.responsible;
    let name = resp?.name;
    let position = resp?.workPosition || null;
    const photo = resp?.icon ? PORTAL_URL + resp.icon : null;
    if (!name) {
      const r2 = await call<any>('tasks.task.list', { filter: { CREATED_BY: id }, select: ['ID', 'CREATED_BY'], start: -1 });
      name = r2.result?.tasks?.[0]?.creator?.name;
    }
    if (!name) throw new HttpError(404, 'Не удалось найти пользователя: у вебхука нет скоупа user, а задач с этим сотрудником нет');
    res.json({
      id, name, position, photo, email: null, department: null, source: 'tasks',
      missing: ['email', 'department'],
      hint: 'У вебхука нет скоупов user и department — почта и отдел недоступны. Добавьте скоупы в настройках вебхука.',
    });
  }
});

// ---------- Задачи ----------
const TASK_COLS = `t.*,
  (SELECT COUNT(*) FROM alerts a WHERE a.task_id = t.id AND a.read_at IS NULL) AS unread_alerts,
  (SELECT position FROM queue qu WHERE qu.task_id = t.id AND qu.employee_id = t.responsible_id) AS queue_pos,
  (SELECT 1 FROM employees e WHERE e.id = t.responsible_id) AS is_employee,
  (SELECT mode FROM task_notify n WHERE n.task_id = t.id) AS notify`;

function parseTask(t: any) {
  if (!t) return t;
  return { ...t, depends_on: JSON.parse(t.depends_on || '[]'), tags: JSON.parse(t.tags || '[]'), is_employee: !!t.is_employee };
}

api.get('/tasks', (req, res) => {
  const s = getSettings();
  const doneSince = new Date(Date.now() - s.doneVisibleDays * 86400e3).toISOString();
  const scope = String(req.query.scope || 'group');
  const closedCond = `(t.status NOT IN (5,7) OR t.closed_date >= ?)`;
  let rows: any[];
  if (scope === 'employee') {
    rows = q.all(`SELECT ${TASK_COLS} FROM tasks t WHERE t.responsible_id = ? AND ${closedCond}`, int(req.query.employeeId, 'employeeId'), doneSince);
  } else if (scope === 'all') {
    rows = q.all(`SELECT ${TASK_COLS} FROM tasks t WHERE (t.group_id = ? OR t.responsible_id IN (SELECT id FROM employees)) AND ${closedCond}`, GROUP_ID, doneSince);
  } else {
    rows = q.all(`SELECT ${TASK_COLS} FROM tasks t WHERE t.group_id = ? AND ${closedCond}`, GROUP_ID, doneSince);
  }
  res.json(rows.map(parseTask));
});

api.get('/tasks/:id', async (req, res) => {
  const id = int(req.params.id);
  let live: any = null;
  try {
    live = (await callResult<any>('tasks.task.get', { taskId: id, select: ['ID', 'DESCRIPTION', 'TAGS', 'ACCOMPLICES', 'AUDITORS'] })).task;
  } catch (e) {
    if (!(e instanceof BitrixError)) throw e;
  }
  const task = parseTask(q.get(`SELECT ${TASK_COLS} FROM tasks t WHERE t.id = ?`, id));
  if (!task) throw new HttpError(404, 'Задача не найдена в локальной базе');
  const deps = q.all('SELECT id, title, status, start_date_plan, end_date_plan, deadline FROM tasks WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(task.depends_on));
  const successors = q.all("SELECT id, title, status FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.depends_on) WHERE value = ?)", id);
  const alerts = q.all('SELECT * FROM alerts WHERE task_id = ? ORDER BY id DESC LIMIT 30', id);
  res.json({ ...task, description: live?.description ?? null, accomplicesData: live?.accomplicesData, auditorsData: live?.auditorsData, tags: live?.tags, predecessors: deps, successors, alerts, url: taskUrl(task) });
});

const taskUrl = (t: any) => `${PORTAL_URL}/company/personal/user/${t.responsible_id || 0}/tasks/task/view/${t.id}/`;

async function done(res: Response, id: number) {
  q.run('UPDATE alerts SET read_at = ? WHERE task_id = ? AND read_at IS NULL AND type IN (?, ?)', new Date().toISOString(), id, 'overdue', 'deadline_soon');
  const t = await refreshTask(id);
  runRules();
  res.json(parseTask(q.get(`SELECT ${TASK_COLS} FROM tasks t WHERE t.id = ?`, (t as any).id)));
}

api.post('/tasks/:id/stage', async (req, res) => {
  const id = int(req.params.id);
  const stageId = int(req.body?.stageId, 'stageId');
  await callResult('task.stages.movetask', { id, stageId });
  await done(res, id);
});

api.post('/tasks/:id/responsible', async (req, res) => {
  const id = int(req.params.id);
  const responsibleId = int(req.body?.responsibleId, 'responsibleId');
  await callResult('tasks.task.update', { taskId: id, fields: { RESPONSIBLE_ID: responsibleId } });
  await done(res, id);
});

const STATUS_ACTIONS: Record<string, string> = {
  start: 'tasks.task.start', pause: 'tasks.task.pause', defer: 'tasks.task.defer', complete: 'tasks.task.complete',
  renew: 'tasks.task.renew', approve: 'tasks.task.approve', disapprove: 'tasks.task.disapprove',
};
api.post('/tasks/:id/status', async (req, res) => {
  const id = int(req.params.id);
  const method = STATUS_ACTIONS[String(req.body?.action)];
  if (!method) throw new HttpError(400, 'Неизвестное действие');
  await callResult(method, { taskId: id });
  await done(res, id);
});

/** Дата из UI: 'YYYY-MM-DD' -> начало/конец рабочего дня по Москве; ISO пропускаем как есть; '' — очистить */
function toB24(v: unknown, kind: 'start' | 'end'): string | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${kind === 'start' ? '09:00:00' : '18:00:00'}+03:00`;
  if (isNaN(Date.parse(s))) throw new HttpError(400, `Некорректная дата: ${s}`);
  return s;
}

api.patch('/tasks/:id/dates', async (req, res) => {
  const id = int(req.params.id);
  const b = req.body || {};
  const fields: Record<string, string> = {};
  const dl = toB24(b.deadline, 'end');
  const st = toB24(b.startDatePlan, 'start');
  const en = toB24(b.endDatePlan, 'end');
  if (dl !== undefined) fields.DEADLINE = dl;
  if (st !== undefined) fields.START_DATE_PLAN = st;
  if (en !== undefined) fields.END_DATE_PLAN = en;
  if (!Object.keys(fields).length) throw new HttpError(400, 'Нет полей для обновления');
  await callResult('tasks.task.update', { taskId: id, fields });
  await done(res, id);
});

// ---------- Связи задач ----------
// Используем «Предыдущие задачи» Б24 (поле DEPENDS_ON): их видно в карточке задачи, они пишутся в историю
// и читаются через task.item.getdependson. Связи диаграммы Ганта Б24 (task.dependence.add) через REST
// прочитать нельзя — поэтому их не используем.

const readPredecessors = async (id: number) =>
  ((await callResult<string[]>('task.item.getdependson', { TASKID: id })) || []).map(Number);

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Записать список предшественников и убедиться, что Б24 его сохранил */
async function writePredecessors(id: number, ids: number[]) {
  const value = ids.length ? ids : '';
  const attempts: [string, Record<string, unknown>][] = [
    ['tasks.task.update', { taskId: id, fields: { DEPENDS_ON: value } }],
    ['task.item.update', { TASKID: id, TASKDATA: { DEPENDS_ON: value } }], // старый метод — на случай, если новый поле проигнорирует
  ];
  for (const [method, params] of attempts) {
    await callResult(method, params);
    if (sameSet(await readPredecessors(id), ids)) return;
  }
  throw new HttpError(502, 'Битрикс24 не сохранил связь задач — проверьте права вебхука на задачу');
}

/** Не даём создать цикл: pred не должна (транзитивно) зависеть от id */
function createsCycle(id: number, pred: number) {
  const seen = new Set<number>();
  const stack = [pred];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = q.get<{ depends_on: string }>('SELECT depends_on FROM tasks WHERE id = ?', cur);
    stack.push(...(JSON.parse(row?.depends_on || '[]') as number[]));
  }
  return false;
}

async function addPredecessor(id: number, pred: number) {
  if (pred === id) throw new HttpError(400, 'Задача не может зависеть от самой себя');
  if (createsCycle(id, pred)) throw new HttpError(400, `Получится цикл: #${pred} уже зависит от #${id}`);
  const cur = await readPredecessors(id);
  if (cur.includes(pred)) return;
  await writePredecessors(id, [...cur, pred]);
}

// Связь «окончание → начало»: задача id начинается после pred
api.post('/tasks/:id/deps', async (req, res) => {
  const id = int(req.params.id);
  const pred = int(req.body?.predecessorId, 'predecessorId');
  await addPredecessor(id, pred);
  await refreshTask(pred).catch(() => null);
  await done(res, id);
});

api.delete('/tasks/:id/deps/:pred', async (req, res) => {
  const id = int(req.params.id);
  const pred = int(req.params.pred, 'predecessorId');
  const cur = await readPredecessors(id);
  if (cur.includes(pred)) await writePredecessors(id, cur.filter((x) => x !== pred));
  await refreshTask(pred).catch(() => null);
  await done(res, id);
});

// ---------- Очереди ----------
function queueFor(empId: number) {
  const rows = q.all<any>(
    `SELECT ${TASK_COLS} FROM tasks t WHERE t.responsible_id = ? AND t.status NOT IN (5,7)`, empId,
  ).map(parseTask);
  // Сначала по позиции в очереди; новые задачи — в конец: в работе, затем по дедлайну, на паузе/отложенные — последними
  const { work, pause } = specialStages();
  const isGroup = (t: any) => t.group_id === GROUP_ID;
  const rank = (t: any) => {
    if (isGroup(t) && work) return t.stage_id === work ? 0 : t.stage_id === pause ? 2 : 1;
    return t.status === 3 ? 0 : t.status === 6 ? 2 : 1;
  };
  return rows.sort((a, b) => {
    if (a.queue_pos != null && b.queue_pos != null) return a.queue_pos - b.queue_pos;
    if (a.queue_pos != null) return -1;
    if (b.queue_pos != null) return 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.deadline || '9999').localeCompare(b.deadline || '9999');
  });
}

api.get('/queues', (_req, res) => {
  const emps = q.all<any>('SELECT * FROM employees ORDER BY sort_order, name');
  res.json(emps.map((e) => ({ employee: e, tasks: queueFor(e.id) })));
});

api.put('/queues/:empId', (req, res) => {
  const empId = int(req.params.empId);
  const ids: number[] = (req.body?.taskIds || []).map(Number);
  q.tx(() => {
    q.run('DELETE FROM queue WHERE employee_id = ?', empId);
    ids.forEach((tid, i) => q.run('INSERT INTO queue(employee_id, task_id, position) VALUES(?,?,?)', empId, tid, i));
  });
  res.json(queueFor(empId));
});

// --- Построение цепочки (Гант) по очереди: рабочие дни, без выходных и отсутствий сотрудника ---
api.post('/queues/:empId/plan', async (req, res) => {
  const empId = int(req.params.empId);
  const s = getSettings();
  const startStr = String(req.body?.startDate || todayYmd());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) throw new HttpError(400, 'Некорректная дата начала');
  const include: number[] | undefined = req.body?.taskIds?.map(Number);
  const { pause } = specialStages();
  let tasks = queueFor(empId).filter((t) => t.status !== 6 && t.status !== 4 && !(t.group_id === GROUP_ID && pause && t.stage_id === pause));
  if (include) tasks = tasks.filter((t) => include.includes(t.id));

  const skip = absentDays(empId);
  let cursor = nextWorkday(startStr, skip);
  const plan = tasks.map((t) => {
    const dur = t.time_estimate > 0
      ? Math.ceil(t.time_estimate / 3600 / s.workdayHours)
      : t.start_date_plan && t.end_date_plan
        ? workdaysBetween(t.start_date_plan, t.end_date_plan)
        : s.defaultTaskDays;
    const start = cursor;
    const end = addWorkdays(start, Math.max(1, dur) - 1, skip);
    cursor = addWorkdays(end, 1, skip);
    const endIso = `${end}T18:00:00+03:00`;
    return {
      taskId: t.id, title: t.title, days: dur, start, end, deadline: t.deadline,
      conflict: !!t.deadline && new Date(endIso) > new Date(t.deadline),
    };
  });

  if (!req.body?.apply) return res.json({ plan });

  const errors: string[] = [];
  for (const p of plan) {
    try {
      await callResult('tasks.task.update', { taskId: p.taskId, fields: { START_DATE_PLAN: `${p.start}T09:00:00+03:00`, END_DATE_PLAN: `${p.end}T18:00:00+03:00` } });
    } catch (e: any) {
      errors.push(`#${p.taskId}: ${e.message}`);
    }
  }
  if (req.body?.link) {
    for (let i = 1; i < plan.length; i++) {
      try {
        await addPredecessor(plan[i].taskId, plan[i - 1].taskId);
      } catch (e: any) {
        errors.push(`Связь #${plan[i - 1].taskId}→#${plan[i].taskId}: ${e.message}`);
      }
    }
  }
  for (const p of plan) await refreshTask(p.taskId).catch(() => null);
  runRules();
  res.json({ plan, errors, applied: true });
});

// ---------- Алерты ----------
api.get('/alerts', (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.unread === '1') where.push('a.read_at IS NULL');
  if (req.query.type) {
    const types = String(req.query.type).split(',');
    where.push(`a.type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (req.query.employeeId) { where.push('a.employee_id = ?'); params.push(Number(req.query.employeeId)); }
  if (req.query.taskId) { where.push('a.task_id = ?'); params.push(Number(req.query.taskId)); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(q.all(
    `SELECT a.*, t.title AS task_title, t.responsible_name, t.status AS task_status, e.name AS employee_name
     FROM alerts a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN employees e ON e.id = a.employee_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${limit}`,
    ...params,
  ));
});

api.get('/alerts/count', (_req, res) => {
  res.json({
    unread: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM alerts WHERE read_at IS NULL')!.n,
    byType: q.all('SELECT type, COUNT(*) AS n FROM alerts WHERE read_at IS NULL GROUP BY type'),
  });
});

api.post('/alerts/read', (req, res) => {
  const now = new Date().toISOString();
  const ids: number[] | undefined = req.body?.ids;
  if (ids?.length) q.run(`UPDATE alerts SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now, ...ids.map(Number));
  else if (req.body?.taskId) q.run('UPDATE alerts SET read_at = ? WHERE task_id = ? AND read_at IS NULL', now, Number(req.body.taskId));
  else if (req.body?.all) q.run('UPDATE alerts SET read_at = ? WHERE read_at IS NULL', now);
  res.json({ ok: true });
});

// ---------- Настройки и синхронизация ----------
api.get('/settings', (_req, res) => res.json(getSettings()));
api.put('/settings', (req, res) => {
  saveSettings(req.body || {});
  runRules();
  res.json(getSettings());
});
api.post('/sync', async (req, res) => {
  await runSync({ full: !!req.body?.full });
  res.json(publicSyncState());
});

// ---------- SSE ----------
api.get('/events', (req: Request, res: Response) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
});

export { HttpError };
