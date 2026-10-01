import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';

interface U { id: number; login: string; email: string | null; name: string | null; created_at: string }

export function UsersSettings() {
  const { toast } = useApp();
  const [data, setData] = useState<{ me: U; users: U[]; mailConfigured: boolean } | null>(null);
  const [pw, setPw] = useState({ current: '', password: '', password2: '' });
  const [nu, setNu] = useState<{ login: string; name: string; email: string; password: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [editEmail, setEditEmail] = useState<{ id: number; email: string; name: string } | null>(null);

  const load = () => api.get<typeof data>('/users').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), []); // eslint-disable-line
  if (!data) return null;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.password !== pw.password2) return toast('Новые пароли не совпадают', 'error');
    try {
      await api.put('/users-me/password', { current: pw.current, password: pw.password });
      setPw({ current: '', password: '', password2: '' });
      toast('Пароль изменён. На других устройствах потребуется войти заново.', 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/users', nu);
      setNu(null);
      toast('Пользователь добавлен', 'ok');
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const saveUser = async () => {
    if (!editEmail) return;
    try {
      await api.put(`/users/${editEmail.id}`, { email: editEmail.email, name: editEmail.name });
      setEditEmail(null);
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/users/${id}`);
      setConfirmDel(null);
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="split settings-row">
      <form className="card form" onSubmit={changePassword}>
        <h3>Мой пароль</h3>
        <div className="muted small">Вы вошли как <b>{data.me.login}</b>{data.me.email ? ` · ${data.me.email}` : ''}</div>
        <input type="text" autoComplete="username" value={data.me.login} readOnly hidden />
        <label className="field"><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></label>
        <label className="field"><span>Новый пароль (не короче 8 символов)</span><input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required minLength={8} /></label>
        <label className="field"><span>Новый пароль ещё раз</span><input type="password" autoComplete="new-password" value={pw.password2} onChange={(e) => setPw({ ...pw, password2: e.target.value })} required /></label>
        <button className="btn primary">Сменить пароль</button>
      </form>

      <div className="card form">
        <div className="row between">
          <h3>Пользователи</h3>
          {!nu && <button className="btn sm" onClick={() => setNu({ login: '', name: '', email: '', password: '' })}>+ Пользователь</button>}
        </div>
        {!data.mailConfigured && (
          <div className="form-hint">
            Почта (SMTP) не настроена — «Забыли пароль?» не отправит письмо. Задайте SMTP_* в .env или используйте
            <code>npm run reset-password -- логин</code> на сервере.
          </div>
        )}
        {nu && (
          <form className="user-new" onSubmit={addUser}>
            <div className="row wrap">
              <input placeholder="Логин" value={nu.login} onChange={(e) => setNu({ ...nu, login: e.target.value })} required />
              <input placeholder="Имя" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
              <input type="email" placeholder="Почта" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
              <input type="password" autoComplete="new-password" placeholder="Временный пароль" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required minLength={8} />
            </div>
            <div className="row">
              <button className="btn primary sm">Добавить</button>
              <button type="button" className="btn ghost sm" onClick={() => setNu(null)}>Отмена</button>
            </div>
          </form>
        )}
        <table className="table">
          <thead><tr><th>Логин</th><th>Имя</th><th>Почта</th><th>Создан</th><th /></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.login}</b>{u.id === data.me.id && <span className="chip muted" style={{ marginLeft: 6 }}>вы</span>}</td>
                {editEmail?.id === u.id ? (
                  <>
                    <td><input value={editEmail.name} onChange={(e) => setEditEmail({ ...editEmail, name: e.target.value })} /></td>
                    <td><input type="email" value={editEmail.email} onChange={(e) => setEditEmail({ ...editEmail, email: e.target.value })} /></td>
                  </>
                ) : (
                  <>
                    <td>{u.name || <span className="muted">—</span>}</td>
                    <td>{u.email || <span className="muted">нет — не сможет восстановить пароль</span>}</td>
                  </>
                )}
                <td className="muted small">{fmtDateTime(u.created_at.replace(' ', 'T') + 'Z')}</td>
                <td className="actions">
                  {editEmail?.id === u.id ? (
                    <>
                      <button className="btn sm primary" onClick={saveUser}>OK</button>
                      <button className="btn ghost sm" onClick={() => setEditEmail(null)}>Отмена</button>
                    </>
                  ) : (
                    <button className="btn ghost sm" onClick={() => setEditEmail({ id: u.id, email: u.email || '', name: u.name || '' })}>Изменить</button>
                  )}
                  {u.id !== data.me.id && (confirmDel === u.id ? (
                    <button className="btn sm danger" onClick={() => remove(u.id)}>Точно удалить?</button>
                  ) : (
                    <button className="btn ghost sm danger" onClick={() => setConfirmDel(u.id)}>Удалить</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
