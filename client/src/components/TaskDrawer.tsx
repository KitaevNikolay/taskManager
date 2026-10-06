import { useEffect, useState } from 'react';
import { ALERT_TYPES, api, departmentOf, fmtDateTime, relTime, stagesOf, toYmd, type Alert, type Task } from '../api';
import { useApp } from '../App';
import { Avatar, StageChip, StatusChip, Tags } from './TaskCard';
import { TaskNotifyToggle } from './NotifySettings';

interface Full extends Task {
  description: string | null;
  url: string;
  predecessors: Pick<Task, 'id' | 'title' | 'status' | 'start_date_plan' | 'end_date_plan' | 'deadline'>[];
  successors: Pick<Task, 'id' | 'title' | 'status'>[];
  alerts: Alert[];
}

const ACTIONS: Record<number, { action: string; label: string }[]> = {
  1: [{ action: 'start', label: 'Начать' }, { action: 'defer', label: 'Отложить' }, { action: 'complete', label: 'Завершить' }],
  2: [{ action: 'start', label: 'Начать' }, { action: 'defer', label: 'Отложить' }, { action: 'complete', label: 'Завершить' }],
  3: [{ action: 'pause', label: 'Пауза' }, { action: 'defer', label: 'Отложить' }, { action: 'complete', label: 'Завершить' }],
  4: [{ action: 'approve', label: 'Принять' }, { action: 'disapprove', label: 'Вернуть в работу' }],
  5: [{ action: 'renew', label: 'Возобновить' }],
  6: [{ action: 'renew', label: 'Вернуть в работу' }],
};

/** BB-код Б24 -> обычный текст */
const stripBB = (s: string) => s.replace(/\[(\/?)(b|i|u|s|url|img|list|\*|quote|code|color|size|font|left|right|center|justify|p|table|tr|td|th|user|disk file id)[^\]]*\]/gi, '').trim();

export function TaskDrawer({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const { employees, meta, toast, bump, version, refreshUnread, openTask } = useApp();
  const [task, setTask] = useState<Full | null>(null);
  const [busy, setBusy] = useState(false);
  const [predId, setPredId] = useState('');

  const load = () => api.get<Full>(`/tasks/${taskId}`).then(setTask).catch((e) => { toast(e.message, 'error'); onClose(); });
  useEffect(() => { setTask(null); void load(); }, [taskId]); // eslint-disable-line
  useEffect(() => { if (task) void load(); }, [version]); // eslint-disable-line
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      bump();
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const respOptions = task && task.responsible_id && !employees.some((e) => e.id === task.responsible_id)
    ? [{ id: task.responsible_id, name: task.responsible_name || `#${task.responsible_id}` }, ...employees]
    : employees;
  // Стадию можно менять, если у группы задачи есть канбан (стадии известны)
  const groupStages = task ? stagesOf(meta, task.group_id) : [];
  const dep = task ? departmentOf(meta, task) : null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        {!task ? (
          <div className="drawer-loading">Загрузка…</div>
        ) : (
          <>
            <div className="drawer-head">
              <div>
                <div className="task-id">
                  #{task.id}
                  {dep ? (
                    <span className="chip dep-chip" style={{ ['--dep' as string]: dep.color }}>{dep.title}</span>
                  ) : (
                    task.group_name && <span className="muted"> · {task.group_name}</span>
                  )}
                </div>
                <h2>{task.title}</h2>
              </div>
              <div className="drawer-head-actions">
                <a className="btn sm" href={task.url} target="_blank" rel="noreferrer">Открыть в Б24 ↗</a>
                <button className="btn ghost sm" onClick={onClose} aria-label="Закрыть">✕</button>
              </div>
            </div>

            <div className={`drawer-body ${busy ? 'busy' : ''}`}>
              <section className="kv">
                <div className="k">Статус</div>
                <div className="v row wrap">
                  <StatusChip status={task.status} />
                  {(ACTIONS[task.status] || []).map((a) => (
                    <button key={a.action} className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/tasks/${task.id}/status`, { action: a.action }), 'Статус обновлён')}>
                      {a.label}
                    </button>
                  ))}
                </div>


                {task.tags.length > 0 && (
                  <>
                    <div className="k">Теги</div>
                    <div className="v task-tags"><Tags tags={task.tags} /></div>
                  </>
                )}

                {groupStages.length > 0 && (
                  <>
                    <div className="k">Стадия</div>
                    <div className="v">
                      {task.is_employee || dep ? (
                        <select value={task.stage_id ?? ''} disabled={busy} onChange={(e) => run(() => api.post(`/tasks/${task.id}/stage`, { stageId: Number(e.target.value) }), 'Стадия изменена')}>
                          {!groupStages.some((s) => s.id === task.stage_id) && <option value={task.stage_id ?? ''}>—</option>}
                          {groupStages.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                        </select>
                      ) : (
                        <StageChip task={task} />
                      )}
                    </div>
                  </>
                )}

                <div className="k">Ответственный</div>
                <div className="v row">
                  <Avatar name={task.responsible_name} icon={task.responsible_icon} />
                  <select value={task.responsible_id ?? ''} disabled={busy} onChange={(e) => run(() => api.post(`/tasks/${task.id}/responsible`, { responsibleId: Number(e.target.value) }), 'Ответственный назначен')}>
                    {respOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>

                <div className="k">На ответственном с</div>
                <div className="v">{fmtDateTime(task.responsible_since)}</div>

                <div className="k">Постановщик</div>
                <div className="v">{task.creator_name || '—'}</div>

                <div className="k">Крайний срок</div>
                <div className="v">
                  <DateInput value={task.deadline} disabled={busy} onChange={(v) => run(() => api.patch(`/tasks/${task.id}/dates`, { deadline: v }), 'Срок обновлён')} />
                </div>

                <div className="k">План</div>
                <div className="v row">
                  <DateInput value={task.start_date_plan} disabled={busy} onChange={(v) => run(() => api.patch(`/tasks/${task.id}/dates`, { startDatePlan: v }), 'План обновлён')} />
                  <span className="muted">→</span>
                  <DateInput value={task.end_date_plan} disabled={busy} onChange={(v) => run(() => api.patch(`/tasks/${task.id}/dates`, { endDatePlan: v }), 'План обновлён')} />
                </div>

                <div className="k">Активность</div>
                <div className="v">{fmtDateTime(task.activity_date)}</div>

                <div className="k">Оповещения</div>
                <div className="v"><TaskNotifyToggle taskId={task.id} mode={task.notify} onChange={() => { bump(); load(); }} /></div>
              </section>

              <section>
                <h3>Предшественники <span className="muted">(эта задача начинается после них)</span></h3>
                {task.depends_on.length === 0 && <div className="muted small">Нет</div>}
                {task.predecessors.map((p) => (
                  <div key={p.id} className="dep-row">
                    <button className="link" onClick={() => openTask(p.id)}>#{p.id} {p.title}</button>
                    <button className="btn ghost sm" disabled={busy} title="Удалить связь" onClick={() => run(() => api.del(`/tasks/${task.id}/deps/${p.id}`), 'Связь удалена')}>✕</button>
                  </div>
                ))}
                {task.depends_on.filter((id) => !task.predecessors.some((p) => p.id === id)).map((id) => (
                  <div key={id} className="dep-row muted">#{id} (вне синхронизации)
                    <button className="btn ghost sm" disabled={busy} onClick={() => run(() => api.del(`/tasks/${task.id}/deps/${id}`), 'Связь удалена')}>✕</button>
                  </div>
                ))}
                <form className="row" onSubmit={(e) => { e.preventDefault(); if (predId) run(() => api.post(`/tasks/${task.id}/deps`, { predecessorId: Number(predId) }), 'Связь добавлена').then(() => setPredId('')); }}>
                  <input placeholder="ID задачи-предшественника" value={predId} onChange={(e) => setPredId(e.target.value.replace(/\D/g, ''))} style={{ width: 200 }} />
                  <button className="btn sm" disabled={busy || !predId}>Добавить связь</button>
                </form>
                {task.successors.length > 0 && (
                  <>
                    <h3>Последователи</h3>
                    {task.successors.map((s) => (
                      <div key={s.id} className="dep-row"><button className="link" onClick={() => openTask(s.id)}>#{s.id} {s.title}</button></div>
                    ))}
                  </>
                )}
              </section>

              {task.description && (
                <section>
                  <h3>Описание</h3>
                  <div className="description">{stripBB(task.description)}</div>
                </section>
              )}

              <section>
                <div className="row between">
                  <h3>События по задаче</h3>
                  {task.alerts.some((a) => !a.read_at) && (
                    <button className="btn ghost sm" onClick={() => api.post('/alerts/read', { taskId: task.id }).then(() => { refreshUnread(); bump(); load(); })}>Прочитано</button>
                  )}
                </div>
                {task.alerts.length === 0 && <div className="muted small">Пока нет</div>}
                {task.alerts.map((a) => (
                  <div key={a.id} className={`alert-mini ${a.read_at ? '' : 'unread'}`}>
                    <span className={`chip ${ALERT_TYPES[a.type]?.tone || ''}`}>{ALERT_TYPES[a.type]?.label || a.type}</span>
                    <span className="muted small">{relTime(a.created_at)}{a.author ? ` · ${a.author}` : ''}</span>
                    {a.message && <div className="pre small">{a.message}</div>}
                  </div>
                ))}
              </section>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function DateInput({ value, onChange, disabled }: { value: string | null; onChange: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(toYmd(value));
  useEffect(() => setV(toYmd(value)), [value]);
  return (
    <span className="date-input">
      <input type="date" value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => v !== toYmd(value) && onChange(v)} />
      {value && <button className="btn ghost xs" disabled={disabled} title="Очистить" onClick={() => onChange('')}>✕</button>}
    </span>
  );
}
