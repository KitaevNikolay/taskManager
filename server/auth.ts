// Авторизация: пользователи с логином и паролем, сессии в cookie, восстановление пароля по почте.
import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { q } from './db.ts';

export interface User { id: number; login: string; email: string | null; name: string | null }

const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const MIN_PASSWORD = 8;
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');

class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- Пароли ----------
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password: string, stored: string) {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordStrength(p: unknown): string {
  const s = String(p ?? '');
  if (s.length < MIN_PASSWORD) throw new AuthError(400, `Пароль должен быть не короче ${MIN_PASSWORD} символов`);
  if (s.length > 200) throw new AuthError(400, 'Слишком длинный пароль');
  return s;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = (u: any): User => ({ id: u.id, login: u.login, email: u.email, name: u.name });

// ---------- Сессии ----------
const COOKIE = 'sid';
const getToken = (req: Request) => new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '')?.[1];

function setCookie(req: Request, res: Response, token: string, maxAge: number) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function startSession(req: Request, res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  q.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha256(token), userId, expires);
  setCookie(req, res, token, SESSION_DAYS * 86400);
}

export function currentUser(req: Request): User | null {
  const token = getToken(req);
  if (!token) return null;
  const u = q.get<any>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token), new Date().toISOString(),
  );
  return u ? publicUser(u) : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  (req as any).user = user;
  next();
}

const usersCount = () => q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;

// ---------- Защита от перебора ----------
// 5 неудачных попыток на логин с одного IP — блокировка на 5 минут; 30 попыток с IP за 15 минут — на 15 минут
const fails = new Map<string, { n: number; first: number; until: number }>();
function guard(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const f = fails.get(key);
  if (f && f.until > now) {
    throw new AuthError(429, `Слишком много попыток. Повторите через ${Math.ceil((f.until - now) / 60000)} мин.`);
  }
  return {
    fail() {
      const cur = fails.get(key);
      const rec = cur && now - cur.first < windowMs ? cur : { n: 0, first: now, until: 0 };
      rec.n++;
      if (rec.n >= limit) rec.until = now + windowMs;
      fails.set(key, rec);
    },
    ok: () => fails.delete(key),
  };
}
const ip = (req: Request) => req.ip || req.socket.remoteAddress || '';

// ---------- Почта ----------
const SMTP_HOST = process.env.SMTP_HOST || '';
export const mailConfigured = () => !!SMTP_HOST;
const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    })
  : null;

/** Одноразовая ссылка на сброс пароля (действует RESET_MINUTES минут) */
export function createResetLink(userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_MINUTES * 60e3).toISOString();
  q.run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', userId, new Date().toISOString());
  q.run('INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES(?,?,?)', sha256(token), userId, expires);
  return `${APP_URL}/#/reset?token=${token}`;
}

async function sendResetEmail(user: any) {
  const link = createResetLink(user.id);
  await transport!.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'Восстановление пароля — Задачи отдела',
    text: `Здравствуйте${user.name ? ', ' + user.name : ''}!\n\nДля входа под логином «${user.login}» задайте новый пароль по ссылке (действует ${RESET_MINUTES} минут):\n${link}\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте письмо.`,
    html: `<p>Здравствуйте${user.name ? ', ' + escapeHtml(user.name) : ''}!</p>
<p>Для входа под логином «<b>${escapeHtml(user.login)}</b>» задайте новый пароль (ссылка действует ${RESET_MINUTES} минут):</p>
<p><a href="${link}">Задать новый пароль</a></p>
<p style="color:#888">Если вы не запрашивали восстановление, просто проигнорируйте письмо.</p>`,
  });
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- Публичные маршруты (без входа) ----------
export const authApi = Router();

authApi.get('/auth/status', (req, res) => {
  res.json({ user: currentUser(req), needsSetup: usersCount() === 0, mailConfigured: mailConfigured() });
});

/** Первый запуск: создание первого пользователя (только пока пользователей нет) */
authApi.post('/auth/setup', (req, res) => {
  if (usersCount() > 0) throw new AuthError(403, 'Первый пользователь уже создан');
  const b = req.body || {};
  const login = String(b.login || '').trim();
  if (!/^[\w.@-]{3,50}$/.test(login)) throw new AuthError(400, 'Логин: 3–50 символов, латиница, цифры, . _ @ -');
  const password = checkPasswordStrength(b.password);
  const r = q.run('INSERT INTO users(login, email, name, password_hash) VALUES(?,?,?,?)', login, String(b.email || '').trim() || null, String(b.name || '').trim() || null, hashPassword(password));
  startSession(req, res, Number(r.lastInsertRowid));
  res.json({ ok: true });
});

authApi.post('/auth/login', (req, res) => {
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  const perLogin = guard(`login:${ip(req)}:${login.toLowerCase()}`, 5, 5 * 60e3);
  const perIp = guard(`ip:${ip(req)}`, 30, 15 * 60e3);
  const u = q.get<any>('SELECT * FROM users WHERE login = ?', login);
  // Хэш считаем всегда, чтобы время ответа не выдавало существование логина
  const ok = verifyPassword(password, u?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!u || !ok) {
    perLogin.fail();
    perIp.fail();
    throw new AuthError(401, 'Неверный логин или пароль');
  }
  perLogin.ok();
  startSession(req, res, u.id);
  res.json({ ok: true });
});

authApi.post('/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

/** Запрос на восстановление: ответ всегда одинаковый, чтобы не раскрывать, есть ли такой пользователь */
authApi.post('/auth/forgot', async (req, res) => {
  if (!mailConfigured()) throw new AuthError(503, 'Отправка почты не настроена');
  const who = String(req.body?.login || '').trim();
  guard(`forgot:${ip(req)}`, 5, 15 * 60e3).fail();
  const u = who ? q.get<any>('SELECT * FROM users WHERE login = ? OR (email IS NOT NULL AND email = ? COLLATE NOCASE)', who, who) : null;
  if (u?.email) {
    try {
      await sendResetEmail(u);
    } catch (e: any) {
      console.error('[mail]', e?.message || e);
    }
  }
  res.json({ ok: true, message: 'Если такой пользователь есть и у него указана почта, мы отправили на неё ссылку для сброса пароля.' });
});

authApi.post('/auth/reset', (req, res) => {
  const token = String(req.body?.token || '');
  const password = checkPasswordStrength(req.body?.password);
  const row = /^[a-f0-9]{64}$/.test(token)
    ? q.get<{ user_id: number }>('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?', sha256(token), new Date().toISOString())
    : undefined;
  if (!row) throw new AuthError(400, 'Ссылка недействительна или устарела. Запросите восстановление ещё раз.');
  q.tx(() => {
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
    q.run('DELETE FROM password_resets WHERE user_id = ?', row.user_id);
    q.run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // выход на всех устройствах
  });
  // Владелец подтвердил доступ к аккаунту — снимаем блокировку входа по этому логину
  const login = q.get<{ login: string }>('SELECT login FROM users WHERE id = ?', row.user_id)?.login.toLowerCase();
  for (const key of fails.keys()) if (login && key.startsWith('login:') && key.endsWith(':' + login)) fails.delete(key);
  startSession(req, res, row.user_id);
  res.json({ ok: true });
});

// ---------- Пользователи (только после входа) ----------
export const usersApi = Router();

usersApi.get('/users', (req, res) => {
  res.json({ me: (req as any).user, users: q.all('SELECT id, login, email, name, created_at FROM users ORDER BY id'), mailConfigured: mailConfigured() });
});

usersApi.post('/users', (req, res) => {
  const b = req.body || {};
  const login = String(b.login || '').trim();
  if (!/^[\w.@-]{3,50}$/.test(login)) throw new AuthError(400, 'Логин: 3–50 символов, латиница, цифры, . _ @ -');
  if (q.get('SELECT id FROM users WHERE login = ?', login)) throw new AuthError(409, 'Такой логин уже есть');
  const password = checkPasswordStrength(b.password);
  q.run('INSERT INTO users(login, email, name, password_hash) VALUES(?,?,?,?)', login, String(b.email || '').trim() || null, String(b.name || '').trim() || null, hashPassword(password));
  res.json({ ok: true });
});

usersApi.put('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  q.run('UPDATE users SET name = ?, email = ? WHERE id = ?', String(req.body?.name || '').trim() || null, String(req.body?.email || '').trim() || null, id);
  res.json({ ok: true });
});

usersApi.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === (req as any).user.id) throw new AuthError(400, 'Нельзя удалить самого себя');
  q.run('DELETE FROM sessions WHERE user_id = ?', id);
  q.run('DELETE FROM password_resets WHERE user_id = ?', id);
  q.run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
});

usersApi.put('/users-me/password', (req, res) => {
  const me = (req as any).user as User;
  const u = q.get<any>('SELECT * FROM users WHERE id = ?', me.id);
  if (!u || !verifyPassword(String(req.body?.current || ''), u.password_hash)) throw new AuthError(400, 'Текущий пароль указан неверно');
  const password = checkPasswordStrength(req.body?.password);
  q.tx(() => {
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), me.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', me.id); // остальные устройства выйдут
  });
  startSession(req, res, me.id);
  res.json({ ok: true });
});

/** Ошибки авторизации → JSON с нужным статусом */
export function authErrors(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
  next(err);
}
