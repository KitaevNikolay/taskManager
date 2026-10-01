import { useEffect, useState } from 'react';
import { ALERT_TYPES, api, fmtDateTime, relTime, type Alert } from '../api';
import { useApp } from '../App';

const FILTERS = [
  { id: '', label: 'Все' },
  { id: 'change,comment,assigned,new', label: 'Изменения и комментарии' },
  { id: 'stale,idle', label: 'Зависшие' },
  { id: 'overdue,deadline_soon,absence', label: 'Сроки' },
];

export function AlertsPage() {
  const { employees, version, unread, refreshUnread, openTask, toast } = useApp();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [type, setType] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(true);

  const load = () => {
    const p = new URLSearchParams();
    if (type) p.set('type', type);
    if (employeeId) p.set('employeeId', employeeId);
    if (onlyUnread) p.set('unread', '1');
    api.get<Alert[]>(`/alerts?${p}`).then(setAlerts).catch((e) => toast(e.message, 'error'));
  };
  useEffect(load, [type, employeeId, onlyUnread, version, unread]); // eslint-disable-line

  const markRead = async (body: unknown) => {
    await api.post('/alerts/read', body);
    refreshUnread();
    load();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Алерты</h1>
        <div className="toolbar">
          <div className="seg">
            {FILTERS.map((f) => <button key={f.id} className={type === f.id ? 'active' : ''} onClick={() => setType(f.id)}>{f.label}</button>)}
          </div>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Все сотрудники</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <a className="btn ghost sm" href="#/settings?notify">⚙ Оповещения в браузере</a>
          <label className="check"><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Непрочитанные</label>
          {unread > 0 && <button className="btn sm" onClick={() => markRead(alerts.length && (type || employeeId) ? { ids: alerts.filter((a) => !a.read_at).map((a) => a.id) } : { all: true })}>Отметить {type || employeeId ? 'показанные' : 'все'} прочитанными</button>}
        </div>
      </div>

      <div className="alert-list">
        {alerts.length === 0 && <div className="card muted center">Нет алертов</div>}
        {alerts.map((a) => {
          const t = ALERT_TYPES[a.type] || { label: a.type, tone: '' };
          return (
            <div key={a.id} className={`alert-item card ${a.read_at ? 'read' : ''} tone-${t.tone}`}>
              <div className="alert-main" onClick={() => (a.note_id ? (location.hash = `#/notes?note=${a.note_id}`) : a.task_id && openTask(a.task_id))}>
                <div className="row wrap">
                  <span className={`chip ${t.tone}`}>{t.label}</span>
                  <span className="alert-title">{a.title}</span>
                </div>
                {a.message && <div className="pre small">{a.message}</div>}
                <div className="muted small">
                  <span title={fmtDateTime(a.created_at)}>{relTime(a.created_at)}</span>
                  {a.author && ` · ${a.author}`}
                  {a.employee_name && ` · сотрудник: ${a.employee_name}`}
                </div>
              </div>
              {!a.read_at && <button className="btn ghost sm" onClick={() => markRead({ ids: [a.id] })} title="Отметить прочитанным">✓</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
