// Восстановление доступа без почты: npm run reset-password -- <логин>
// Печатает одноразовую ссылку для установки нового пароля (действует 1 час).
import { q } from './db.ts';
import { createResetLink } from './auth.ts';

const login = process.argv[2];
const users = q.all<{ login: string; email: string | null }>('SELECT login, email FROM users ORDER BY id');

if (!users.length) {
  console.log('Пользователей ещё нет — откройте сайт, первый пользователь создаётся там.');
  process.exit(0);
}
if (!login) {
  console.log('Использование: npm run reset-password -- <логин>');
  console.log('Пользователи:', users.map((u) => u.login).join(', '));
  process.exit(1);
}
const u = q.get<{ id: number; login: string }>('SELECT id, login FROM users WHERE login = ?', login);
if (!u) {
  console.log(`Пользователь «${login}» не найден. Есть: ${users.map((x) => x.login).join(', ')}`);
  process.exit(1);
}
console.log(`Ссылка для нового пароля пользователя «${u.login}» (действует 1 час):`);
console.log(createResetLink(u.id));
