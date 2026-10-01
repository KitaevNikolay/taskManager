import { Router } from 'express';
import { q } from './db.ts';
import { runRules } from './alerts.ts';
import { isYmd } from './calendar.ts';

export const notesApi = Router();

class BadRequest extends Error {
  status = 400;
}

const MAX_CONTENT = 500_000;
const now = () => new Date().toISOString();

const tabRow = (id: number) =>
  q.get(`SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id AND n.done = 0) AS open_count,
           (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id) AS total_count FROM note_tabs t WHERE t.id = ?`, id);

// ---------- Табы ----------
notesApi.get('/notes/tabs', (_req, res) => {
  res.json(q.all(
    `SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id AND n.done = 0) AS open_count,
       (SELECT COUNT(*) FROM notes n WHERE n.tab_id = t.id) AS total_count
     FROM note_tabs t ORDER BY t.sort_order, t.id`,
  ));
});

notesApi.post('/notes/tabs', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) throw new BadRequest('Введите название таба');
  const last = q.get<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM note_tabs')!.m;
  const r = q.run('INSERT INTO note_tabs(title, color, sort_order) VALUES(?,?,?)', title.slice(0, 80), req.body?.color || null, last + 1);
  res.json(tabRow(Number(r.lastInsertRowid)));
});

notesApi.put('/notes/tabs/:id', (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body?.title || '').trim();
  if (!title) throw new BadRequest('Введите название таба');
  q.run('UPDATE note_tabs SET title = ?, color = ? WHERE id = ?', title.slice(0, 80), req.body?.color || null, id);
  res.json(tabRow(id));
});

notesApi.delete('/notes/tabs/:id', (req, res) => {
  const id = Number(req.params.id);
  q.tx(() => {
    q.run('DELETE FROM alerts WHERE note_id IN (SELECT id FROM notes WHERE tab_id = ?)', id);
    q.run('DELETE FROM notes WHERE tab_id = ?', id);
    q.run('DELETE FROM note_tabs WHERE id = ?', id);
  });
  res.json({ ok: true });
});

notesApi.put('/notes/tabs-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE note_tabs SET sort_order = ? WHERE id = ?', i + 1, id)));
  res.json({ ok: true });
});

// ---------- Заметки ----------
const parseNote = (n: any) => n && { ...n, pinned: !!n.pinned, done: !!n.done };

/** Список: по табу или поиск по всем табам (q) */
notesApi.get('/notes', (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  if (search) {
    // LOWER в SQLite не знает кириллицу — фильтруем в JS
    const rows = q.all<any>(
      `SELECT n.*, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id ORDER BY n.done, n.pinned DESC, n.updated_at DESC`,
    );
    return res.json(rows.filter((n) => `${n.title || ''} ${n.content_text}`.toLowerCase().includes(search)).map(parseNote));
  }
  const tab = Number(req.query.tab);
  res.json(q.all(
    `SELECT n.*, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id
     WHERE n.tab_id = ? ORDER BY n.done, n.pinned DESC, n.sort_order, n.id DESC`, tab,
  ).map(parseNote));
});

notesApi.get('/notes/:id', (req, res) => {
  const n = q.get('SELECT n.*, t.title AS tab_title FROM notes n JOIN note_tabs t ON t.id = n.tab_id WHERE n.id = ?', Number(req.params.id));
  if (!n) throw new BadRequest('Заметка не найдена');
  res.json(parseNote(n));
});

function fields(b: any) {
  const tabId = Number(b.tab_id);
  if (!q.get('SELECT id FROM note_tabs WHERE id = ?', tabId)) throw new BadRequest('Таб не найден');
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
  const f = fields(req.body || {});
  // Новая заметка — первой в табе
  q.run('UPDATE notes SET sort_order = sort_order + 1 WHERE tab_id = ?', f.tabId);
  const r = q.run(
    `INSERT INTO notes(tab_id, title, content, content_text, color, pinned, done, remind_on, sort_order, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,0,?,?)`,
    f.tabId, f.title, f.content, f.text, f.color, f.pinned, f.done, f.remind, now(), now(),
  );
  runRules();
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', Number(r.lastInsertRowid))));
});

notesApi.put('/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.get('SELECT id FROM notes WHERE id = ?', id)) throw new BadRequest('Заметка не найдена');
  const f = fields(req.body || {});
  q.run(
    `UPDATE notes SET tab_id=?, title=?, content=?, content_text=?, color=?, pinned=?, done=?, remind_on=?, updated_at=? WHERE id=?`,
    f.tabId, f.title, f.content, f.text, f.color, f.pinned, f.done, f.remind, now(), id,
  );
  if (f.done) q.run("UPDATE alerts SET read_at = ? WHERE note_id = ? AND read_at IS NULL", now(), id);
  runRules();
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

/** Быстрые флаги без пересохранения текста: pinned, done, color */
notesApi.patch('/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('pinned' in b) q.run('UPDATE notes SET pinned = ? WHERE id = ?', !!b.pinned, id);
  if ('done' in b) {
    q.run('UPDATE notes SET done = ?, updated_at = ? WHERE id = ?', !!b.done, now(), id);
    if (b.done) q.run('UPDATE alerts SET read_at = ? WHERE note_id = ? AND read_at IS NULL', now(), id);
  }
  if ('color' in b) q.run('UPDATE notes SET color = ? WHERE id = ?', b.color || null, id);
  res.json(parseNote(q.get('SELECT * FROM notes WHERE id = ?', id)));
});

notesApi.delete('/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  q.run('DELETE FROM notes WHERE id = ?', id);
  q.run('DELETE FROM alerts WHERE note_id = ?', id);
  res.json({ ok: true });
});

notesApi.put('/notes-order', (req, res) => {
  const ids: number[] = (req.body?.ids || []).map(Number);
  q.tx(() => ids.forEach((id, i) => q.run('UPDATE notes SET sort_order = ? WHERE id = ?', i, id)));
  res.json({ ok: true });
});

notesApi.use((err: any, _req: any, res: any, next: any) => (err instanceof BadRequest ? res.status(400).json({ error: err.message }) : next(err)));
