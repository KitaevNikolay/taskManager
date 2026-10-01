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

export function getNotifySettings(): NotifySettings {
  const raw = getMeta('notify');
  if (!raw) return DEFAULTS;
  const saved = JSON.parse(raw);
  // Типы, появившиеся после сохранения настроек, включаем по умолчанию
  const seen: string[] = saved.seen || ALL_TYPES.filter((t) => t !== 'note');
  const added = DEFAULTS.types.filter((t) => !seen.includes(t));
  return { ...DEFAULTS, ...saved, types: [...new Set([...(saved.types || DEFAULTS.types), ...added])] };
}

function saveNotifySettings(b: Partial<NotifySettings>) {
  const cur = getNotifySettings();
  const next: NotifySettings = {
    enabled: b.enabled ?? cur.enabled,
    types: Array.isArray(b.types) ? b.types.filter((t) => ALL_TYPES.includes(t)) : cur.types,
    mode: b.mode === 'selected' ? 'selected' : b.mode === 'all' ? 'all' : cur.mode,
    employees: Array.isArray(b.employees) ? b.employees.map(Number).filter(Boolean) : cur.employees,
  };
  setMeta('notify', JSON.stringify({ ...next, seen: ALL_TYPES }));
  return next;
}

export const taskNotifyMode = (taskId: number | null | undefined) =>
  taskId ? (q.get<{ mode: string }>('SELECT mode FROM task_notify WHERE task_id = ?', taskId)?.mode ?? null) : null;

/** Нужно ли оповещать браузер об этом алерте */
export function shouldNotify(a: { type: string; task_id?: number | null; employee_id?: number | null }): boolean {
  const s = getNotifySettings();
  if (!s.enabled || !s.types.includes(a.type)) return false;
  if (a.type === 'note') return true; // напоминания не привязаны к задачам и сотрудникам
  const own = taskNotifyMode(a.task_id);
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

async function sendPush(p: Payload) {
  const subs = q.all<{ endpoint: string; keys: string }>('SELECT endpoint, keys FROM push_subscriptions');
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
let pending: any[] = [];
let timer: NodeJS.Timeout | null = null;
const BURST = 4;

export function queuePush(alert: any) {
  pending.push(alert);
  if (timer) return;
  timer = setTimeout(() => {
    const batch = pending;
    pending = [];
    timer = null;
    if (batch.length < BURST) {
      for (const a of batch) void sendPush({ title: a.title, body: a.message || '', tag: `alert-${a.id}`, taskId: a.task_id, url: a.note_id ? `/#/notes?note=${a.note_id}` : undefined });
    } else {
      const titles = batch.slice(0, 3).map((a) => '• ' + a.title).join('\n');
      void sendPush({ title: `Новых алертов: ${batch.length}`, body: `${titles}${batch.length > 3 ? '\n…' : ''}`, tag: 'alert-batch' });
    }
  }, 3000);
}

// ---------- API ----------
export const notifyApi = Router();

notifyApi.get('/notify/settings', (_req, res) => {
  res.json({
    ...getNotifySettings(),
    allTypes: ALL_TYPES,
    publicKey,
    subscriptions: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')!.n,
    tasks: q.all(
      `SELECT n.task_id, n.mode, t.title, t.responsible_name FROM task_notify n LEFT JOIN tasks t ON t.id = n.task_id ORDER BY n.mode, n.task_id`,
    ),
  });
});

notifyApi.put('/notify/settings', (req, res) => res.json(saveNotifySettings(req.body || {})));

notifyApi.post('/notify/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: 'Некорректная подписка' });
  q.run(
    'INSERT INTO push_subscriptions(endpoint, keys, user_agent) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys',
    sub.endpoint, JSON.stringify(sub.keys), String(req.headers['user-agent'] || '').slice(0, 300),
  );
  res.json({ ok: true });
});

notifyApi.post('/notify/unsubscribe', (req, res) => {
  q.run('DELETE FROM push_subscriptions WHERE endpoint = ?', String(req.body?.endpoint || ''));
  res.json({ ok: true });
});

notifyApi.post('/notify/test', async (_req, res) => {
  const n = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')!.n;
  await sendPush({ title: 'Тестовое оповещение', body: 'Оповещения о задачах работают', tag: 'test' });
  res.json({ sent: n });
});

/** Индивидуальная настройка задачи: on | off | null (по общим правилам) */
notifyApi.put('/tasks/:id/notify', (req, res) => {
  const id = Number(req.params.id);
  const mode = req.body?.mode;
  if (mode === 'on' || mode === 'off') {
    q.run('INSERT INTO task_notify(task_id, mode) VALUES(?, ?) ON CONFLICT(task_id) DO UPDATE SET mode = excluded.mode', id, mode);
  } else {
    q.run('DELETE FROM task_notify WHERE task_id = ?', id);
  }
  res.json({ taskId: id, mode: taskNotifyMode(id) });
});
