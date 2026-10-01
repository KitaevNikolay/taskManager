import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';
import { NotifySettings } from '../components/NotifySettings';
import { UsersSettings } from '../components/UsersSettings';

const FIELDS = [
  { key: 'staleDays', label: 'Задача «висит» на сотруднике, дней', hint: 'Алерт, если задача на одном ответственном дольше этого срока' },
  { key: 'idleDays', label: 'Нет движения по задаче, дней', hint: 'Алерт, если по открытой задаче нет активности (изменений, сообщений)' },
  { key: 'deadlineWarnHours', label: 'Предупреждать о сроке за, часов', hint: '' },
  { key: 'doneVisibleDays', label: 'Показывать закрытые задачи, дней', hint: 'На канбане и в списках' },
  { key: 'defaultTaskDays', label: 'Длительность задачи без оценки, раб. дней', hint: 'Для построения цепочки в Ганте' },
  { key: 'workdayHours', label: 'Рабочих часов в дне', hint: 'Перевод оценки времени задачи в дни' },
  { key: 'syncIntervalSec', label: 'Интервал синхронизации, сек', hint: 'Не меньше 15 — у Битрикс24 есть лимит на число запросов' },
] as const;

export function SettingsPage() {
  const { meta, toast, bump } = useApp();
  const [s, setS] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => void api.get<Record<string, number>>('/settings').then(setS), []);
  if (!s) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setS(await api.put('/settings', { ...s, syncIntervalSec: Math.max(15, s.syncIntervalSec) }));
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
      <div className="page-head"><h1>Настройки</h1></div>
      <div className="split">
        <form className="card form" onSubmit={save}>
          <h3>Правила алертов и планирования</h3>
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
            <div className="k">Группа отдела</div><div className="v">{meta?.groupId}</div>
            <div className="k">Стадии канбана</div><div className="v">{meta?.stages.map((st) => st.title).join(' → ')}</div>
            <div className="k">Последняя синхр.</div><div className="v">{fmtDateTime(meta?.sync.lastSyncAt)}</div>
            {meta?.sync.lastError && (<><div className="k">Ошибка</div><div className="v danger-text">{meta.sync.lastError}</div></>)}
          </div>
          <button className="btn" onClick={sync} disabled={busy}>{busy ? 'Синхронизация…' : 'Полная синхронизация'}</button>
          <p className="muted small">
            Изменения подтягиваются опросом Битрикс24. Свои действия из этой админки (вебхук) в алертах не дублируются.
            Комментарии в чатах задач определяются по активности задачи: текст сообщения недоступен без скоупа <code>im</code>.
          </p>
        </div>
        </div>
      </div>
      <UsersSettings />
    </div>
  );
}
