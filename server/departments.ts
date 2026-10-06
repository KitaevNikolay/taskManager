// Отделы пользователя: группы Б24, по стадиям которых строится канбан. Добавляются из личного кабинета.
import { Router } from 'express';
import { q } from './db.ts';
import { call, callResult, BitrixError } from './bitrix.ts';
import { runSync, syncStages } from './sync.ts';
import { ScopeError } from './scope.ts';

export const departmentsApi = Router();
const uid = (req: any) => req.user.id as number;

export const DEPARTMENT_COLORS = ['#2f6fed', '#2e9d4f', '#d9822b', '#8a5cd6', '#d33a3a', '#0e9aa7', '#c2185b', '#7a8794'];

/** Группа Б24 по ID: название (из задач группы — sonet_group недоступен без скоупа) и стадии канбана */
async function lookupGroup(groupId: number) {
  let name: string | null = null;
  try {
    const g = await callResult<any[]>('sonet_group.get', { FILTER: { ID: groupId } });
    name = g?.[0]?.NAME ?? null;
  } catch (e) {
    if (!(e instanceof BitrixError)) throw e;
  }
  if (!name) {
    const r = await call<any>('tasks.task.list', { filter: { GROUP_ID: groupId }, select: ['ID', 'GROUP_ID'], start: -1 });
    const g = r.result?.tasks?.[0]?.group;
    name = g && !Array.isArray(g) ? g.name : null;
  }
  let stages: { id: number; title: string; color: string }[] = [];
  try {
    const st = await callResult<Record<string, any>>('task.stages.get', { entityId: groupId });
    stages = Object.values(st || {}).sort((a: any, b: any) => Number(a.SORT) - Number(b.SORT)).map((s: any) => ({ id: Number(s.ID), title: s.TITLE, color: s.COLOR }));
  } catch (e) {
    if (!(e instanceof BitrixError)) throw e;
  }
  return { id: groupId, name, stages };
}

const withStats = (userId: number) =>
  q.all<any>(
    `SELECT d.*,
       (SELECT COUNT(*) FROM tasks t WHERE t.group_id = d.group_id AND t.status NOT IN (5,7)) AS open_count,
       (SELECT COUNT(*) FROM stages s WHERE s.entity_id = d.group_id) AS stages_count
     FROM departments d WHERE d.user_id = ? ORDER BY d.sort_order, d.id`, userId,
  );

departmentsApi.get('/departments', (req, res) => res.json(withStats(uid(req))));

/** Проверка группы перед добавлением */
departmentsApi.get('/bitrix/group/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ScopeError(400, 'Некорректный ID группы');
  const g = await lookupGroup(id);
  if (!g.name && !g.stages.length) throw new ScopeError(404, 'Группа не найдена: в ней нет задач и стадий канбана, либо у вебхука нет к ней доступа');
  res.json(g);
});

/** Группы, которые уже встречаются в задачах — подсказки для добавления */
departmentsApi.get('/departments/suggestions', (req, res) => {
  res.json(q.all(
    `SELECT group_id, MAX(group_name) AS name, COUNT(*) AS tasks FROM tasks
     WHERE group_id > 0 AND group_id NOT IN (SELECT group_id FROM departments WHERE user_id = ?)
     GROUP BY group_id ORDER BY tasks DESC LIMIT 30`, uid(req),
  ));
});

departmentsApi.post('/departments', async (req, res) => {
  const groupId = Number(req.body?.group_id);
  if (!Number.isInteger(groupId) || groupId <= 0) throw new ScopeError(400, 'Укажите ID группы Битрикс24');
  if (q.get('SELECT 1 FROM departments WHERE user_id = ? AND group_id = ?', uid(req), groupId)) throw new ScopeError(409, 'Этот отдел уже добавлен');
  const g = await lookupGroup(groupId);
  if (!g.name && !g.stages.length) throw new ScopeError(404, 'Группа не найдена или у вебхука нет к ней доступа');
  const count = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM departments WHERE user_id = ?', uid(req))!.n;
  const title = String(req.body?.title || '').trim() || g.name || `Группа ${groupId}`;
  const color = /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : DEPARTMENT_COLORS[count % DEPARTMENT_COLORS.length];
  const r = q.run('INSERT INTO departments(user_id, group_id, title, color, sort_order) VALUES(?,?,?,?,?)', uid(req), groupId, title.slice(0, 80), color, count + 1);
  await syncStages([groupId]).catch(() => null);
  res.json(q.get('SELECT * FROM departments WHERE id = ?', Number(r.lastInsertRowid)));
  void runSync({ full: true }); // подтянуть задачи нового отдела
});

departmentsApi.put('/departments/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.get('SELECT 1 FROM departments WHERE id = ? AND user_id = ?', id, uid(req))) throw new ScopeError(404, 'Отдел не найден');
  const title = String(req.body?.title || '').trim();
  if (!title) throw new ScopeError(400, 'Укажите название');
  const color = /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : null;
  q.run('UPDATE departments SET title = ?, color = COALESCE(?, color) WHERE id = ?', title.slice(0, 80), color, id);
  res.json(q.get('SELECT * FROM departments WHERE id = ?', id));
});

departmentsApi.delete('/departments/:id', (req, res) => {
  q.run('DELETE FROM departments WHERE id = ? AND user_id = ?', Number(req.params.id), uid(req));
  res.json({ ok: true });
});

departmentsApi.put('/departments-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE departments SET sort_order = ? WHERE id = ? AND user_id = ?', i + 1, id, uid(req))));
  res.json({ ok: true });
});
