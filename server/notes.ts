import { Router } from 'express';
import { q } from './db.ts';
import { runRulesFor } from './alerts.ts';
import { ABSENCE_NAMES, isYmd, mskParts, todayYmd } from './calendar.ts';
import { SCOPE_SQL } from './scope.ts';
import { STATUS_NAMES } from './sync.ts';
import { buildVault, exportToDir, noteLabel, scheduleVaultExport, setVaultEnabled, userVaultDir, vaultState, zip } from './vault.ts';

export const notesApi = Router();

class BadRequest extends Error {
  status = 400;
}

const MAX_CONTENT = 500_000;
const now = () => new Date().toISOString();
const uid = (req: any) => req.user.id as number;

function ownTab(userId: number, id: number) {
  if (!q.get('SELECT id FROM note_tabs WHERE id = ? AND user_id = ?', id, userId)) throw new BadRequest('Таб не найден');
  return id;
}
function ownNote(userId: number, id: number) {
  if (!q.get('SELECT n.id FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE n.id = ? AND t.user_id = ?', id, userId)) throw new BadRequest('Заметка не найдена');
  return id;
}
/** Таб по названию; если такого нет — создаётся последним */
function ensureTab(userId: number, title: string) {
  const ex = q.get<{ id: number }>('SELECT id FROM note_tabs WHERE user_id = ? AND title = ?', userId, title);
  if (ex) return ex.id;
  const last = q.get<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM note_tabs WHERE user_id = ?', userId)!.m;
  return Number(q.run('INSERT INTO note_tabs(user_id, title, sort_order) VALUES(?,?,?)', userId, title, last + 1).lastInsertRowid);
}

const tabRow = (id: number) =>
  q.get(`SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id AND n.done = 0) AS open_count,
           (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id) AS total_count FROM note_tabs t WHERE t.id = ?`, id);

// ---------- Упоминания ----------
// В HTML редактора упоминание — <span data-type="mention" data-id data-label data-mention-suggestion-char>.
// Символ определяет, на что ссылка: # задача, @ сотрудник, [[ заметка.
const KIND: Record<string, 'task' | 'employee' | 'note'> = { '#': 'task', '@': 'employee', '[[': 'note' };
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function parseMentions(html: string) {
  const out = new Map<string, { kind: string; id: number; label: string | null }>();
  for (const m of html.matchAll(/<span\b[^>]*\bdata-type="mention"[^>]*>/g)) {
    const attr = (name: string) => {
      const r = m[0].match(new RegExp(`\\s${name}="([^"]*)"`));
      return r ? decode(r[1]) : null;
    };
    const kind = KIND[attr('data-mention-suggestion-char') || '@'];
    const id = Number(attr('data-id'));
    if (kind && Number.isInteger(id) && id > 0) out.set(`${kind}:${id}`, { kind, id, label: attr('data-label') });
  }
  return [...out.values()];
}

function syncLinks(userId: number, noteId: number, html: string) {
  q.run('DELETE FROM note_links WHERE note_id = ?', noteId);
  for (const l of parseMentions(html)) {
    if (l.kind === 'note' && (l.id === noteId || !q.get('SELECT 1 FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE n.id = ? AND t.user_id = ?', l.id, userId))) continue;
    q.run('INSERT OR IGNORE INTO note_links(note_id, kind, target_id, label) VALUES(?,?,?,?)', noteId, l.kind, l.id, l.label);
  }
}

/** Упоминание для HTML, который собирает сервер (заметка дня) */
function mentionHtml(char: '#' | '@' | '[[', id: number, label: string) {
  const text = char === '#' ? `#${id} ${label}` : label;
  return `<span data-type="mention" data-id="${id}" data-label="${escHtml(label)}" data-mention-suggestion-char="${char}">${escHtml(text)}</span>`;
}
const htmlToText = (html: string) =>
  decode(html.replace(/<\/(p|li|h[1-6]|ul|ol|blockquote|pre)>/g, '\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{2,}/g, '\n').trim();

function deleteNotes(where: string, ...params: unknown[]) {
  const ids = q.all<{ id: number }>(`SELECT id FROM notes WHERE ${where}`, ...params).map((r) => r.id);
  if (!ids.length) return;
  const list = JSON.stringify(ids);
  q.run('DELETE FROM alerts WHERE note_id IN (SELECT value FROM json_each(?))', list);
  q.run("DELETE FROM note_links WHERE note_id IN (SELECT value FROM json_each(?)) OR (kind = 'note' AND target_id IN (SELECT value FROM json_each(?)))", list, list);
  q.run('DELETE FROM notes WHERE id IN (SELECT value FROM json_each(?))', list);
}

// ---------- Табы ----------
notesApi.get('/notes/tabs', (req, res) => {
  res.json(q.all(
    `SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id AND n.done = 0) AS open_count,
       (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id) AS total_count
     FROM note_tabs t WHERE t.user_id = ? ORDER BY t.sort_order, t.id`, uid(req),
  ));
});

notesApi.post('/notes/tabs', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) throw new BadRequest('Введите название таба');
  const last = q.get<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM note_tabs WHERE user_id = ?', uid(req))!.m;
  const r = q.run('INSERT INTO note_tabs(user_id, title, color, sort_order) VALUES(?,?,?,?)', uid(req), title.slice(0, 80), req.body?.color || null, last + 1);
  res.json(tabRow(Number(r.lastInsertRowid)));
});

notesApi.put('/notes/tabs/:id', (req, res) => {
  const id = ownTab(uid(req), Number(req.params.id));
  const title = String(req.body?.title || '').trim();
  if (!title) throw new BadRequest('Введите название таба');
  q.run('UPDATE note_tabs SET title = ?, color = ? WHERE id = ?', title.slice(0, 80), req.body?.color || null, id);
  scheduleVaultExport(uid(req));
  res.json(tabRow(id));
});

notesApi.delete('/notes/tabs/:id', (req, res) => {
  const id = ownTab(uid(req), Number(req.params.id));
  q.tx(() => {
    deleteNotes('tab_id = ?', id);
    q.run('DELETE FROM note_tabs WHERE id = ?', id);
  });
  scheduleVaultExport(uid(req));
  res.json({ ok: true });
});

notesApi.put('/notes/tabs-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE note_tabs SET sort_order = ? WHERE id = ? AND user_id = ?', i + 1, id, uid(req))));
  res.json({ ok: true });
});

// ---------- Подсказки для упоминаний ----------
notesApi.get('/notes/suggest', (req, res) => {
  const u = uid(req);
  const kind = String(req.query.kind);
  const s = String(req.query.q || '').trim().toLowerCase();
  const hit = (text: string | null) => !s || (text || '').toLowerCase().includes(s);
  const LIMIT = 8;
  if (kind === 'employee') {
    return res.json(q.all<any>('SELECT id, name, position, department FROM employees WHERE user_id = ? ORDER BY sort_order, name', u)
      .filter((e) => hit(e.name)).slice(0, LIMIT)
      .map((e) => ({ id: e.id, label: e.name, sub: e.position || e.department || '' })));
  }
  if (kind === 'task') {
    // Сначала открытые и недавно изменённые; число — поиск по началу ID
    const rows = q.all<any>(
      `SELECT t.id, t.title, t.status, t.responsible_name FROM tasks t WHERE ${SCOPE_SQL()}
       ORDER BY (t.status IN (5,7)), t.changed_date DESC`, u, u,
    );
    const byId = /^\d+$/.test(s);
    return res.json(rows.filter((t) => (byId ? String(t.id).startsWith(s) : hit(t.title))).slice(0, LIMIT)
      .map((t) => ({ id: t.id, label: t.title, sub: [STATUS_NAMES[t.status], t.responsible_name].filter(Boolean).join(' · ') })));
  }
  if (kind === 'note') {
    const except = Number(req.query.except) || 0;
    return res.json(q.all<any>(
      `SELECT n.id, n.title, n.content_text, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id
       WHERE t.user_id = ? AND n.id != ? ORDER BY n.done, n.updated_at DESC`, u, except,
    ).map((n) => ({ id: n.id, label: noteLabel(n), sub: n.tab_title })).filter((n) => hit(n.label)).slice(0, LIMIT));
  }
  throw new BadRequest('Неизвестный тип подсказки');
});

// ---------- Граф связей ----------
notesApi.get('/notes/graph', (req, res) => {
  const u = uid(req);
  const notes = q.all<any>(
    `SELECT n.id, n.title, n.content_text, n.color, n.done, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE t.user_id = ?`, u,
  ).map((n) => ({ id: n.id, label: noteLabel(n), color: n.color, done: !!n.done, tab: n.tab_title }));
  const links = q.all<any>(
    'SELECT l.note_id, l.kind, l.target_id, l.label FROM note_links l JOIN notes n ON n.id = l.note_id JOIN note_tabs t ON t.id = n.tab_id WHERE t.user_id = ?', u,
  );
  const ids = (kind: string) => JSON.stringify([...new Set(links.filter((l) => l.kind === kind).map((l) => l.target_id))]);
  const tasks = q.all('SELECT id, title, status FROM tasks WHERE id IN (SELECT value FROM json_each(?))', ids('task'));
  const employees = q.all('SELECT id, name FROM employees WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))', u, ids('employee'));
  res.json({ notes, links, tasks, employees });
});

// ---------- Заметка дня ----------
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const fmtYmd = (ymd: string) => ymd.split('-').reverse().join('.');

function dailyHtml(userId: number, day: string) {
  const parts: string[] = [];
  const hasEmployees = !!q.get('SELECT 1 FROM employees WHERE user_id = ?', userId);
  if (hasEmployees) {
    const away = q.all<any>(
      `SELECT a.type, a.date_to, e.id, e.name FROM absences a JOIN employees e ON e.id = a.employee_id AND e.user_id = a.user_id
       WHERE a.user_id = ? AND a.date_from <= ? AND a.date_to >= ? ORDER BY e.name`, userId, day, day,
    );
    const list = away.map((a) => `${mentionHtml('@', a.id, a.name)} (${(ABSENCE_NAMES[a.type] || a.type).toLowerCase()} до ${fmtYmd(a.date_to)})`);
    parts.push(`<p><strong>Отсутствуют:</strong> ${list.length ? list.join(', ') : 'все на месте'}</p>`);
  }
  const open = q.all<any>(
    `SELECT t.id, t.title, t.deadline FROM tasks t WHERE t.status NOT IN (4,5,6,7) AND t.deadline IS NOT NULL AND ${SCOPE_SQL()} ORDER BY t.deadline`,
    userId, userId,
  );
  const block = (title: string, rows: any[]) => {
    if (!rows.length) return;
    const more = rows.length > 10 ? `<li><p>…и ещё ${rows.length - 10}</p></li>` : '';
    parts.push(`<p><strong>${title}:</strong></p><ul>${rows.slice(0, 10).map((t) => `<li><p>${mentionHtml('#', t.id, t.title)}</p></li>`).join('')}${more}</ul>`);
  };
  block('Срок сегодня', open.filter((t) => mskParts(t.deadline).ymd === day));
  block('Просрочено', open.filter((t) => mskParts(t.deadline).ymd < day));
  parts.push('<p><strong>План на день:</strong></p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>');
  return parts.join('');
}

notesApi.post('/notes/daily', (req, res) => {
  const u = uid(req);
  const day = todayYmd();
  const ex = q.get('SELECT n.* FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE t.user_id = ? AND n.daily_on = ?', u, day);
  if (ex) return res.json(parseNote(ex));
  const id = q.tx(() => {
    const tabId = ensureTab(u, 'Дневник');
    const html = dailyHtml(u, day);
    const title = `${fmtYmd(day)}, ${WEEKDAYS[new Date(day + 'T12:00:00Z').getUTCDay()]}`;
    q.run('UPDATE notes SET sort_order = sort_order + 1 WHERE tab_id = ?', tabId);
    const r = q.run(
      `INSERT INTO notes(tab_id, title, content, content_text, daily_on, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,0,?,?)`,
      tabId, title, html, htmlToText(html), day, now(), now(),
    );
    const noteId = Number(r.lastInsertRowid);
    syncLinks(u, noteId, html);
    return noteId;
  });
  scheduleVaultExport(u);
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

// ---------- Выгрузка в Markdown (Obsidian) ----------
notesApi.get('/notes/vault', (req, res) => {
  res.json({ ...vaultState(uid(req)), dir: userVaultDir(uid(req)) });
});
notesApi.put('/notes/vault', (req, res) => {
  setVaultEnabled(uid(req), !!req.body?.enabled);
  res.json({ ...vaultState(uid(req)), dir: userVaultDir(uid(req)) });
});
notesApi.post('/notes/vault/export', (req, res) => {
  exportToDir(uid(req));
  res.json({ ...vaultState(uid(req)), dir: userVaultDir(uid(req)) });
});
notesApi.get('/notes/export.zip', (req, res) => {
  const files = buildVault(uid(req));
  const prefixed = new Map([...files].map(([p, c]) => [`Заметки из кабинета/${p}`, c]));
  const name = `заметки-${todayYmd()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${todayYmd()}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(zip(prefixed));
});

// ---------- Заметки ----------
const parseNote = (n: any) => n && { ...n, pinned: !!n.pinned, done: !!n.done };
const LIST_SQL = `SELECT n.*, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id`;

/** Запрос к FTS5: каждое слово — префикс («хостинг» найдёт «хостинга») */
const ftsQuery = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8).map((w) => `"${w}"*`).join(' ');

/** Список: по табу, по связи (link=task:ID | employee:ID | note:ID) или поиск по всем табам (q) */
notesApi.get('/notes', (req, res) => {
  const u = uid(req);
  const search = String(req.query.q || '').trim();
  if (search) {
    const fts = ftsQuery(search);
    if (fts) {
      // \u0001 и \u0002 — границы совпадения в отрывке: клиент заменит их на <mark> после экранирования
      return res.json(q.all(
        `SELECT n.*, t.title AS tab_title, snippet(notes_fts, 1, char(1), char(2), '…', 14) AS snippet
         FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid JOIN note_tabs t ON t.id = n.tab_id
         WHERE notes_fts MATCH ? AND t.user_id = ? ORDER BY n.done, notes_fts.rank LIMIT 200`, fts, u,
      ).map(parseNote));
    }
    const low = search.toLowerCase();
    const rows = q.all<any>(`${LIST_SQL} WHERE t.user_id = ? ORDER BY n.done, n.pinned DESC, n.updated_at DESC`, u);
    return res.json(rows.filter((n) => `${n.title || ''} ${n.content_text}`.toLowerCase().includes(low)).map(parseNote));
  }
  const link = String(req.query.link || '').match(/^(task|employee|note):(\d+)$/);
  if (link) {
    return res.json(q.all(
      `${LIST_SQL} JOIN note_links l ON l.note_id = n.id WHERE t.user_id = ? AND l.kind = ? AND l.target_id = ?
       ORDER BY n.done, n.updated_at DESC`, u, link[1], Number(link[2]),
    ).map(parseNote));
  }
  const tab = Number(req.query.tab);
  res.json(q.all(`${LIST_SQL} WHERE n.tab_id = ? AND t.user_id = ? ORDER BY n.done, n.pinned DESC, n.sort_order, n.id DESC`, tab, u).map(parseNote));
});

notesApi.get('/notes/:id', (req, res) => {
  const n = q.get(`${LIST_SQL} WHERE n.id = ? AND t.user_id = ?`, Number(req.params.id), uid(req));
  if (!n) throw new BadRequest('Заметка не найдена');
  res.json(parseNote(n));
});

function fields(userId: number, b: any) {
  const tabId = ownTab(userId, Number(b.tab_id));
  const content = String(b.content ?? '');
  if (content.length > MAX_CONTENT) throw new BadRequest('Слишком длинный текст заметки');
  const title = String(b.title || '').trim().slice(0, 200) || null;
  const text = String(b.content_text ?? '').slice(0, MAX_CONTENT);
  if (!title && !text.trim()) throw new BadRequest('Заметка пустая');
  const remind = b.remind_on ? String(b.remind_on) : null;
  if (remind && !isYmd(remind)) throw new BadRequest('Некорректная дата напоминания');
  return { tabId, title, content, text, color: b.color || null, pinned: !!b.pinned, done: !!b.done, remind };
}

notesApi.post('/notes', (req, res) => {
  const u = uid(req);
  const f = fields(u, req.body || {});
  const id = q.tx(() => {
    // Новая заметка — первой в табе
    q.run('UPDATE notes SET sort_order = sort_order + 1 WHERE tab_id = ?', f.tabId);
    const r = q.run(
      `INSERT INTO notes(tab_id, title, content, content_text, color, pinned, done, remind_on, sort_order, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,0,?,?)`,
      f.tabId, f.title, f.content, f.text, f.color, f.pinned, f.done, f.remind, now(), now(),
    );
    const noteId = Number(r.lastInsertRowid);
    syncLinks(u, noteId, f.content);
    return noteId;
  });
  runRulesFor(u);
  scheduleVaultExport(u);
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

notesApi.put('/notes/:id', (req, res) => {
  const u = uid(req);
  const id = ownNote(u, Number(req.params.id));
  const f = fields(u, req.body || {});
  q.tx(() => {
    q.run(
      `UPDATE notes SET tab_id=?, title=?, content=?, content_text=?, color=?, pinned=?, done=?, remind_on=?, updated_at=? WHERE id=?`,
      f.tabId, f.title, f.content, f.text, f.color, f.pinned, f.done, f.remind, now(), id,
    );
    syncLinks(u, id, f.content);
  });
  if (f.done) q.run('UPDATE alerts SET read_at = ? WHERE note_id = ? AND read_at IS NULL', now(), id);
  runRulesFor(u);
  scheduleVaultExport(u);
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

/** Быстрые флаги без пересохранения текста: pinned, done, color */
notesApi.patch('/notes/:id', (req, res) => {
  const id = ownNote(uid(req), Number(req.params.id));
  const b = req.body || {};
  if ('pinned' in b) q.run('UPDATE notes SET pinned = ? WHERE id = ?', !!b.pinned, id);
  if ('done' in b) {
    q.run('UPDATE notes SET done = ?, updated_at = ? WHERE id = ?', !!b.done, now(), id);
    if (b.done) q.run('UPDATE alerts SET read_at = ? WHERE note_id = ? AND read_at IS NULL', now(), id);
  }
  if ('color' in b) q.run('UPDATE notes SET color = ? WHERE id = ?', b.color || null, id);
  scheduleVaultExport(uid(req));
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

notesApi.delete('/notes/:id', (req, res) => {
  const id = ownNote(uid(req), Number(req.params.id));
  q.tx(() => deleteNotes('id = ?', id));
  scheduleVaultExport(uid(req));
  res.json({ ok: true });
});

notesApi.put('/notes-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE notes SET sort_order = ? WHERE id = ? AND tab_id IN (SELECT id FROM note_tabs WHERE user_id = ?)', i, id, uid(req))));
  res.json({ ok: true });
});

notesApi.use((err: any, _req: any, res: any, next: any) => (err instanceof BadRequest ? res.status(400).json({ error: err.message }) : next(err)));
