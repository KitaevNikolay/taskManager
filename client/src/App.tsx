import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, relTime, type Alert, type Employee, type Meta } from './api';
import { EmployeesPage } from './pages/Employees';
import { KanbanPage } from './pages/Kanban';
import { QueuesPage } from './pages/Queues';
import { GanttPage } from './pages/Gantt';
import { AlertsPage } from './pages/Alerts';
import { SettingsPage } from './pages/Settings';
import { AbsencesPage } from './pages/Absences';
// Заметки тянут редактор (TipTap) — грузим отдельным чанком
const NotesPage = lazy(() => import('./pages/Notes').then((m) => ({ default: m.NotesPage })));
import { TaskDrawer } from './components/TaskDrawer';
import { currentSubscription, showLocal } from './push';
import { applyTheme, type ThemePref } from './theme';
import { LoginScreen, ResetScreen, SetupScreen, type AuthStatus } from './components/Auth';

type User = NonNullable<AuthStatus['user']>;

interface Ctx {
  user: User;
  isAdmin: boolean;
  meta: Meta | null;
  reloadMeta: () => void;
  employees: Employee[];
  reloadEmployees: () => void;
  /** Растёт при каждом изменении задач — страницы перезапрашивают данные */
  version: number;
  bump: () => void;
  openTask: (id: number) => void;
  toast: (text: string, tone?: 'error' | 'ok' | 'info') => void;
  unread: number;
  refreshUnread: () => void;
  warnHours: number;
  /** Этот браузер подписан на Web Push */
  pushActive: boolean;
  refreshPush: () => void;
}
const AppCtx = createContext<Ctx>(null!);
export const useApp = () => useContext(AppCtx);

const PAGES = [
  { id: 'kanban', title: 'Канбан', el: KanbanPage },
  { id: 'queues', title: 'Очереди', el: QueuesPage },
  { id: 'gantt', title: 'Гант', el: GanttPage },
  { id: 'absences', title: 'Отсутствия', el: AbsencesPage },
  { id: 'alerts', title: 'Алерты', el: AlertsPage },
  { id: 'notes', title: 'Заметки', el: NotesPage },
  { id: 'employees', title: 'Сотрудники', el: EmployeesPage },
  { id: 'settings', title: 'Кабинет', el: SettingsPage },
] as const;

function useHashRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'kanban';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const h = () => setRoute(read());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return route;
}

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [isReset, setIsReset] = useState(() => window.location.hash.startsWith('#/reset'));
  const load = useCallback(() => void api.get<AuthStatus>('/auth/status').then(setStatus).catch(() => setStatus({ user: null, needsSetup: false, mailConfigured: false })), []);
  useEffect(() => {
    load();
    const onUnauth = () => setStatus((s) => (s ? { ...s, user: null } : s));
    const onHash = () => setIsReset(window.location.hash.startsWith('#/reset'));
    window.addEventListener('unauthorized', onUnauth);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('unauthorized', onUnauth);
      window.removeEventListener('hashchange', onHash);
    };
  }, [load]);
  if (!status) return null;
  if (isReset) return <ResetScreen onDone={() => { setIsReset(false); load(); }} />;
  if (status.needsSetup) return <SetupScreen onDone={load} />;
  if (!status.user) return <LoginScreen status={status} onDone={load} />;
  return <Shell user={status.user} />;
}

interface Toast { id: number; text: string; tone: string }

function Shell({ user }: { user: User }) {
  const route = useHashRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const reloadMeta = useCallback(() => void api.get<Meta>('/meta').then(setMeta), []);
  // Тема из профиля пользователя важнее запомненной в браузере
  useEffect(() => applyTheme(user.theme), [user.theme]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [version, setVersion] = useState(0);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const [warnHours, setWarnHours] = useState(24);
  const toastId = useRef(0);
  const [pushActive, setPushActive] = useState(false);
  const pushRef = useRef(false);
  const refreshPush = useCallback(() => void currentSubscription().then((s) => { pushRef.current = !!s; setPushActive(!!s); }), []);

  const reloadEmployees = useCallback(() => void api.get<Employee[]>('/employees').then(setEmployees), []);
  const refreshUnread = useCallback(() => void api.get<{ unread: number }>('/alerts/count').then((r) => setUnread(r.unread)), []);
  const toast = useCallback((text: string, tone: string = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 5000);
  }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    reloadMeta();
    api.get<any>('/settings').then((s) => setWarnHours(s.deadlineWarnHours));
    reloadEmployees();
    refreshUnread();
    refreshPush();
  }, [reloadMeta, reloadEmployees, refreshUnread, refreshPush]);

  // Клик по оповещению: service worker просит открыть задачу; при открытии новой вкладки — ?task=ID
  useEffect(() => {
    const fromUrl = Number(new URLSearchParams(location.search).get('task'));
    if (fromUrl) {
      setTaskId(fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== 'open') return;
      if (e.data.taskId) setTaskId(e.data.taskId);
      else location.hash = e.data.url ? e.data.url.replace(/^\/?/, '').replace(/^#?/, '#') : '#/alerts';
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  // Алерты, пришедшие пачкой (например, после добавления отдела), показываем одним уведомлением
  const alertBuf = useRef<(Alert & { notify?: boolean })[]>([]);
  const alertTimer = useRef<number | null>(null);
  const queueAlertToast = useCallback((a: Alert) => {
    alertBuf.current.push(a);
    if (alertTimer.current) return;
    alertTimer.current = window.setTimeout(() => {
      const batch = alertBuf.current;
      alertBuf.current = [];
      alertTimer.current = null;
      if (batch.length <= 3) {
        for (const x of batch) {
          toast(x.title, 'info');
          // Подписанный браузер получит Web Push от сервера — здесь не дублируем
          if (!pushRef.current) void showLocal(x.title, x.message || '', `alert-${x.id}`, x.task_id, x.note_id ? `/#/notes?note=${x.note_id}` : undefined);
        }
      } else {
        toast(`Новых алертов: ${batch.length} — см. раздел «Алерты»`, 'info');
        if (!pushRef.current) void showLocal(`Новых алертов: ${batch.length}`, batch.slice(0, 3).map((x) => '• ' + x.title).join('\n'), 'alert-batch', null, '/#/alerts');
      }
    }, 1500);
  }, [toast]);

  // Живые обновления через SSE
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'tasks') {
        bump();
        reloadEmployees();
      } else if (e.type === 'sync') {
        setMeta((mt) => (mt ? { ...mt, sync: e.status } : mt));
      } else if (e.type === 'alert') {
        const a = e.alert as Alert & { notify?: boolean };
        refreshUnread();
        if (a.notify) queueAlertToast(a);
      }
    };
    return () => es.close();
  }, [bump, reloadEmployees, refreshUnread, queueAlertToast]);

  // Число непрочитанных алертов во вкладке браузера
  useEffect(() => {
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) Задачи отдела` : 'Задачи отдела';
  }, [unread]);

  const ctx = useMemo<Ctx>(
    () => ({ user, isAdmin: user.role === 'admin', meta, reloadMeta, employees, reloadEmployees, version, bump, openTask: setTaskId, toast, unread, refreshUnread, warnHours, pushActive, refreshPush }),
    [user, meta, reloadMeta, employees, reloadEmployees, version, bump, toast, unread, refreshUnread, warnHours, pushActive, refreshPush],
  );
  const Page = (PAGES.find((p) => p.id === route) || PAGES[0]).el;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">Задачи отдела</div>
          <nav>
            {PAGES.map((p) => (
              <a key={p.id} href={`#/${p.id}`} className={route === p.id || (!PAGES.some((x) => x.id === route) && p.id === 'kanban') ? 'active' : ''}>
                {p.title}
                {p.id === 'alerts' && unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <SyncIndicator />
            <a className={`btn ghost sm notify-link ${pushActive ? 'on' : ''}`} href="#/settings?notify" title={pushActive ? 'Оповещения в браузере включены' : 'Включить оповещения в браузере'}>
              {pushActive ? '🔔' : '🔕'}
            </a>
            <ThemeToggle initial={user.theme} />
            <a className="topbar-user" href="#/settings" title={`${user.login}${user.email ? ' · ' + user.email : ''} — личный кабинет`}>
              {user.name || user.login}
              {user.role === 'admin' && <span className="chip accent role-chip">админ</span>}
            </a>
            <button className="btn ghost sm" onClick={() => api.post('/auth/logout').then(() => location.reload())}>
              Выйти
            </button>
          </div>
        </header>
        <main className="content">
          <Suspense fallback={<div className="muted">Загрузка…</div>}>
            <Page />
          </Suspense>
        </main>
        {taskId !== null && <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />}
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
          ))}
        </div>
      </div>
    </AppCtx.Provider>
  );
}

const THEMES: { id: ThemePref; icon: string; title: string }[] = [
  { id: 'auto', icon: '◐', title: 'Тема: как в системе' },
  { id: 'light', icon: '☀', title: 'Тема: светлая' },
  { id: 'dark', icon: '☾', title: 'Тема: тёмная' },
];

/** Переключатель темы: авто → светлая → тёмная. Выбор сохраняется в профиле. */
function ThemeToggle({ initial }: { initial: ThemePref }) {
  const [theme, setTheme] = useState<ThemePref>(initial);
  const cur = THEMES.find((t) => t.id === theme) || THEMES[0];
  const next = () => {
    const n = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length].id;
    setTheme(n);
    applyTheme(n);
    void api.put('/me/theme', { theme: n }).catch(() => null);
  };
  return (
    <button className="btn ghost sm theme-toggle" onClick={next} title={`${cur.title} (нажмите, чтобы сменить)`} aria-label={cur.title}>
      {cur.icon}
    </button>
  );
}

function SyncIndicator() {
  const { meta, toast, bump } = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const s = meta?.sync;
  if (!s) return null;
  return (
    <button
      className={`sync ${s.lastError ? 'err' : ''}`}
      title={s.lastError || 'Синхронизировать сейчас'}
      onClick={async () => {
        try {
          await api.post('/sync', { full: true });
          bump();
          toast('Синхронизация завершена', 'ok');
        } catch (e: any) {
          toast(e.message, 'error');
        }
      }}
    >
      <span className={`dot ${s.running ? 'pulse' : ''}`} />
      {s.running ? 'Синхронизация…' : s.lastError ? 'Ошибка синхр.' : s.lastSyncAt ? `Синхр. ${relTime(s.lastSyncAt)}` : '—'}
    </button>
  );
}
