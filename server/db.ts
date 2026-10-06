import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
-- Сотрудники — свои у каждого пользователя приложения (один человек Б24 может быть у нескольких)
CREATE TABLE IF NOT EXISTS employees (
  user_id INTEGER NOT NULL DEFAULT 0,      -- владелец (пользователь приложения)
  id INTEGER NOT NULL,                     -- ID пользователя в Б24
  name TEXT NOT NULL,
  department TEXT,
  email TEXT,
  position TEXT,
  photo TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- порядок на экране
  is_buffer INTEGER NOT NULL DEFAULT 0,    -- буфер: на него сначала ставятся задачи, потом распределяются
  dayoff_granted REAL NOT NULL DEFAULT 0,  -- выдано дней отгула (использованные считаются по absences)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

-- Отделы пользователя: группы Б24, по стадиям которых строится канбан
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  group_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2f6fed',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL DEFAULT 0,    -- ID группы, к канбану которой относится стадия
  title TEXT NOT NULL,
  sort INTEGER NOT NULL,
  color TEXT,
  system_type TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status INTEGER NOT NULL,
  stage_id INTEGER,
  group_id INTEGER,
  group_name TEXT,
  responsible_id INTEGER,
  responsible_name TEXT,
  responsible_icon TEXT,
  creator_id INTEGER,
  creator_name TEXT,
  priority INTEGER,
  parent_id INTEGER,
  created_date TEXT,
  changed_date TEXT,
  activity_date TEXT,
  closed_date TEXT,
  deadline TEXT,
  start_date_plan TEXT,
  end_date_plan TEXT,
  time_estimate INTEGER,
  depends_on TEXT NOT NULL DEFAULT '[]',   -- JSON массив ID предшественников
  tags TEXT NOT NULL DEFAULT '[]',         -- JSON массив названий тегов
  responsible_since TEXT,                  -- когда задача перешла на текущего ответственного
  stage_since TEXT,                        -- когда задача попала в текущую стадию
  last_history_id INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_resp ON tasks(responsible_id);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);

CREATE TABLE IF NOT EXISTS queue (
  user_id INTEGER NOT NULL DEFAULT 0,
  employee_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, employee_id, task_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,      -- кому адресован алерт
  dedupe_key TEXT UNIQUE,                  -- u<user_id>:<ключ>
  type TEXT NOT NULL,                      -- change | comment | stale | idle | deadline_soon | overdue | assigned
  task_id INTEGER,
  employee_id INTEGER,
  note_id INTEGER,
  title TEXT NOT NULL,
  message TEXT,
  author TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  employee_id INTEGER NOT NULL,
  type TEXT NOT NULL,                      -- vacation | dayoff | sick
  date_from TEXT NOT NULL,                 -- YYYY-MM-DD включительно
  date_to TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_absences_emp ON absences(employee_id, date_from);

-- Какие сроки задач уже сдвинуты из-за отсутствия (чтобы не сдвинуть дважды)
CREATE TABLE IF NOT EXISTS absence_shifts (
  absence_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  changes TEXT NOT NULL,                   -- JSON: {поле: [было, стало]}
  applied_at TEXT NOT NULL,
  PRIMARY KEY (absence_id, task_id)
);

-- Оповещения в браузере: индивидуальная настройка задачи (on — всегда, off — никогда)
CREATE TABLE IF NOT EXISTS task_notify (
  user_id INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

-- Подписки браузеров на Web Push
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  keys TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Заметки: табы и карточки
CREATE TABLE IF NOT EXISTS note_tabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',        -- HTML из редактора
  content_text TEXT NOT NULL DEFAULT '',   -- плоский текст для поиска
  color TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  remind_on TEXT,                          -- YYYY-MM-DD: в этот день придёт напоминание
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_tab ON notes(tab_id, sort_order);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Пользователи админки
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,
  name TEXT,
  password_hash TEXT NOT NULL,             -- scrypt$соль$хэш
  role TEXT NOT NULL DEFAULT 'user',       -- admin | user
  theme TEXT NOT NULL DEFAULT 'auto',      -- auto | light | dark
  settings TEXT,                           -- JSON: личные пороги алертов и планирования
  notify TEXT,                             -- JSON: настройки оповещений в браузере
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Одноразовые токены сброса пароля (хранится только sha256 токена)
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
`);

// Миграции для баз, созданных до добавления колонок
const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
// Сессии теперь привязаны к пользователю; старые (вход по общему паролю) сбрасываем
if (cols('sessions').length && !cols('sessions').includes('user_id')) db.exec('DROP TABLE sessions');
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- sha256 токена из cookie
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!cols('stages').includes('entity_id')) {
  db.exec('DROP TABLE stages; CREATE TABLE stages (id INTEGER PRIMARY KEY, entity_id INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, sort INTEGER NOT NULL, color TEXT, system_type TEXT)');
}
if (!cols('employees').includes('sort_order')) {
  db.exec('ALTER TABLE employees ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0; ALTER TABLE employees ADD COLUMN is_buffer INTEGER NOT NULL DEFAULT 0');
}
if (!cols('employees').includes('dayoff_granted')) {
  db.exec('ALTER TABLE employees ADD COLUMN dayoff_granted REAL NOT NULL DEFAULT 0');
}
if (!cols('alerts').includes('note_id')) {
  db.exec('ALTER TABLE alerts ADD COLUMN note_id INTEGER');
}
if (!cols('tasks').includes('tags')) {
  // changed_date сбрасываем, чтобы полная сверка перечитала задачи вместе с тегами
  db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'; UPDATE tasks SET changed_date = ''");
}

// ---------- Переход на нескольких пользователей ----------
// Данные однопользовательской версии получают user_id = 0 («ничьи»), затем их забирает первый пользователь.
const addCol = (table: string, ddl: string, name: string) => {
  if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};
const legacy = !cols('employees').includes('user_id');
if (legacy) {
  db.exec(`
    BEGIN;
    CREATE TABLE employees_v2 (
      user_id INTEGER NOT NULL DEFAULT 0, id INTEGER NOT NULL, name TEXT NOT NULL, department TEXT, email TEXT, position TEXT,
      photo TEXT, sort_order INTEGER NOT NULL DEFAULT 0, is_buffer INTEGER NOT NULL DEFAULT 0, dayoff_granted REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, id));
    INSERT INTO employees_v2 SELECT 0, id, name, department, email, position, photo, sort_order, is_buffer, dayoff_granted, created_at FROM employees;
    DROP TABLE employees;
    ALTER TABLE employees_v2 RENAME TO employees;
    COMMIT;`);
}
if (!cols('queue').includes('user_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE queue_v2 (user_id INTEGER NOT NULL DEFAULT 0, employee_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
      position INTEGER NOT NULL, PRIMARY KEY (user_id, employee_id, task_id));
    INSERT INTO queue_v2 SELECT 0, employee_id, task_id, position FROM queue;
    DROP TABLE queue;
    ALTER TABLE queue_v2 RENAME TO queue;
    COMMIT;`);
}
if (!cols('task_notify').includes('user_id')) {
  db.exec(`
    BEGIN;
    CREATE TABLE task_notify_v2 (user_id INTEGER NOT NULL DEFAULT 0, task_id INTEGER NOT NULL, mode TEXT NOT NULL, PRIMARY KEY (user_id, task_id));
    INSERT INTO task_notify_v2 SELECT 0, task_id, mode FROM task_notify;
    DROP TABLE task_notify;
    ALTER TABLE task_notify_v2 RENAME TO task_notify;
    COMMIT;`);
}
if (!cols('alerts').includes('user_id')) {
  // Ключи дедупликации получают префикс владельца — иначе после обновления все алерты пришли бы заново
  db.exec(`ALTER TABLE alerts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
           UPDATE alerts SET dedupe_key = 'u0:' || dedupe_key WHERE dedupe_key IS NOT NULL;`);
}
addCol('absences', 'user_id INTEGER NOT NULL DEFAULT 0', 'user_id');
addCol('push_subscriptions', 'user_id INTEGER NOT NULL DEFAULT 0', 'user_id');
addCol('note_tabs', 'user_id INTEGER NOT NULL DEFAULT 0', 'user_id');
if (!cols('users').includes('role')) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
           UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users);`);
}
addCol('users', "theme TEXT NOT NULL DEFAULT 'auto'", 'theme');
addCol('users', 'settings TEXT', 'settings');
addCol('users', 'notify TEXT', 'notify');
db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, read_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_absences_user ON absences(user_id, employee_id, date_from)');

// Группа из BITRIX_GROUP прежней версии становится первым отделом
if (legacy && Number(process.env.BITRIX_GROUP) > 0) {
  const g = Number(process.env.BITRIX_GROUP);
  const name = (db.prepare('SELECT group_name AS n FROM tasks WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1').get(g) as { n: string } | undefined)?.n;
  db.prepare("INSERT OR IGNORE INTO departments(user_id, group_id, title, color, sort_order) VALUES(0, ?, ?, '#2f6fed', 1)").run(g, name || `Группа ${g}`);
}

/** Отдать «ничьи» данные (user_id = 0) пользователю — при создании первого пользователя или после миграции */
export function claimOrphans(userId: number) {
  db.exec('BEGIN');
  try {
    for (const t of ['employees', 'departments', 'queue', 'absences', 'alerts', 'task_notify', 'push_subscriptions', 'note_tabs']) {
      db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = 0`).run(userId);
    }
    // Префикс собираем в JS: число из node:sqlite при склейке строк в SQL превращается в «1.0»
    db.prepare("UPDATE alerts SET dedupe_key = ? || substr(dedupe_key, 3) WHERE dedupe_key LIKE 'u0:%' AND user_id = ?").run(`u${userId}`, userId);
    // Личные настройки прежней версии хранились глобально — переносим владельцу
    const u = db.prepare('SELECT settings, notify FROM users WHERE id = ?').get(userId) as { settings: string | null; notify: string | null } | undefined;
    if (u && !u.settings) {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const keys = ['staleDays', 'idleDays', 'deadlineWarnHours', 'doneVisibleDays', 'defaultTaskDays', 'workdayHours'];
      const s: Record<string, unknown> = {};
      for (const r of rows) if (keys.includes(r.key)) s[r.key] = JSON.parse(r.value);
      if (Object.keys(s).length) db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(s), userId);
    }
    if (u && !u.notify) {
      const n = db.prepare("SELECT value FROM settings WHERE key = 'meta:notify'").get() as { value: string } | undefined;
      if (n) db.prepare('UPDATE users SET notify = ? WHERE id = ?').run(n.value, userId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

export const q = {
  all<T = any>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...params.map(norm)) as T[];
  },
  get<T = any>(sql: string, ...params: unknown[]): T | undefined {
    return db.prepare(sql).get(...params.map(norm)) as T | undefined;
  },
  run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...params.map(norm));
  },
  tx<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

/** Личные настройки пользователя: пороги алертов и планирование */
export const DEFAULT_USER_SETTINGS = {
  staleDays: 7,           // задача висит на сотруднике дольше N дней
  idleDays: 3,            // по задаче нет активности N дней
  deadlineWarnHours: 24,  // предупреждать о дедлайне за N часов
  doneVisibleDays: 14,    // сколько дней показывать закрытые задачи на канбане
  defaultTaskDays: 2,     // длительность задачи по умолчанию для Ганта
  workdayHours: 8,
  loadNorm: 8,            // норма открытых задач на сотрудника — выше считается перегрузкой
};
export type Settings = typeof DEFAULT_USER_SETTINGS;

/** Общие настройки сервера (меняет только администратор) */
export const DEFAULT_GLOBAL_SETTINGS = { syncIntervalSec: 30 };

export function getSettings(userId: number): Settings {
  const raw = q.get<{ settings: string | null }>('SELECT settings FROM users WHERE id = ?', userId)?.settings;
  return { ...DEFAULT_USER_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
}

export function saveSettings(userId: number, patch: Record<string, unknown>) {
  const cur = getSettings(userId);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_USER_SETTINGS)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) (cur as any)[k] = n;
  }
  q.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(cur), userId);
  return cur;
}

export function getGlobalSettings() {
  const v = q.get<{ value: string }>("SELECT value FROM settings WHERE key = 'syncIntervalSec'")?.value;
  return { syncIntervalSec: v ? Number(JSON.parse(v)) : DEFAULT_GLOBAL_SETTINGS.syncIntervalSec };
}

export function saveGlobalSettings(patch: Record<string, unknown>) {
  const n = Number(patch.syncIntervalSec);
  if (Number.isFinite(n) && n >= 15) {
    q.run("INSERT INTO settings(key, value) VALUES('syncIntervalSec', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(n));
  }
  return getGlobalSettings();
}

export function getMeta(key: string): string | undefined {
  return q.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'meta:' + key)?.value;
}
export function setMeta(key: string, value: string) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'meta:' + key, value);
}

// Миграция на существующей базе: «ничьи» данные сразу отдаём первому пользователю (администратору)
{
  const first = q.get<{ id: number | null }>('SELECT MIN(id) AS id FROM users')?.id;
  const orphans = q.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM employees WHERE user_id = 0) + (SELECT COUNT(*) FROM departments WHERE user_id = 0)
          + (SELECT COUNT(*) FROM note_tabs WHERE user_id = 0) + (SELECT COUNT(*) FROM alerts WHERE user_id = 0) AS n`,
  )!.n;
  if (first && orphans) claimOrphans(first);
}
