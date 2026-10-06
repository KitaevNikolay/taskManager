// Область работы пользователя: его отделы (группы Б24) и сотрудники.
// Задача входит в область, если она в группе одного из отделов или её ответственный — сотрудник пользователя.
import { q } from './db.ts';

export class ScopeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Department { id: number; user_id: number; group_id: number; title: string; color: string; sort_order: number }

export const userGroups = (userId: number) =>
  q.all<{ group_id: number }>('SELECT group_id FROM departments WHERE user_id = ? ORDER BY sort_order, id', userId).map((r) => r.group_id);

export const userEmpIds = (userId: number) =>
  q.all<{ id: number }>('SELECT id FROM employees WHERE user_id = ?', userId).map((r) => r.id);

export const userDepartments = (userId: number) =>
  q.all<Department>('SELECT * FROM departments WHERE user_id = ? ORDER BY sort_order, id', userId);

/** Все пользователи приложения (для рассылки алертов и правил) */
export const allUserIds = () => q.all<{ id: number }>('SELECT id FROM users ORDER BY id').map((r) => r.id);

/** Объединение областей всех пользователей — что нужно синхронизировать с Б24.
 *  Включая «ничьи» данные (user_id = 0), которые ждут первого пользователя. */
export const allGroups = () =>
  q.all<{ g: number }>('SELECT DISTINCT group_id AS g FROM departments').map((r) => r.g);
export const allEmpIds = () =>
  q.all<{ id: number }>('SELECT DISTINCT id FROM employees').map((r) => r.id);

/** SQL-условие «задача в области пользователя» (параметр — userId, дважды) */
export const SCOPE_SQL = (alias = 't') =>
  `(${alias}.group_id IN (SELECT group_id FROM departments WHERE user_id = ?) OR ${alias}.responsible_id IN (SELECT id FROM employees WHERE user_id = ?))`;

/** Пользователи, в чью область входит задача */
export function usersForTask(t: { group_id?: number | null; responsible_id?: number | null }) {
  return q.all<{ user_id: number }>(
    `SELECT user_id FROM departments WHERE group_id = ? AND user_id > 0
     UNION SELECT user_id FROM employees WHERE id = ? AND user_id > 0`,
    t.group_id ?? -1, t.responsible_id ?? -1,
  ).map((r) => r.user_id);
}

export function taskInScope(userId: number, taskId: number) {
  return !!q.get(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${SCOPE_SQL()}`, taskId, userId, userId);
}

/** Действовать с задачей в Б24 можно только в своей области */
export function assertTaskAccess(userId: number, taskId: number) {
  if (!q.get('SELECT 1 FROM tasks WHERE id = ?', taskId)) throw new ScopeError(404, 'Задача не найдена');
  if (!taskInScope(userId, taskId)) throw new ScopeError(403, 'Задача вне вашей области: её нет в ваших отделах и у ваших сотрудников');
}

export function assertEmployee(userId: number, empId: number) {
  if (!q.get('SELECT 1 FROM employees WHERE user_id = ? AND id = ?', userId, empId)) throw new ScopeError(404, 'Сотрудник не найден в вашем списке');
}

export function assertDepartmentGroup(userId: number, groupId: number) {
  if (!q.get('SELECT 1 FROM departments WHERE user_id = ? AND group_id = ?', userId, groupId)) throw new ScopeError(404, 'Отдел не найден');
}

// ---------- Роли стадий ----------
// «В работе» и «на паузе» определяем по названию стадии в любой группе: «Выполняются», «В работе», «На паузе».
const WORK_RE = /выполня|в работе/i;
const PAUSE_RE = /пауз/i;

export function stageRoles() {
  const st = q.all<{ id: number; entity_id: number; title: string }>('SELECT id, entity_id, title FROM stages');
  const work = st.filter((s) => WORK_RE.test(s.title));
  const pause = st.filter((s) => PAUSE_RE.test(s.title));
  return {
    workStageIds: work.map((s) => s.id),
    pauseStageIds: pause.map((s) => s.id),
    /** Группы, где «в работе» задаётся стадией (у остальных — статусом «Выполняется») */
    groupsWithWork: [...new Set(work.map((s) => s.entity_id))],
    workByGroup: Object.fromEntries(work.map((s) => [s.entity_id, s.id])) as Record<number, number>,
  };
}

/** SQL «задача в работе»: стадия «в работе» в своей группе, иначе статус 3 */
export function inWorkSql(alias = 't') {
  const r = stageRoles();
  if (!r.workStageIds.length) return `${alias}.status = 3`;
  return `(${alias}.stage_id IN (${r.workStageIds.join(',')}) OR (COALESCE(${alias}.group_id, 0) NOT IN (${r.groupsWithWork.join(',')}) AND ${alias}.status = 3))`;
}

export function taskState(t: { group_id: number | null; stage_id: number | null; status: number }, roles = stageRoles()) {
  const byStage = t.group_id != null && roles.groupsWithWork.includes(t.group_id);
  return {
    working: byStage ? roles.workStageIds.includes(t.stage_id ?? -1) : t.status === 3,
    paused: byStage ? roles.pauseStageIds.includes(t.stage_id ?? -1) : t.status === 6,
  };
}
