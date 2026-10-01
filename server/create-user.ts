// Создание пользователя с сервера: npm run create-user -- <логин> [почта] [имя]
// Пароль не передаётся в командной строке: команда печатает одноразовую ссылку для его установки (действует 1 час).
import crypto from 'node:crypto';
import { q } from './db.ts';
import { createResetLink, hashPassword } from './auth.ts';

const [login, email, ...nameParts] = process.argv.slice(2);
if (!login || !/^[\w.@-]{3,50}$/.test(login)) {
  console.log('Использование: npm run create-user -- <логин> [почта] [имя]');
  console.log('Логин: 3–50 символов, латиница, цифры, . _ @ -');
  process.exit(1);
}
if (q.get('SELECT id FROM users WHERE login = ?', login)) {
  console.log(`Пользователь «${login}» уже есть. Сбросить пароль: npm run reset-password -- ${login}`);
  process.exit(1);
}
// Случайный пароль, который никто не знает — настоящий задаётся по ссылке
const r = q.run(
  'INSERT INTO users(login, email, name, password_hash) VALUES(?,?,?,?)',
  login, email || null, nameParts.join(' ') || null, hashPassword(crypto.randomBytes(24).toString('hex')),
);
console.log(`Пользователь «${login}» создан. Задайте пароль по ссылке (действует 1 час):`);
console.log(createResetLink(Number(r.lastInsertRowid)));
