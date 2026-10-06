// Оповещения в браузере: фильтр «по каким алертам/задачам», Web Push (работает и при закрытой вкладке).
import { Router } from 'express';
import webpush from 'web-push';
import { q, getMeta, setMeta } from './db.ts';

export interface NotifySettings {
  enabled: boolean;
  /** Типы алертов, по которым присылать оповещения */
  types: string[];
  /** all — по всем задачам; selected — только по задачам выбранных сотрудников и отмеченным задачам */
  mode: 'all' | 'selected';
  employees: number[];
}

export const ALL_TYPES = ['change', 'comment', 'assigned', 'new', 'overdue', 'deadline_soon', 'stale', 'idle', 'absence', 'note'];
const DEFAULTS: NotifySettings = {
  enabled: true,
  types: ['change', 'comment', 'assigned', 'new', 'overdue', 'deadline_soon', 'absence', 'note'],
  mode: 'all',
  employees: [],
};

export function getNotifySettings(userId: number): NotifySettings {
  const raw = q.get<{ notify: string | null }>('SELECT notify FROM users WHERE id = ?', userId)?.notify;
  if (!raw) return DEFAULTS;
  const saved = JSON.parse(raw);
  // Типы, появившиеся после сохранения настроек, включаем по умолчанию
  const seen: string[] = saved.seen || ALL_TYPES.filter((t) => t !== 'note');
  const added = DEFAULTS.types.filter((t) => !seen.includes(t));
  return { ...DEFAULTS, ...saved, types: [...new Set([...(saved.types || DEFAULTS.types), ...added])] };
}

function saveNotifySettings(userId: number, b: Partial<NotifySettings>) {
  const cur = getNotifySettings(userId);
  const next: NotifySettings = {
    enabled: b.enabled ?? cur.enabled,
    types: Array.isArray(b.types) ? b.types.filter((t) => ALL_TYPES.includes(t)) : cur.types,
    mode: b.mode === 'selected' ? 'selected' : b.mode === 'all' ? 'all' : cur.mode,
    employees: Array.isArray(b.employees) ? b.employees.map(Number).filter(Boolean) : cur.employees,
  };
  q.run('UPDATE users SET notify = ? WHERE id = ?', JSON.stringify({ ...next, seen: ALL_TYPES }), userId);
  return next;
}

export const taskNotifyMode = (userId: number, taskId: number | null | undefined) =>
  taskId ? (q.get<{ mode: string }>('SELECT mode FROM task_notify WHERE user_id = ? AND task_id = ?', userId, taskId)?.mode ?? null) : null;

/** Нужно ли оповещать браузер владельца алерта */
export function shouldNotify(a: { user_id: number; type: string; task_id?: number | null; employee_id?: number | null }): boolean {
  const s = getNotifySettings(a.user_id);
  if (!s.enabled || !s.types.includes(a.type)) return false;
  if (a.type === 'note') return true; // напоминания не привязаны к задачам и сотрудникам
  const own = taskNotifyMode(a.user_id, a.task_id);
  if (own === 'off') return false;
  if (own === 'on' || s.mode === 'all') return true;
  return !!a.employee_id && s.employees.includes(a.employee_id);
}

// ---------- Web Push ----------
function vapid() {
  let keys = getMeta('vapid');
  if (!keys) {
    keys = JSON.stringify(webpush.generateVAPIDKeys());
    setMeta('vapid', keys);
  }
  return JSON.parse(keys) as { publicKey: string; privateKey: string };
}
const { publicKey, privateKey } = vapid();
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:noreply@localhost', publicKey, privateKey);

interface Payload { title: string; body: string; tag: string; taskId?: number | null; url?: string }

async function sendPush(userId: number, p: Payload) {
  const subs = q.all<{ endpoint: string; keys: string }>('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?', userId);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(p), { TTL: 24 * 3600 });
    } catch (e: any) {
      // Подписка больше не действует (браузер отписался) — удаляем
      if (e?.statusCode === 404 || e?.statusCode === 410) q.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
      else console.error('[push]', e?.statusCode || '', e?.body || e?.message);
    }
  }));
}

// Группировка: алерты одного цикла синхронизации копятся 3 секунды; если их много — одно сводное оповещение
const pending = new Map<number, any[]>();
let timer: NodeJS.Timeout | null = null;
const BURST = 4;

export function queuePush(alert: any) {
  pending.set(alert.user_id, [...(pending.get(alert.user_id) || []), alert]);
  if (timer) return;
  timer = setTimeout(() => {
    const all = [...pending.entries()];
    pending.clear();
    timer = null;
    for (const [userId, batch] of all) {
      if (batch.length < BURST) {
        for (const a of batch) void sendPush(userId, { title: a.title, body: a.message || '', tag: `alert-${a.id}`, taskId: a.task_id, url: a.note_id ? `/#/notes?note=${a.note_id}` : undefined });
      } else {
        const titles = batch.slice(0, 3).map((a) => '• ' + a.title).join('\n');
        void sendPush(userId, { title: `Новых алертов: ${batch.length}`, body: `${titles}${batch.length > 3 ? '\n…' : ''}`, tag: 'alert-batch' });
      }
    }
  }, 3000);
}

const uid = (req: any) => req.user.id as number;

// ---------- API ----------
export const notifyApi = Router();

notifyApi.get('/notify/settings', (req, res) => {
  res.json({
    ...getNotifySettings(uid(req)),
    allTypes: ALL_TYPES,
    publicKey,
    subscriptions: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', uid(req))!.n,
    tasks: q.all(
      `SELECT n.task_id, n.mode, t.title, t.responsible_name FROM task_notify n LEFT JOIN tasks t ON t.id = n.task_id
       WHERE n.user_id = ? ORDER BY n.mode, n.task_id`, uid(req),
    ),
  });
});

notifyApi.put('/notify/settings', (req, res) => res.json(saveNotifySettings(uid(req), req.body || {})));

notifyApi.post('/notify/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: 'Некорректная подписка' });
  q.run(
    `INSERT INTO push_subscriptions(endpoint, user_id, keys, user_agent) VALUES(?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, user_id = excluded.user_id`,
    sub.endpoint, uid(req), JSON.stringify(sub.keys), String(req.headers['user-agent'] || '').slice(0, 300),
  );
  res.json({ ok: true });
});

notifyApi.post('/notify/unsubscribe', (req, res) => {
  q.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), uid(req));
  res.json({ ok: true });
});

notifyApi.post('/notify/test', async (req, res) => {
  const n = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', uid(req))!.n;
  await sendPush(uid(req), { title: 'Тестовое оповещение', body: 'Оповещения о задачах работают', tag: 'test' });
  res.json({ sent: n });
});

/** Индивидуальная настройка задачи: on | off | null (по общим правилам) */
notifyApi.put('/tasks/:id/notify', (req, res) => {
  const id = Number(req.params.id);
  const mode = req.body?.mode;
  if (mode === 'on' || mode === 'off') {
    q.run('INSERT INTO task_notify(user_id, task_id, mode) VALUES(?, ?, ?) ON CONFLICT(user_id, task_id) DO UPDATE SET mode = excluded.mode', uid(req), id, mode);
  } else {
    q.run('DELETE FROM task_notify WHERE user_id = ? AND task_id = ?', uid(req), id);
  }
  res.json({ taskId: id, mode: taskNotifyMode(uid(req), id) });
});
