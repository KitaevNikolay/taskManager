// Выгрузка заметок в Markdown для Obsidian: таб — папка, заметка — файл со свойствами (frontmatter).
// Упомянутые задачи и сотрудники получают свои файлы-карточки, чтобы граф и обратные ссылки работали и в Obsidian.
// Выгрузка односторонняя: правки, сделанные в Obsidian, в кабинет не возвращаются.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import TurndownService from 'turndown';
import { q, getMeta, setMeta } from './db.ts';
import { PORTAL_URL } from './bitrix.ts';
import { STATUS_NAMES } from './sync.ts';

export const VAULT_DIR = path.resolve(process.env.VAULT_DIR || './data/vault');
const APP_URL = (process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
const SERVICE_DIR = 'Кабинет';
const MANIFEST = '.taskmanager.json';

/** Подпись заметки: заголовок, иначе первая строка текста */
export const noteLabel = (n: { id: number; title: string | null; content_text?: string | null }) =>
  n.title || (n.content_text || '').split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 60) || `Заметка ${n.id}`;

/** Имя файла или папки, безопасное для Windows, macOS и ссылок Obsidian */
const safeName = (s: string, fallback: string) =>
  s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 90) || fallback;
const yaml = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const linkText = (s: string) => s.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();

function frontmatter(fields: Record<string, unknown>) {
  const lines = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${yaml(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/** Раздаёт уникальные (без учёта регистра) имена внутри одной папки */
function namer(taken: string[] = []) {
  const used = new Set(taken.map((s) => s.toLowerCase()));
  return (name: string, id: number) => {
    let n = name;
    if (used.has(n.toLowerCase())) n = `${name} (${id})`;
    used.add(n.toLowerCase());
    return n;
  };
}

const KIND: Record<string, 'task' | 'employee' | 'note'> = { '#': 'task', '@': 'employee', '[[': 'note' };

/** Все файлы хранилища пользователя: путь относительно корня → содержимое */
export function buildVault(userId: number): Map<string, string> {
  const tabs = q.all<any>('SELECT * FROM note_tabs WHERE user_id = ? ORDER BY sort_order, id', userId);
  const notes = q.all<any>('SELECT n.* FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE t.user_id = ? ORDER BY n.id', userId);

  const tabDir = new Map<number, string>();
  const nameTab = namer([SERVICE_DIR]);
  for (const t of tabs) tabDir.set(t.id, nameTab(safeName(t.title, `Таб ${t.id}`), t.id));

  const notePath = new Map<number, string>(); // без .md — так их пишет Obsidian в [[ссылках]]
  const namers = new Map<number, ReturnType<typeof namer>>();
  for (const n of notes) {
    if (!namers.has(n.tab_id)) namers.set(n.tab_id, namer());
    notePath.set(n.id, `${tabDir.get(n.tab_id)}/${namers.get(n.tab_id)!(safeName(noteLabel(n), `Заметка ${n.id}`), n.id)}`);
  }

  // Карточки задач и сотрудников создаём только для упомянутых
  const taskPath = new Map<number, string>();
  const empPath = new Map<number, string>();
  const nameTask = namer();
  const nameEmp = namer();
  const taskRow = (id: number) => q.get<any>('SELECT * FROM tasks WHERE id = ?', id);
  const empRow = (id: number) => q.get<any>('SELECT * FROM employees WHERE user_id = ? AND id = ?', userId, id);
  const files = new Map<string, string>();

  const resolve = (kind: string, id: number, label: string) => {
    if (kind === 'note') {
      const p = notePath.get(id);
      const n = notes.find((x) => x.id === id);
      return p ? `[[${p}|${linkText(noteLabel(n))}]]` : label;
    }
    if (kind === 'task') {
      let p = taskPath.get(id);
      if (!p) {
        const t = taskRow(id);
        if (!t) return `#${id} ${label}`;
        p = `${SERVICE_DIR}/Задачи/${nameTask(safeName(`${id} ${t.title}`, String(id)), id)}`;
        taskPath.set(id, p);
        files.set(p + '.md', taskFile(t));
      }
      return `[[${p}|#${id} ${linkText(taskRow(id)?.title || label)}]]`;
    }
    let p = empPath.get(id);
    if (!p) {
      const e = empRow(id);
      if (!e) return label;
      p = `${SERVICE_DIR}/Сотрудники/${nameEmp(safeName(e.name, String(id)), id)}`;
      empPath.set(id, p);
      files.set(p + '.md', employeeFile(e));
    }
    return `[[${p}|${linkText(empRow(id)?.name || label)}]]`;
  };

  const td = turndown(resolve);
  for (const n of notes) {
    const body = td.turndown(n.content || '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    const fm = frontmatter({
      tm_id: n.id, tab: tabs.find((t) => t.id === n.tab_id)?.title, color: n.color, pinned: !!n.pinned, done: !!n.done,
      remind_on: n.remind_on, daily: n.daily_on, created: n.created_at, updated: n.updated_at, tm_url: `${APP_URL}/#/notes?note=${n.id}`,
    });
    files.set(notePath.get(n.id) + '.md', `${fm}\n${body}\n`);
  }
  return files;
}

function taskFile(t: any) {
  const b24 = `${PORTAL_URL}/company/personal/user/${t.responsible_id || 0}/tasks/task/view/${t.id}/`;
  const app = `${APP_URL}/?task=${t.id}#/kanban`;
  return frontmatter({
    tm_task: t.id, status: STATUS_NAMES[t.status] || String(t.status), responsible: t.responsible_name, group: t.group_name,
    deadline: t.deadline, b24_url: b24, tm_url: app,
  }) + `\n# #${t.id} ${t.title}\n\n[Открыть в Битрикс24](${b24}) · [Открыть в кабинете](${app})\n\nЗаметки, где упомянута задача, — на панели обратных ссылок.\n`;
}

function employeeFile(e: any) {
  return frontmatter({ tm_employee: e.id, position: e.position, department: e.department, email: e.email })
    + `\n# ${e.name}\n\n${[e.position, e.department].filter(Boolean).join(' · ')}\n\nЗаметки о сотруднике — на панели обратных ссылок.\n`;
}

function turndown(resolve: (kind: string, id: number, label: string) => string) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  const attr = (n: any, a: string) => (n.getAttribute ? n.getAttribute(a) : null);
  td.addRule('mention', {
    filter: (n) => n.nodeName === 'SPAN' && attr(n, 'data-type') === 'mention',
    replacement: (content, n) => {
      const kind = KIND[attr(n, 'data-mention-suggestion-char') || '@'];
      const id = Number(attr(n, 'data-id'));
      const label = attr(n, 'data-label') || content;
      return kind && id > 0 ? resolve(kind, id, label) : content;
    },
  });
  // Пункты списков без лишних пробелов и пустых строк. Чек-листы Tiptap:
  // <li data-type="taskItem" data-checked><label><input></label><div>…</div></li>
  td.addRule('taskLabel', { filter: (n) => n.nodeName === 'LABEL' && attr(n.parentNode, 'data-type') === 'taskItem', replacement: () => '' });
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, n) => {
      const parent = n.parentNode as any;
      let prefix = '- ';
      if (attr(n, 'data-type') === 'taskItem') prefix = `- [${attr(n, 'data-checked') === 'true' ? 'x' : ' '}] `;
      else if (parent?.nodeName === 'OL') {
        const start = Number(attr(parent, 'start')) || 1;
        prefix = `${start + Array.prototype.indexOf.call(parent.children, n)}. `;
      }
      const text = content.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n/gm, '\n    ');
      return prefix + text + (n.nextSibling ? '\n' : '');
    },
  });
  td.addRule('mark', { filter: 'mark', replacement: (c) => (c ? `==${c}==` : '') });
  td.addRule('strike', { filter: ['s', 'del'], replacement: (c) => (c ? `~~${c}~~` : '') });
  td.keep(['u']);
  return td;
}

// ---------- Настройки выгрузки ----------
export interface VaultState { enabled: boolean; lastAt: string | null; files: number; error: string | null }
export function vaultState(userId: number): VaultState {
  const raw = getMeta(`vault:${userId}`);
  return { enabled: false, lastAt: null, files: 0, error: null, ...(raw ? JSON.parse(raw) : {}) };
}
const saveState = (userId: number, s: VaultState) => setMeta(`vault:${userId}`, JSON.stringify(s));
export function setVaultEnabled(userId: number, enabled: boolean) {
  saveState(userId, { ...vaultState(userId), enabled });
  if (enabled) exportToDir(userId);
  return vaultState(userId);
}

export function userVaultDir(userId: number) {
  const login = q.get<{ login: string }>('SELECT login FROM users WHERE id = ?', userId)?.login || '';
  return path.join(VAULT_DIR, safeName(login, `user-${userId}`));
}

/** Записать хранилище в папку на сервере. Удаляет только файлы, которые сама записала раньше. */
export function exportToDir(userId: number) {
  const dir = userVaultDir(userId);
  const st = vaultState(userId);
  try {
    const files = buildVault(userId);
    const manifestPath = path.join(dir, MANIFEST);
    let prev: string[] = [];
    try {
      prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || [];
    } catch {
      /* первая выгрузка */
    }
    for (const [rel, content] of files) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      let cur: string | null = null;
      try {
        cur = fs.readFileSync(full, 'utf8');
      } catch {
        /* нового файла ещё нет */
      }
      if (cur !== content) fs.writeFileSync(full, content);
    }
    for (const rel of prev) {
      if (files.has(rel)) continue;
      // unlinkSync, а не rmSync: rmSync в Node 24 на Windows молча не удаляет файлы с кириллицей в пути
      try {
        fs.unlinkSync(path.join(dir, rel));
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ files: [...files.keys()] }, null, 1));
    saveState(userId, { ...st, lastAt: new Date().toISOString(), files: files.size, error: null });
  } catch (e: any) {
    console.error('Выгрузка заметок:', e);
    saveState(userId, { ...st, error: e?.message || String(e) });
  }
}

const timers = new Map<number, NodeJS.Timeout>();
/** Выгрузить через пару секунд после изменений (серия правок — одна выгрузка) */
export function scheduleVaultExport(userId: number) {
  if (!vaultState(userId).enabled) return;
  clearTimeout(timers.get(userId));
  timers.set(userId, setTimeout(() => {
    timers.delete(userId);
    exportToDir(userId);
  }, 2000));
}

// Раз в час обновляем карточки задач: статусы и сроки меняются в Б24 без правок заметок
setInterval(() => {
  for (const { id } of q.all<{ id: number }>('SELECT id FROM users')) if (vaultState(id).enabled) exportToDir(id);
}, 3600e3).unref();

// ---------- ZIP без внешних библиотек ----------
function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(files: Map<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
