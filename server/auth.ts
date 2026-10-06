// Авторизация: пользователи с логином и паролем, сессии в cookie, восстановление пароля по почте.
import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { q, claimOrphans } from './db.ts';

export interface User { id: number; login: string; email: string | null; name: string | null; role: 'admin' | 'user'; theme: 'auto' | 'light' | 'dark' }

const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const MIN_PASSWORD = 8;
/** WEB_SETUP=false — первый пользователь создаётся только командой npm run create-user (для сервера в интернете) */
const WEB_SETUP = process.env.WEB_SETUP !== 'false';
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
const publicUser = (u: any): User => ({ id: u.id, login: u.login, email: u.email, name: u.name, role: u.role === 'admin' ? 'admin' : 'user', theme: u.theme || 'auto' });

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

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user?.role !== 'admin') return res.status(403).json({ error: 'Доступно только администратору' });
  next();
}

const usersCount = () => q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
const adminsCount = () => q.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")!.n;

/** Создать пользователя. Первый пользователь — администратор и забирает данные прежней версии. */
export function createUser(f: { login: string; email?: string | null; name?: string | null; passwordHash: string; role?: 'admin' | 'user' }) {
  const first = usersCount() === 0;
  const r = q.run(
    'INSERT INTO users(login, email, name, password_hash, role) VALUES(?,?,?,?,?)',
    f.login, f.email || null, f.name || null, f.passwordHash, first ? 'admin' : f.role === 'admin' ? 'admin' : 'user',
  );
  const id = Number(r.lastInsertRowid);
  if (first) claimOrphans(id);
  return id;
}

/** Удалить пользователя вместе с его областью работы */
function deleteUserData(id: number) {
  q.tx(() => {
    q.run('DELETE FROM absence_shifts WHERE absence_id IN (SELECT id FROM absences WHERE user_id = ?)', id);
    q.run('DELETE FROM notes WHERE tab_id IN (SELECT id FROM note_tabs WHERE user_id = ?)', id);
    for (const t of ['absences', 'note_tabs', 'employees', 'departments', 'queue', 'alerts', 'task_notify', 'push_subscriptions', 'sessions', 'password_resets']) {
      q.run(`DELETE FROM ${t} WHERE user_id = ?`, id);
    }
    q.run('DELETE FROM users WHERE id = ?', id);
  });
}

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
  const noUsers = usersCount() === 0;
  res.json({ user: currentUser(req), needsSetup: noUsers && WEB_SETUP, noUsers, mailConfigured: mailConfigured() });
});

/** Первый запуск: создание первого пользователя (только пока пользователей нет) */
authApi.post('/auth/setup', (req, res) => {
  if (usersCount() > 0) throw new AuthError(403, 'Первый пользователь уже создан');
  if (!WEB_SETUP) throw new AuthError(403, 'Создание пользователя через сайт отключено. Используйте npm run create-user на сервере.');
  const b = req.body || {};
  const login = String(b.login || '').trim();
  if (!/^[\w.@-]{3,50}$/.test(login)) throw new AuthError(400, 'Логин: 3–50 символов, латиница, цифры, . _ @ -');
  const password = checkPasswordStrength(b.password);
  const id = createUser({ login, email: String(b.email || '').trim(), name: String(b.name || '').trim(), passwordHash: hashPassword(password) });
  startSession(req, res, id);
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
const me = (req: Request) => (req as any).user as User;
const validLogin = (v: unknown) => {
  const login = String(v || '').trim();
  if (!/^[\w.@-]{3,50}$/.test(login)) throw new AuthError(400, 'Логин: 3–50 символов, латиница, цифры, . _ @ -');
  return login;
};

/** Свой профиль: имя и почта */
usersApi.put('/users-me', (req, res) => {
  q.run('UPDATE users SET name = ?, email = ? WHERE id = ?', String(req.body?.name || '').trim() || null, String(req.body?.email || '').trim() || null, me(req).id);
  res.json({ ok: true });
});

usersApi.get('/users', requireAdmin, (req, res) => {
  res.json({
    me: me(req),
    users: q.all(
      `SELECT u.id, u.login, u.email, u.name, u.role, u.created_at,
         (SELECT COUNT(*) FROM departments d WHERE d.user_id = u.id) AS departments,
         (SELECT COUNT(*) FROM employees e WHERE e.user_id = u.id) AS employees
       FROM users u ORDER BY u.id`,
    ),
    mailConfigured: mailConfigured(),
  });
});

usersApi.post('/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  const login = validLogin(b.login);
  if (q.get('SELECT id FROM users WHERE login = ?', login)) throw new AuthError(409, 'Такой логин уже есть');
  const password = checkPasswordStrength(b.password);
  createUser({ login, email: String(b.email || '').trim(), name: String(b.name || '').trim(), passwordHash: hashPassword(password), role: b.role });
  res.json({ ok: true });
});

usersApi.put('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = q.get<any>('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new AuthError(404, 'Пользователь не найден');
  const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'user' ? 'user' : u.role;
  if (u.role === 'admin' && role !== 'admin' && adminsCount() <= 1) throw new AuthError(400, 'Нельзя снять роль с последнего администратора');
  q.run('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?', String(req.body?.name ?? u.name ?? '').trim() || null, String(req.body?.email ?? u.email ?? '').trim() || null, role, id);
  res.json({ ok: true });
});

usersApi.delete('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === me(req).id) throw new AuthError(400, 'Нельзя удалить самого себя');
  const u = q.get<any>('SELECT role FROM users WHERE id = ?', id);
  if (u?.role === 'admin' && adminsCount() <= 1) throw new AuthError(400, 'Нельзя удалить последнего администратора');
  deleteUserData(id);
  res.json({ ok: true });
});

/** Ссылка для установки пароля — администратор передаёт её пользователю (если почта не настроена) */
usersApi.post('/users/:id/reset-link', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!q.get('SELECT id FROM users WHERE id = ?', id)) throw new AuthError(404, 'Пользователь не найден');
  res.json({ link: createResetLink(id), minutes: RESET_MINUTES });
});

usersApi.put('/users-me/password', (req, res) => {
  const self = me(req);
  const u = q.get<any>('SELECT * FROM users WHERE id = ?', self.id);
  if (!u || !verifyPassword(String(req.body?.current || ''), u.password_hash)) throw new AuthError(400, 'Текущий пароль указан неверно');
  const password = checkPasswordStrength(req.body?.password);
  q.tx(() => {
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), self.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', self.id); // остальные устройства выйдут
  });
  startSession(req, res, self.id);
  res.json({ ok: true });
});

/** Ошибки авторизации → JSON с нужным статусом */
export function authErrors(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
  next(err);
}
