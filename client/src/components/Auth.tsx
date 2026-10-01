import { useState } from 'react';
import { api } from '../api';

export interface AuthStatus {
  user: { id: number; login: string; name: string | null; email: string | null } | null;
  needsSetup: boolean;
  noUsers?: boolean;
  mailConfigured: boolean;
}

function AuthCard({ title, children, onSubmit }: { title: string; children: React.ReactNode; onSubmit: (e: React.FormEvent) => void }) {
  return (
    <div className="login">
      <form className="card login-card" onSubmit={onSubmit}>
        <img src="/favicon.svg" alt="" className="login-logo" />
        <h1>{title}</h1>
        {children}
      </form>
    </div>
  );
}

export function LoginScreen({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'forgot' | 'sent'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await api.post('/auth/login', { login, password });
        onDone();
      } else {
        const r = await api.post<{ message: string }>('/auth/forgot', { login });
        setInfo(r.message);
        setMode('sent');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'sent') {
    return (
      <AuthCard title="Проверьте почту" onSubmit={(e) => { e.preventDefault(); setMode('login'); }}>
        <p className="muted">{info}</p>
        <p className="muted small">Ссылка действует 1 час. Письмо может попасть в «Спам».</p>
        <button className="btn primary">Вернуться ко входу</button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={mode === 'login' ? 'Задачи отдела' : 'Восстановление пароля'} onSubmit={submit}>
      <label className="field">
        <span>{mode === 'login' ? 'Логин' : 'Логин или почта'}</span>
        <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
      </label>
      {mode === 'login' && (
        <label className="field">
          <span>Пароль</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
      )}
      {status.noUsers && (
        <div className="form-hint">
          Пользователей ещё нет. Создайте первого на сервере: <code>npm run create-user -- логин почта</code> — команда выдаст ссылку для установки пароля.
        </div>
      )}
      {mode === 'forgot' && !status.mailConfigured && (
        <div className="form-hint">
          Отправка почты не настроена. Попросите администратора сервера выполнить
          <code>npm run reset-password -- {login || 'логин'}</code> — команда выдаст ссылку для нового пароля.
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {mode === 'login' ? (
        <>
          <button className="btn primary" disabled={busy}>Войти</button>
          <button type="button" className="link center" onClick={() => { setMode('forgot'); setError(''); }}>Забыли пароль?</button>
        </>
      ) : (
        <>
          <button className="btn primary" disabled={busy || !status.mailConfigured}>Отправить ссылку на почту</button>
          <button type="button" className="link center" onClick={() => { setMode('login'); setError(''); }}>← Ко входу</button>
        </>
      )}
    </AuthCard>
  );
}

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ login: '', name: '', email: '', password: '', password2: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.password !== f.password2) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await api.post('/auth/setup', f);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Первый запуск" onSubmit={submit}>
      <p className="muted small">Создайте учётную запись администратора. Остальных пользователей можно добавить потом в «Настройках».</p>
      <label className="field"><span>Логин</span><input autoFocus autoComplete="username" value={f.login} onChange={set('login')} required /></label>
      <label className="field"><span>Имя</span><input value={f.name} onChange={set('name')} /></label>
      <label className="field"><span>Почта — для восстановления пароля</span><input type="email" autoComplete="email" value={f.email} onChange={set('email')} /></label>
      <label className="field"><span>Пароль (не короче 8 символов)</span><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={8} /></label>
      <label className="field"><span>Пароль ещё раз</span><input type="password" autoComplete="new-password" value={f.password2} onChange={set('password2')} required /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="btn primary" disabled={busy}>Создать и войти</button>
    </AuthCard>
  );
}

export function ResetScreen({ onDone }: { onDone: () => void }) {
  const token = new URLSearchParams(window.location.hash.split('?')[1] || '').get('token') || '';
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== password2) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await api.post('/auth/reset', { token, password });
      window.history.replaceState(null, '', '/#/kanban');
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Новый пароль" onSubmit={submit}>
      <label className="field"><span>Новый пароль (не короче 8 символов)</span><input type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
      <label className="field"><span>Ещё раз</span><input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="btn primary" disabled={busy}>Сохранить и войти</button>
      <a className="link center small" href="/#/kanban">← Ко входу</a>
    </AuthCard>
  );
}
