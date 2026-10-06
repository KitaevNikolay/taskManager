import { Router } from 'express';
import { q } from './db.ts';
import { callResult } from './bitrix.ts';
import { refreshTask } from './sync.ts';
import { runRulesFor } from './alerts.ts';
import { emit } from './bus.ts';
import {
  ABSENCE_NAMES, absencesOf, absentDays, addDays, daysIn, isYmd, mskIso, mskParts, nextWorkday, todayYmd, type Absence,
} from './calendar.ts';

export const absencesApi = Router();

class BadRequest extends Error {
  status = 400;
}

const TYPES = Object.keys(ABSENCE_NAMES);
const uid = (req: any) => req.user.id as number;

/** Отгулы: выдано / использовано (календарные дни отгулов, границы включены) / остаток — может быть отрицательным */
export function dayoffStats(userId: number, empId: number) {
  const granted = q.get<{ g: number }>('SELECT dayoff_granted AS g FROM employees WHERE user_id = ? AND id = ?', userId, empId)?.g ?? 0;
  const used = q
    .all<Absence>("SELECT * FROM absences WHERE user_id = ? AND employee_id = ? AND type = 'dayoff'", userId, empId)
    .reduce((n, a) => n + daysIn(a.date_from, a.date_to).length, 0);
  return { granted, used, left: granted - used };
}

/** Текущее и ближайшее (в пределах 30 дней) отсутствие сотрудника */
export function absenceInfo(userId: number, empId: number) {
  const today = todayYmd();
  const now = q.get<Absence>('SELECT * FROM absences WHERE user_id = ? AND employee_id = ? AND date_from <= ? AND date_to >= ? ORDER BY date_from LIMIT 1', userId, empId, today, today) || null;
  const horizon = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  const next = now ? null : q.get<Absence>('SELECT * FROM absences WHERE user_id = ? AND employee_id = ? AND date_from > ? AND date_from <= ? ORDER BY date_from LIMIT 1', userId, empId, today, horizon) || null;
  return { absence_now: now, absence_next: next };
}

function validate(userId: number, b: any, id?: number): Omit<Absence, 'id'> {
  const employee_id = Number(b.employee_id);
  if (!q.get('SELECT id FROM employees WHERE user_id = ? AND id = ?', userId, employee_id)) throw new BadRequest('Сотрудник не найден');
  if (!TYPES.includes(b.type)) throw new BadRequest('Неизвестный тип отсутствия');
  if (!isYmd(b.date_from) || !isYmd(b.date_to)) throw new BadRequest('Укажите даты начала и окончания');
  if (b.date_to < b.date_from) throw new BadRequest('Дата окончания раньше даты начала');
  const clash = q.get<Absence>(
    'SELECT * FROM absences WHERE user_id = ? AND employee_id = ? AND id != ? AND date_from <= ? AND date_to >= ?',
    userId, employee_id, id ?? 0, b.date_to, b.date_from,
  );
  if (clash) {
    throw new BadRequest(`Пересекается с другим отсутствием: ${ABSENCE_NAMES[clash.type]} ${clash.date_from} — ${clash.date_to}`);
  }
  return { user_id: userId, employee_id, type: b.type, date_from: b.date_from, date_to: b.date_to, comment: String(b.comment || '').trim() || null };
}

const withMeta = (a: Absence) => ({
  ...a,
  days: daysIn(a.date_from, a.date_to).length,
  shifted: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM absence_shifts WHERE absence_id = ?', a.id)!.n,
});

function ownAbsence(userId: number, id: number) {
  const a = q.get<Absence>('SELECT * FROM absences WHERE id = ? AND user_id = ?', id, userId);
  if (!a) throw new BadRequest('Отсутствие не найдено');
  return a;
}

absencesApi.get('/absences', (req, res) => {
  const from = isYmd(req.query.from) ? req.query.from : '0000-01-01';
  const to = isYmd(req.query.to) ? req.query.to : '9999-12-31';
  const rows = q.all<Absence>(
    `SELECT a.* FROM absences a JOIN employees e ON e.id = a.employee_id AND e.user_id = a.user_id
     WHERE a.user_id = ? AND a.date_to >= ? AND a.date_from <= ? ORDER BY a.date_from`, uid(req), from, to,
  );
  res.json(rows.map(withMeta));
});

absencesApi.post('/absences', (req, res) => {
  const a = validate(uid(req), req.body || {});
  const r = q.run('INSERT INTO absences(user_id, employee_id, type, date_from, date_to, comment) VALUES(?,?,?,?,?,?)', a.user_id, a.employee_id, a.type, a.date_from, a.date_to, a.comment);
  runRulesFor(uid(req));
  emit({ type: 'tasks', ids: [] });
  res.json(withMeta(q.get<Absence>('SELECT * FROM absences WHERE id = ?', Number(r.lastInsertRowid))!));
});

absencesApi.put('/absences/:id', (req, res) => {
  const id = ownAbsence(uid(req), Number(req.params.id)).id;
  const a = validate(uid(req), req.body || {}, id);
  q.run('UPDATE absences SET employee_id=?, type=?, date_from=?, date_to=?, comment=? WHERE id=?', a.employee_id, a.type, a.date_from, a.date_to, a.comment, id);
  runRulesFor(uid(req));
  emit({ type: 'tasks', ids: [] });
  res.json(withMeta(q.get<Absence>('SELECT * FROM absences WHERE id = ?', id)!));
});

absencesApi.delete('/absences/:id', (req, res) => {
  const id = ownAbsence(uid(req), Number(req.params.id)).id;
  q.run('DELETE FROM absences WHERE id = ?', id);
  q.run('DELETE FROM absence_shifts WHERE absence_id = ?', id);
  q.run("DELETE FROM alerts WHERE user_id = ? AND type = 'absence' AND dedupe_key LIKE ?", uid(req), `%:${id}`);
  emit({ type: 'tasks', ids: [] });
  res.json({ ok: true });
});

const FIELDS = [
  { key: 'deadline', b24: 'DEADLINE', label: 'Крайний срок' },
  { key: 'start_date_plan', b24: 'START_DATE_PLAN', label: 'План. начало' },
  { key: 'end_date_plan', b24: 'END_DATE_PLAN', label: 'План. окончание' },
] as const;

/**
 * Влияние отсутствия на сроки. Для каждой даты задачи: k = календарные дни отсутствия от сегодня (или начала отсутствия)
 * до этой даты включительно; новая дата = дата + k дней, а если она выпала на выходной или другое отсутствие —
 * ближайший следующий рабочий день.
 * Просроченные даты и даты до начала отсутствия не трогаем.
 */
function impact(abs: Absence) {
  const today = todayYmd();
  const days = daysIn(abs.date_from > today ? abs.date_from : today, abs.date_to);
  const skip = absentDays(abs.user_id, abs.employee_id, absencesOf(abs.user_id, abs.employee_id));
  const tasks = q.all<any>(
    `SELECT * FROM tasks WHERE responsible_id = ? AND status NOT IN (5,7)
       AND (deadline IS NOT NULL OR end_date_plan IS NOT NULL OR start_date_plan IS NOT NULL) ORDER BY deadline`,
    abs.employee_id,
  );
  const applied = new Map(q.all<{ task_id: number; changes: string; applied_at: string }>('SELECT * FROM absence_shifts WHERE absence_id = ?', abs.id).map((r) => [r.task_id, r]));

  const out = [];
  for (const t of tasks) {
    const changes: Record<string, { label: string; from: string; to: string }> = {};
    for (const f of FIELDS) {
      const v = t[f.key] as string | null;
      if (!v) continue;
      const { ymd, time } = mskParts(v);
      if (ymd < today) continue;
      const k = days.filter((d) => d <= ymd).length;
      if (!k) continue;
      changes[f.key] = { label: f.label, from: v, to: mskIso(nextWorkday(addDays(ymd, k), skip), time) };
    }
    const done = applied.get(t.id);
    if (!Object.keys(changes).length && !done) continue;
    out.push({
      taskId: t.id, title: t.title, stage_id: t.stage_id, status: t.status,
      changes: done ? JSON.parse(done.changes) : changes, applied: !!done, appliedAt: done?.applied_at ?? null,
    });
  }
  return out;
}

absencesApi.get('/absences/:id/impact', (req, res) => {
  const abs = ownAbsence(uid(req), Number(req.params.id));
  res.json({ absence: withMeta(abs), tasks: impact(abs) });
});

/** Записать сдвинутые сроки в Б24 для выбранных задач */
absencesApi.post('/absences/:id/apply', async (req, res) => {
  const abs = ownAbsence(uid(req), Number(req.params.id));
  const ids = new Set<number>((req.body?.taskIds || []).map(Number));
  const errors: string[] = [];
  let ok = 0;
  for (const item of impact(abs)) {
    if (!ids.has(item.taskId) || item.applied) continue;
    const fields: Record<string, string> = {};
    for (const f of FIELDS) if (item.changes[f.key]) fields[f.b24] = item.changes[f.key].to;
    // Б24 стирает вторую плановую дату, если прислать одну — дополняем пару текущим значением
    const t = q.get<any>('SELECT start_date_plan, end_date_plan FROM tasks WHERE id = ?', item.taskId);
    if (fields.START_DATE_PLAN && !fields.END_DATE_PLAN && t?.end_date_plan) fields.END_DATE_PLAN = t.end_date_plan;
    if (fields.END_DATE_PLAN && !fields.START_DATE_PLAN && t?.start_date_plan) fields.START_DATE_PLAN = t.start_date_plan;
    try {
      await callResult('tasks.task.update', { taskId: item.taskId, fields });
      q.run('INSERT OR REPLACE INTO absence_shifts(absence_id, task_id, changes, applied_at) VALUES(?,?,?,?)', abs.id, item.taskId, JSON.stringify(item.changes), new Date().toISOString());
      await refreshTask(item.taskId).catch(() => null);
      ok++;
    } catch (e: any) {
      errors.push(`#${item.taskId}: ${e.message}`);
    }
  }
  runRulesFor(uid(req));
  res.json({ ok, errors });
});

absencesApi.use((err: any, _req: any, res: any, next: any) => (err instanceof BadRequest ? res.status(400).json({ error: err.message }) : next(err)));
