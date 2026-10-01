// Бэкап базы без остановки сервера: npm run backup [-- <папка>] [--migrate]
//   по умолчанию — полная копия в ./backup/app-ГГГГММДД-ЧЧММ.db
//   --migrate — копия для переезда на другой адрес: без push-подписок, сессий и токенов сброса пароля
//               (они привязаны к старому адресу сайта и на новом не работают)
// Восстановление: остановить сервер, положить файл как DB_PATH (по умолчанию ./data/app.db), запустить.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const src = process.env.DB_PATH || './data/app.db';
const args = process.argv.slice(2);
const migrate = args.includes('--migrate');
const outDir = args.find((a) => !a.startsWith('--')) || './backup';

if (!fs.existsSync(src)) {
  console.error(`База не найдена: ${src}`);
  process.exit(1);
}

const d = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `app-${stamp}${migrate ? '-migrate' : ''}.db`);
if (fs.existsSync(out)) {
  console.error(`Файл уже существует: ${out}`);
  process.exit(1);
}

// VACUUM INTO делает согласованный снимок даже при работающем сервере (WAL)
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();

const copy = new DatabaseSync(out);
if (migrate) {
  copy.exec('DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM password_resets;');
  copy.exec('VACUUM');
}
const check = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const count = (t: string) => {
  try {
    return (copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  } catch {
    return '—';
  }
};
const summary = {
  users: count('users'), employees: count('employees'), tasks: count('tasks'), absences: count('absences'),
  note_tabs: count('note_tabs'), notes: count('notes'), alerts: count('alerts'), push_subscriptions: count('push_subscriptions'),
  sessions: count('sessions'),
};
copy.close();

console.log(`Бэкап: ${path.resolve(out)} (${(fs.statSync(out).size / 1024).toFixed(0)} КБ)`);
console.log(`Проверка целостности: ${check}`);
console.log('Содержимое:', summary);
if (check !== 'ok') process.exit(2);
