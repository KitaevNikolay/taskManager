import { useEffect, useRef, useState } from 'react';
import { ALERT_TYPES, api } from '../api';
import { useApp } from '../App';
import { pushSupported, subscribe, unsubscribe } from '../push';

interface Settings {
  enabled: boolean;
  types: string[];
  mode: 'all' | 'selected';
  employees: number[];
  allTypes: string[];
  publicKey: string;
  subscriptions: number;
  tasks: { task_id: number; mode: 'on' | 'off'; title: string | null; responsible_name: string | null }[];
}

export function NotifySettings() {
  const { employees, toast, pushActive, refreshPush, openTask, version } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const perm = 'Notification' in window ? Notification.permission : 'denied';

  const load = () => api.get<Settings>('/notify/settings').then(setS).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), [version]); // eslint-disable-line
  useEffect(() => {
    if (s && location.hash.includes('?notify')) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [!!s]); // eslint-disable-line

  if (!s) return null;

  const save = async (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    try {
      await api.put('/notify/settings', { enabled: next.enabled, types: next.types, mode: next.mode, employees: next.employees });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const enable = async () => {
    setBusy(true);
    const err = await subscribe(s.publicKey);
    setBusy(false);
    refreshPush();
    load();
    if (err) toast(err, 'error');
    else toast('Оповещения в этом браузере включены', 'ok');
  };
  const disable = async () => {
    setBusy(true);
    await unsubscribe();
    setBusy(false);
    refreshPush();
    load();
  };
  const test = async () => {
    const r = await api.post<{ sent: number }>('/notify/test');
    toast(r.sent ? 'Тестовое оповещение отправлено' : 'Нет подписанных браузеров', r.sent ? 'ok' : 'error');
  };
  const setTaskMode = async (taskId: number, mode: 'on' | 'off' | null) => {
    await api.put(`/tasks/${taskId}/notify`, { mode });
    load();
  };

  return (
    <div className="card form notify-settings" ref={ref}>
      <h3>Оповещения в браузере</h3>

      <div className={`notify-status ${pushActive ? 'on' : ''}`}>
        {!pushSupported() ? (
          <span>Этот браузер не поддерживает оповещения.</span>
        ) : perm === 'denied' ? (
          <span>Оповещения заблокированы для этого сайта. Разрешите их в настройках браузера (значок замка в адресной строке) и обновите страницу.</span>
        ) : pushActive ? (
          <>
            <span>🔔 Этот браузер получает оповещения, даже когда вкладка закрыта.</span>
            <div className="row">
              <button type="button" className="btn sm" onClick={test}>Проверить</button>
              <button type="button" className="btn ghost sm" disabled={busy} onClick={disable}>Отключить в этом браузере</button>
            </div>
          </>
        ) : (
          <>
            <span>Этот браузер не подписан на оповещения.</span>
            <button type="button" className="btn primary sm" disabled={busy} onClick={enable}>Включить оповещения</button>
          </>
        )}
      </div>
      {s.subscriptions > 0 && <div className="muted small">Подписанных браузеров: {s.subscriptions}</div>}

      <label className="check">
        <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        Присылать оповещения
      </label>

      <fieldset disabled={!s.enabled}>
        <div className="field">
          <span>По каким событиям</span>
          <div className="check-grid">
            {s.allTypes.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={s.types.includes(t)} onChange={() => save({ types: toggle(s.types, t) })} />
                {ALERT_TYPES[t]?.label || t}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span>По каким задачам</span>
          <label className="check">
            <input type="radio" checked={s.mode === 'all'} onChange={() => save({ mode: 'all' })} /> По всем задачам отдела и сотрудников
          </label>
          <label className="check">
            <input type="radio" checked={s.mode === 'selected'} onChange={() => save({ mode: 'selected' })} /> Только по выбранным
          </label>
          {s.mode === 'selected' && (
            <div className="notify-emps">
              <div className="muted small">Все задачи сотрудников:</div>
              <div className="check-grid">
                {employees.map((e) => (
                  <label key={e.id} className="check">
                    <input type="checkbox" checked={s.employees.includes(e.id)} onChange={() => save({ employees: toggle(s.employees, e.id) })} />
                    {e.name}
                  </label>
                ))}
              </div>
              <div className="muted small">…плюс задачи, у которых в карточке включено «Всегда».</div>
            </div>
          )}
        </div>

        <div className="field">
          <span>Настроено в задачах</span>
          {s.tasks.length === 0 && (
            <div className="muted small">Нет. Откройте задачу и выберите «Оповещения: всегда» или «никогда» — это важнее общих правил.</div>
          )}
          {s.tasks.map((t) => (
            <div key={t.task_id} className="notify-task">
              <span className={`chip ${t.mode === 'on' ? 'accent' : 'muted'}`}>{t.mode === 'on' ? '🔔 всегда' : '🔕 никогда'}</span>
              <button type="button" className="link" onClick={() => openTask(t.task_id)}>#{t.task_id} {t.title || ''}</button>
              <button type="button" className="btn ghost xs" title="Вернуть к общим правилам" onClick={() => setTaskMode(t.task_id, null)}>✕</button>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** Переключатель оповещений для одной задачи */
export function TaskNotifyToggle({ taskId, mode, onChange }: { taskId: number; mode: 'on' | 'off' | null; onChange: () => void }) {
  const { toast } = useApp();
  const set = async (m: 'on' | 'off' | null) => {
    try {
      await api.put(`/tasks/${taskId}/notify`, { mode: m });
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="seg seg-sm" title="Оповещения в браузере по этой задаче">
      <button className={mode === null ? 'active' : ''} onClick={() => set(null)}>По правилам</button>
      <button className={mode === 'on' ? 'active' : ''} onClick={() => set('on')}>🔔 Всегда</button>
      <button className={mode === 'off' ? 'active' : ''} onClick={() => set('off')}>🔕 Никогда</button>
    </div>
  );
}
