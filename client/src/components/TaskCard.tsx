import type { CSSProperties, ReactNode } from 'react';
import { daysSince, deadlineState, departmentOf, fmtDate, type Task } from '../api';
import { useApp } from '../App';

export function Avatar({ name, icon, size = 22 }: { name: string | null; icon?: string | null; size?: number }) {
  const { meta } = useApp();
  const initials = (name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const src = icon ? (icon.startsWith('http') ? icon : (meta?.portalUrl || '') + icon) : null;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }} title={name || ''}>
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} /> : null}
      <span>{initials}</span>
    </span>
  );
}

export function DeadlineBadge({ task }: { task: Pick<Task, 'deadline' | 'status'> }) {
  const { warnHours } = useApp();
  const st = deadlineState(task, warnHours);
  if (!task.deadline) return null;
  return <span className={`chip ${st === 'overdue' ? 'danger' : st === 'soon' ? 'warn' : ''}`} title="Крайний срок">⏱ {fmtDate(task.deadline)}</span>;
}

export function StatusChip({ status }: { status: number }) {
  const { meta } = useApp();
  const tone = status === 3 ? 'accent' : status === 5 ? 'ok' : status === 6 ? 'muted' : status === 4 ? 'warn' : '';
  return <span className={`chip ${tone}`}>{meta?.statusNames[status] || status}</span>;
}

/** Стадия канбана (цвет — как в Б24). Если у задачи нет стадии — статус. */
export function StageChip({ task }: { task: Pick<Task, 'stage_id' | 'status'> }) {
  const { meta } = useApp();
  const st = meta?.allStages.find((s) => s.id === task.stage_id);
  if (!st) return <StatusChip status={task.status} />;
  return (
    <span className="chip stage" title="Стадия">
      <span className="stage-dot" style={{ background: `#${st.color || 'ccc'}` }} />
      {st.title}
    </span>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return <>{tags.map((t) => <span key={t} className="chip tag">#{t}</span>)}</>;
}

interface Props {
  task: Task;
  showResponsible?: boolean;
  showStage?: boolean;
  /** Плашка с названием отдела (на канбане одного отдела не нужна — там только цветная полоса) */
  showDepartment?: boolean;
  extra?: ReactNode;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  className?: string;
}

export function TaskCard({ task, showResponsible = true, showStage, showDepartment = true, extra, style, dragHandleProps, className = '' }: Props) {
  const { openTask, meta } = useApp();
  const onEmp = daysSince(task.responsible_since);
  const dep = departmentOf(meta, task);
  return (
    <div
      className={`task-card ${task.status === 5 ? 'done' : ''} ${dep ? 'has-dep' : ''} ${className}`}
      style={dep ? { ...style, ['--dep' as string]: dep.color } : style}
      onClick={() => openTask(task.id)}
      {...dragHandleProps}
    >
      <div className="task-card-top">
        <span className="task-id">#{task.id}</span>
        {task.unread_alerts > 0 && <span className="unread-dot" title={`Непрочитанных алертов: ${task.unread_alerts}`} />}
        {task.notify === 'on' && <span className="notify-mark" title="Оповещения по задаче: всегда">🔔</span>}
        {task.notify === 'off' && <span className="notify-mark" title="Оповещения по задаче: никогда">🔕</span>}
        {dep ? (
          showDepartment && <span className="chip dep-chip" title={`Отдел: ${dep.title}`}>{dep.title}</span>
        ) : (
          <span className="chip muted group-chip" title={task.group_name ? `Группа вне ваших отделов: ${task.group_name}` : 'Без группы'}>{task.group_name || 'без группы'}</span>
        )}
      </div>
      <div className="task-title">{task.title}</div>
      {task.tags?.length > 0 && <div className="task-tags"><Tags tags={task.tags} /></div>}
      <div className="task-card-meta">
        {showResponsible && (
          <span className="who">
            <Avatar name={task.responsible_name} icon={task.responsible_icon} size={18} />
            <span className={task.is_employee ? '' : 'muted'}>{task.responsible_name || '—'}</span>
          </span>
        )}
        {showStage && <StageChip task={task} />}
        <DeadlineBadge task={task} />
        {task.status !== 5 && onEmp !== null && onEmp > 0 && (
          <span className="chip muted" title="Сколько дней задача на текущем ответственном">{onEmp} дн.</span>
        )}
        {task.depends_on.length > 0 && <span className="chip muted" title="Есть предшественники">⛓ {task.depends_on.length}</span>}
        {!!task.notes_count && <span className="chip muted" title={`Заметок, где упомянута задача: ${task.notes_count}`}>📝 {task.notes_count}</span>}
        {extra}
      </div>
    </div>
  );
}
