import { q, getSettings } from './db.ts';
import { emit } from './bus.ts';
import { GROUP_ID } from './bitrix.ts';
import { queuePush, shouldNotify } from './notify.ts';
import { ABSENCE_NAMES, absenceOn, mskParts, todayYmd } from './calendar.ts';

export interface NewAlert {
  key: string;
  type: string;
  taskId?: number | null;
  employeeId?: number | null;
  noteId?: number | null;
  title: string;
  message?: string | null;
  author?: string | null;
}

/** Добавить алерт (повтор по dedupe_key игнорируется) */
export function addAlert(a: NewAlert) {
  const r = q.run(
    `INSERT INTO alerts(dedupe_key, type, task_id, employee_id, note_id, title, message, author, created_at)
     VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
    a.key, a.type, a.taskId, a.employeeId, a.noteId, a.title, a.message, a.author, new Date().toISOString(),
  );
  if (r.changes) {
    const alert = q.get<any>('SELECT * FROM alerts WHERE id = ?', Number(r.lastInsertRowid));
    const notify = shouldNotify(alert);
    emit({ type: 'alert', alert: { ...alert, notify } });
    if (notify) queuePush(alert);
  }
}

const days = (n: number) => n * 86400e3;
const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const fmtYmd = (ymd: string) => ymd.split('-').reverse().join('.');
const ago = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3);

/** Правила по состоянию задач: сроки, «зависшие» задачи, отсутствие активности */
export function runRules() {
  const s = getSettings();
  const now = Date.now();
  const tasks = q.all<any>(
    `SELECT t.*, e.id AS emp_id FROM tasks t LEFT JOIN employees e ON e.id = t.responsible_id
     WHERE t.status NOT IN (5, 7) AND (t.group_id = ? OR e.id IS NOT NULL)`,
    GROUP_ID,
  );
  const today = todayYmd();

  // Напоминания из заметок
  const notes = q.all<any>(
    `SELECT n.id, n.title, n.content_text, n.remind_on, t.title AS tab FROM notes n JOIN note_tabs t ON t.id = n.tab_id
     WHERE n.done = 0 AND n.remind_on IS NOT NULL AND n.remind_on <= ?`, today,
  );
  for (const n of notes) {
    const text = (n.content_text || '').replace(/\s+/g, ' ').trim();
    addAlert({
      key: `note:${n.id}:${n.remind_on}`, type: 'note', noteId: n.id,
      title: `Напоминание: ${n.title || text.slice(0, 60) || 'заметка'}`,
      message: `${n.tab}${text ? ' · ' + (text.length > 160 ? text.slice(0, 160) + '…' : text) : ''}`,
    });
  }

  for (const t of tasks) {
    const absentNow = t.emp_id ? absenceOn(t.emp_id, today) : null;
    if (t.deadline) {
      const dl = new Date(t.deadline).getTime();
      if (dl < now) {
        addAlert({ key: `overdue:${t.id}:${t.deadline}`, type: 'overdue', taskId: t.id, employeeId: t.emp_id, title: `Просрочена: ${t.title}`, message: `Крайний срок был ${fmt(t.deadline)}. Ответственный: ${t.responsible_name || '—'}` });
      } else if (dl - now < s.deadlineWarnHours * 3600e3) {
        addAlert({ key: `soon:${t.id}:${t.deadline}`, type: 'deadline_soon', taskId: t.id, employeeId: t.emp_id, title: `Скоро дедлайн: ${t.title}`, message: `Крайний срок ${fmt(t.deadline)}. Ответственный: ${t.responsible_name || '—'}` });
      }
    }
    if (t.end_date_plan && !t.deadline && new Date(t.end_date_plan).getTime() < now) {
      addAlert({ key: `planover:${t.id}:${t.end_date_plan}`, type: 'overdue', taskId: t.id, employeeId: t.emp_id, title: `Вышел плановый срок: ${t.title}`, message: `План. окончание было ${fmt(t.end_date_plan)}` });
    }
    if (!t.emp_id) continue;

    // Срок выпадает на отсутствие ответственного
    for (const [field, label] of [['deadline', 'Крайний срок'], ['end_date_plan', 'Плановое окончание']] as const) {
      if (!t[field]) continue;
      const { ymd } = mskParts(t[field]);
      if (ymd < today) continue;
      const abs = absenceOn(t.emp_id, ymd);
      if (abs) {
        addAlert({
          key: `absence:${t.id}:${field}:${t[field]}:${abs.id}`, type: 'absence', taskId: t.id, employeeId: t.emp_id,
          title: `Срок выпадает на отсутствие: ${t.title}`,
          message: `${label} ${fmtYmd(ymd)}, а ${t.responsible_name} — ${ABSENCE_NAMES[abs.type].toLowerCase()} ${fmtYmd(abs.date_from)}–${fmtYmd(abs.date_to)}. Сдвинуть сроки можно в разделе «Отсутствия».`,
        });
        break;
      }
    }

    // Пока сотрудник отсутствует, «висит» и «нет движения» не считаем проблемой
    if (absentNow) continue;
    if (t.responsible_since && now - new Date(t.responsible_since).getTime() > days(s.staleDays)) {
      addAlert({ key: `stale:${t.id}:${t.responsible_id}:${t.responsible_since}`, type: 'stale', taskId: t.id, employeeId: t.emp_id, title: `Задача долго висит на сотруднике: ${t.title}`, message: `${t.responsible_name} — ${ago(t.responsible_since)} дн. (с ${fmt(t.responsible_since)})` });
    }
    if (t.activity_date && now - new Date(t.activity_date).getTime() > days(s.idleDays) && t.status !== 6) {
      addAlert({ key: `idle:${t.id}:${t.activity_date}`, type: 'idle', taskId: t.id, employeeId: t.emp_id, title: `Нет движения по задаче: ${t.title}`, message: `${t.responsible_name}: последняя активность ${ago(t.activity_date)} дн. назад` });
    }
  }
}
