import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,            -- ID пользователя в Б24
  name TEXT NOT NULL,
  department TEXT,
  email TEXT,
  position TEXT,
  photo TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- порядок на экране
  is_buffer INTEGER NOT NULL DEFAULT 0,    -- буфер: на него сначала ставятся задачи, потом распределяются
  dayoff_granted REAL NOT NULL DEFAULT 0,  -- выдано дней отгула (использованные считаются по absences)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  employee_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (employee_id, task_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE,
  type TEXT NOT NULL,                      -- change | comment | stale | idle | deadline_soon | overdue | assigned
  task_id INTEGER,
  employee_id INTEGER,
  title TEXT NOT NULL,
  message TEXT,
  author TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  task_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL
);

-- Подписки браузеров на Web Push
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Заметки: табы и карточки
CREATE TABLE IF NOT EXISTS note_tabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

export const DEFAULT_SETTINGS = {
  syncIntervalSec: 30,
  staleDays: 7,           // задача висит на сотруднике дольше N дней
  idleDays: 3,            // по задаче нет активности N дней
  deadlineWarnHours: 24,  // предупреждать о дедлайне за N часов
  doneVisibleDays: 14,    // сколько дней показывать закрытые задачи на канбане
  defaultTaskDays: 2,     // длительность задачи по умолчанию для Ганта
  workdayHours: 8,
};
export type Settings = typeof DEFAULT_SETTINGS;

export function getSettings(): Settings {
  const rows = q.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const s: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in s) s[r.key] = JSON.parse(r.value);
  return s;
}

export function saveSettings(patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(n));
  }
}

export function getMeta(key: string): string | undefined {
  return q.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'meta:' + key)?.value;
}
export function setMeta(key: string, value: string) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'meta:' + key, value);
}
