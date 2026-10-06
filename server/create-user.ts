// Создание пользователя с сервера: npm run create-user -- <логин> [почта] [имя] [--admin]
// Первый пользователь всегда становится администратором.
// Пароль не передаётся в командной строке: команда печатает одноразовую ссылку для его установки (действует 1 час).
import crypto from 'node:crypto';
import { q } from './db.ts';
import { createResetLink, createUser, hashPassword } from './auth.ts';

const args = process.argv.slice(2);
const asAdmin = args.includes('--admin');
const [login, email, ...nameParts] = args.filter((a) => a !== '--admin');
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
const id = createUser({
  login, email: email || null, name: nameParts.join(' ') || null,
  passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')), role: asAdmin ? 'admin' : 'user',
});
const role = q.get<{ role: string }>('SELECT role FROM users WHERE id = ?', id)!.role;
console.log(`Пользователь «${login}» создан (${role === 'admin' ? 'администратор' : 'пользователь'}). Задайте пароль по ссылке (действует 1 час):`);
console.log(createResetLink(id));
