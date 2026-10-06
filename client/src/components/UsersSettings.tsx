import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';

interface U {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  role: 'admin' | 'user';
  created_at: string;
  departments: number;
  employees: number;
}

/** Свой профиль: имя, почта, пароль */
export function ProfileSettings() {
  const { user, toast } = useApp();
  const [profile, setProfile] = useState({ name: user.name || '', email: user.email || '' });
  const [pw, setPw] = useState({ current: '', password: '', password2: '' });

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.put('/users-me', profile);
      toast('Профиль сохранён', 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

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

  return (
    <div className="card form">
      <h3>Профиль</h3>
      <div className="muted small">
        Логин <b>{user.login}</b> · {user.role === 'admin' ? 'администратор' : 'пользователь'}
      </div>
      <form className="form" onSubmit={saveProfile}>
        <label className="field"><span>Имя</span><input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
        <label className="field"><span>Почта — для восстановления пароля</span><input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
        <button className="btn">Сохранить профиль</button>
      </form>
      <form className="form" onSubmit={changePassword}>
        <h3>Смена пароля</h3>
        <input type="text" autoComplete="username" value={user.login} readOnly hidden />
        <label className="field"><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></label>
        <label className="field"><span>Новый пароль (не короче 8 символов)</span><input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required minLength={8} /></label>
        <label className="field"><span>Новый пароль ещё раз</span><input type="password" autoComplete="new-password" value={pw.password2} onChange={(e) => setPw({ ...pw, password2: e.target.value })} required /></label>
        <button className="btn primary">Сменить пароль</button>
      </form>
    </div>
  );
}

/** Управление пользователями — только для администратора */
export function UsersAdmin() {
  const { toast, user: me } = useApp();
  const [data, setData] = useState<{ users: U[]; mailConfigured: boolean } | null>(null);
  const [nu, setNu] = useState<{ login: string; name: string; email: string; password: string; role: 'admin' | 'user' } | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ id: number; email: string; name: string; role: 'admin' | 'user' } | null>(null);
  const [link, setLink] = useState<{ login: string; link: string } | null>(null);

  const load = () => api.get<typeof data>('/users').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), []); // eslint-disable-line
  if (!data) return null;

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/users', nu);
      setNu(null);
      toast('Пользователь добавлен — у него своя пустая область: свои отделы и сотрудники', 'ok');
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const saveUser = async () => {
    if (!edit) return;
    try {
      await api.put(`/users/${edit.id}`, edit);
      setEdit(null);
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
  const resetLink = async (u: U) => {
    try {
      const r = await api.post<{ link: string }>(`/users/${u.id}/reset-link`);
      setLink({ login: u.login, link: r.link });
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="card form settings-row">
      <div className="row between">
        <h3>Пользователи</h3>
        {!nu && <button className="btn sm" onClick={() => setNu({ login: '', name: '', email: '', password: '', role: 'user' })}>+ Пользователь</button>}
      </div>
      <p className="muted small">
        У каждого пользователя своя область работы: свои отделы, сотрудники, очереди, отсутствия, заметки и алерты.
        Администратор дополнительно управляет пользователями и общими настройками.
      </p>
      {!data.mailConfigured && (
        <div className="form-hint">
          Почта (SMTP) не настроена — «Забыли пароль?» не отправит письмо. Ссылку для установки пароля можно выдать кнопкой «Ссылка для пароля».
        </div>
      )}
      {link && (
        <div className="form-hint ok">
          Ссылка для «{link.login}» (действует 1 час, одноразовая): <code className="link-code">{link.link}</code>
          <button className="btn xs" onClick={() => void navigator.clipboard?.writeText(link.link).then(() => toast('Скопировано', 'ok'))}>Копировать</button>
          <button className="btn ghost xs" onClick={() => setLink(null)}>✕</button>
        </div>
      )}
      {nu && (
        <form className="user-new" onSubmit={addUser}>
          <div className="row wrap">
            <input placeholder="Логин" value={nu.login} onChange={(e) => setNu({ ...nu, login: e.target.value })} required />
            <input placeholder="Имя" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
            <input type="email" placeholder="Почта" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
            <input type="password" autoComplete="new-password" placeholder="Временный пароль" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required minLength={8} />
            <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as 'admin' | 'user' })}>
              <option value="user">Пользователь</option>
              <option value="admin">Администратор</option>
            </select>
          </div>
          <div className="row">
            <button className="btn primary sm">Добавить</button>
            <button type="button" className="btn ghost sm" onClick={() => setNu(null)}>Отмена</button>
          </div>
        </form>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Логин</th><th>Имя</th><th>Почта</th><th>Роль</th><th>Область</th><th>Создан</th><th /></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.login}</b>{u.id === me.id && <span className="chip muted" style={{ marginLeft: 6 }}>вы</span>}</td>
                {edit?.id === u.id ? (
                  <>
                    <td><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></td>
                    <td><input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></td>
                    <td>
                      <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as 'admin' | 'user' })}>
                        <option value="user">Пользователь</option>
                        <option value="admin">Администратор</option>
                      </select>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{u.name || <span className="muted">—</span>}</td>
                    <td>{u.email || <span className="muted">нет — не сможет восстановить пароль сам</span>}</td>
                    <td>{u.role === 'admin' ? <span className="chip accent">администратор</span> : <span className="chip muted">пользователь</span>}</td>
                  </>
                )}
                <td className="muted small">{u.departments} отд. · {u.employees} сотр.</td>
                <td className="muted small">{fmtDateTime(u.created_at.replace(' ', 'T') + 'Z')}</td>
                <td className="actions">
                  {edit?.id === u.id ? (
                    <>
                      <button className="btn sm primary" onClick={saveUser}>OK</button>
                      <button className="btn ghost sm" onClick={() => setEdit(null)}>Отмена</button>
                    </>
                  ) : (
                    <>
                      <button className="btn ghost sm" onClick={() => setEdit({ id: u.id, email: u.email || '', name: u.name || '', role: u.role })}>Изменить</button>
                      <button className="btn ghost sm" onClick={() => resetLink(u)}>Ссылка для пароля</button>
                    </>
                  )}
                  {u.id !== me.id && (confirmDel === u.id ? (
                    <button className="btn sm danger" onClick={() => remove(u.id)}>Удалить вместе с данными?</button>
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
