import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { authApi, authErrors, mailConfigured, requireAuth, usersApi } from './auth.ts';
import { q } from './db.ts';
import { api, HttpError, ScopeError } from './routes.ts';
import { BitrixError } from './bitrix.ts';
import { startSyncLoop } from './sync.ts';

const PORT = Number(process.env.PORT || 3001);

const HOST = process.env.HOST || '0.0.0.0';

const app = express();
// За reverse-proxy (nginx): реальный IP клиента и https берутся из X-Forwarded-*.
// Без этого защита от перебора паролей считает всех пользователей одним IP прокси.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v);
}
app.use(express.json({ limit: '1mb' }));

// ---------- Авторизация: вход, восстановление пароля — без сессии; остальное API — только после входа ----------
app.use('/api', authApi);
app.use('/api', requireAuth);
app.use('/api', usersApi);
app.use('/api', api);
app.use('/api', authErrors);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError || err instanceof ScopeError) return res.status(err.status).json({ error: err.message });
  if (err instanceof BitrixError) return res.status(502).json({ error: `Битрикс24: ${err.message}`, code: err.code });
  console.error(err);
  res.status(500).json({ error: err?.message || 'Внутренняя ошибка' });
});

// ---------- Статика собранного фронта ----------
const clientDir = path.resolve('dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(clientDir, 'index.html')) : next()));
}

app.listen(PORT, HOST, () => {
  const users = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  console.log(`Сервер: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (на всех интерфейсах)' : ''}`);
  if (!users) {
    console.log(process.env.WEB_SETUP === 'false'
      ? 'Пользователей нет — создайте первого: npm run create-user -- <логин> [почта]'
      : 'Пользователей нет — откройте сайт и создайте первого пользователя.');
  }
  if (!mailConfigured()) console.log('SMTP не настроен — восстановление пароля: npm run reset-password -- <логин>');
  startSyncLoop();
});
