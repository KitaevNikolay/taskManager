import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';
import { NotifySettings } from '../components/NotifySettings';
import { ProfileSettings, UsersAdmin } from '../components/UsersSettings';
import { DepartmentsSettings } from '../components/Departments';

const FIELDS = [
  { key: 'staleDays', label: 'Задача «висит» на сотруднике, дней', hint: 'Алерт, если задача на одном ответственном дольше этого срока' },
  { key: 'idleDays', label: 'Нет движения по задаче, дней', hint: 'Алерт, если по открытой задаче нет активности (изменений, сообщений)' },
  { key: 'deadlineWarnHours', label: 'Предупреждать о сроке за, часов', hint: '' },
  { key: 'doneVisibleDays', label: 'Показывать закрытые задачи, дней', hint: 'На канбане и в списках' },
  { key: 'defaultTaskDays', label: 'Длительность задачи без оценки, раб. дней', hint: 'Для построения цепочки в Ганте' },
  { key: 'workdayHours', label: 'Рабочих часов в дне', hint: 'Перевод оценки времени задачи в дни' },
] as const;

export function SettingsPage() {
  const { meta, toast, bump, isAdmin } = useApp();
  const [s, setS] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => void api.get<Record<string, number>>('/settings').then(setS), []);
  useEffect(() => {
    if (location.hash.includes('departments')) document.getElementById('departments')?.scrollIntoView({ behavior: 'smooth' });
  }, []);
  if (!s) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setS(await api.put('/settings', s));
      toast('Настройки сохранены', 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      await api.post('/sync', { full: true });
      bump();
      toast('Полная синхронизация завершена', 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head"><h1>Личный кабинет</h1></div>
      <div className="split split-wide">
        <DepartmentsSettings />
        <ProfileSettings />
      </div>

      <div className="split settings-row">
        <form className="card form" onSubmit={save}>
          <h3>Мои правила алертов и планирования</h3>
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <input type="number" min={1} value={s[f.key]} onChange={(e) => setS({ ...s, [f.key]: Number(e.target.value) })} />
              {f.hint && <small className="muted">{f.hint}</small>}
            </label>
          ))}
          <button className="btn primary">Сохранить</button>
        </form>

        <div className="stack">
          <NotifySettings />
          <div className="card form">
            <h3>Синхронизация с Битрикс24</h3>
            <div className="kv">
              <div className="k">Портал</div><div className="v"><a href={meta?.portalUrl} target="_blank" rel="noreferrer">{meta?.portalUrl}</a></div>
              <div className="k">Последняя синхр.</div><div className="v">{fmtDateTime(meta?.sync.lastSyncAt)}</div>
              {meta?.sync.lastError && (<><div className="k">Ошибка</div><div className="v danger-text">{meta.sync.lastError}</div></>)}
              <div className="k">Интервал</div>
              <div className="v">
                {isAdmin ? (
                  <form className="row" onSubmit={save}>
                    <input type="number" min={15} value={s.syncIntervalSec} onChange={(e) => setS({ ...s, syncIntervalSec: Number(e.target.value) })} style={{ width: 90 }} />
                    <span className="muted small">сек (не меньше 15)</span>
                    <button className="btn sm">OK</button>
                  </form>
                ) : (
                  <span>{s.syncIntervalSec} сек <span className="muted small">— меняет администратор</span></span>
                )}
              </div>
            </div>
            <button className="btn" onClick={sync} disabled={busy}>{busy ? 'Синхронизация…' : 'Полная синхронизация'}</button>
            <p className="muted small">
              Изменения подтягиваются опросом Битрикс24. Свои действия из этой админки (вебхук) в алертах не дублируются.
              Комментарии в чатах задач определяются по активности задачи: текст сообщения недоступен без скоупа <code>im</code>.
            </p>
          </div>
        </div>
      </div>

      {isAdmin && <UsersAdmin />}
    </div>
  );
}
