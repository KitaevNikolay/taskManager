import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { api, deadlineState, type Task } from '../api';
import { useApp } from '../App';
import { Avatar, TaskCard } from '../components/TaskCard';
import { AbsenceBadge } from '../components/AbsenceBadge';
import type { Employee } from '../api';

interface Column { id: string; title: string; color?: string; match: (t: Task) => boolean }

const OTHER_COL = 'other';

const readEmployeeFromHash = () => Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('employee')) || null;

export function KanbanPage() {
  const { meta, employees } = useApp();
  const [employeeId, setEmployeeId] = useState<number | null>(readEmployeeFromHash);

  const selectEmployee = (id: number | null) => {
    setEmployeeId(id);
    window.history.replaceState(null, '', id ? `#/kanban?employee=${id}` : '#/kanban');
  };

  useEffect(() => {
    const h = () => setEmployeeId(readEmployeeFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const currentEmp = employees.find((e) => e.id === employeeId);
  return (
    <div className="page page-wide">
      <TaskBoard
        employeeId={employeeId}
        onSelectEmployee={selectEmployee}
        title={currentEmp ? `Задачи: ${currentEmp.name}` : 'Канбан отдела'}
        selector={
          <select value={employeeId ?? ''} onChange={(e) => selectEmployee(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Отдел (группа {meta?.groupId})</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.is_buffer ? ' (буфер)' : ''}</option>)}
          </select>
        }
      />
    </div>
  );
}

interface BoardProps {
  /** null — канбан группы отдела, иначе все задачи сотрудника */
  employeeId: number | null;
  onSelectEmployee: (id: number | null) => void;
  title: ReactNode;
  selector?: ReactNode;
}

/** Канбан по стадиям группы + панель сотрудников для назначения перетаскиванием */
export function TaskBoard({ employeeId, onSelectEmployee, title, selector }: BoardProps) {
  const { meta, employees, version, toast, bump, warnHours } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [dragged, setDragged] = useState<Task | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);

  useEffect(() => setHighlight(null), [employeeId]);

  useEffect(() => {
    const url = employeeId ? `/tasks?scope=employee&employeeId=${employeeId}` : '/tasks?scope=group';
    api.get<Task[]>(url).then((t) => { setTasks(t); setLoading(false); }).catch((e) => toast(e.message, 'error'));
  }, [employeeId, version, toast]);

  // Колонки — стадии канбана группы отдела. В режиме сотрудника его задачи из других групп — в отдельной колонке.
  const columns: Column[] = useMemo(() => {
    const stages = meta?.stages || [];
    const first = stages[0]?.id;
    const inGroup = (t: Task) => t.group_id === meta?.groupId;
    const cols: Column[] = stages.map((s) => ({
      id: `g${s.id}`, title: s.title, color: s.color,
      match: (t: Task) => inGroup(t) && (t.stage_id === s.id || (s.id === first && !stages.some((x) => x.id === t.stage_id))),
    }));
    if (employeeId) cols.push({ id: OTHER_COL, title: 'Другие группы', color: 'a0a8b0', match: (t) => !inGroup(t) });
    return cols;
  }, [employeeId, meta]);

  const visible = tasks.filter((t) => {
    if (!showDone && (t.status === 5 || t.status === 7)) return false;
    if (search) {
      const s = search.toLowerCase();
      const hay = [t.title, String(t.id), t.responsible_name || '', ...(t.tags || []).map((x) => '#' + x)].join(' ').toLowerCase();
      if (!hay.includes(s)) return false;
    }
    if (onlyProblems && !(deadlineState(t, warnHours) === 'overdue' || deadlineState(t, warnHours) === 'soon' || t.unread_alerts > 0)) return false;
    return true;
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => setDragged(tasks.find((t) => t.id === e.active.id) || null);

  const onDragEnd = async (e: DragEndEvent) => {
    setDragged(null);
    const task = tasks.find((t) => t.id === e.active.id);
    const over = e.over?.id ? String(e.over.id) : null;
    if (!task || !over) return;
    const prev = tasks;
    try {
      if (over.startsWith('emp:')) {
        const respId = Number(over.slice(4));
        if (respId === task.responsible_id) return;
        const emp = employees.find((x) => x.id === respId);
        setTasks(tasks.map((t) => (t.id === task.id ? { ...t, responsible_id: respId, responsible_name: emp?.name || null, responsible_icon: null } : t)));
        await api.post(`/tasks/${task.id}/responsible`, { responsibleId: respId });
        toast(`#${task.id} назначена: ${emp?.name}`, 'ok');
      } else if (over.startsWith('g')) {
        if (task.group_id !== meta?.groupId) {
          toast('Задача не в группе отдела — её стадии в другом канбане', 'error');
          return;
        }
        const stageId = Number(over.slice(1));
        if (stageId === task.stage_id) return;
        setTasks(tasks.map((t) => (t.id === task.id ? { ...t, stage_id: stageId } : t)));
        await api.post(`/tasks/${task.id}/stage`, { stageId });
      } else {
        return;
      }
      bump();
    } catch (err: any) {
      setTasks(prev);
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        <div className="toolbar">
          {selector}
          <input className="search" placeholder="Поиск: название, ID, исполнитель, #тег" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Только проблемные</label>
          <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Закрытые</label>
        </div>
      </div>
      {employeeId && <p className="muted small page-note">Все задачи сотрудника. Задачи из других групп — в последней колонке, на карточке указана их стадия.</p>}

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragged(null)}>
        <div className="kanban-layout">
          <div className="kanban">
            {loading ? <div className="muted">Загрузка…</div> : columns.map((c) => {
              const items = visible.filter(c.match).sort((a, b) => (b.activity_date || '').localeCompare(a.activity_date || ''));
              return (
                <KanbanColumn key={c.id} column={c} count={items.length}>
                  {items.map((t) => (
                    <DraggableCard key={t.id} task={t} dimmed={highlight !== null && t.responsible_id !== highlight} showResponsible={!employeeId} showStage={c.id === OTHER_COL} />
                  ))}
                </KanbanColumn>
              );
            })}
          </div>

          <aside className="kanban-side">
            <div className="side-title">Сотрудники</div>
            <div className="muted small">Перетащите задачу на сотрудника, чтобы назначить. Клик — подсветить его задачи.</div>
            {employees.length === 0 && <a href="#/employees" className="small">Добавить сотрудников →</a>}
            {employees.map((e) => (
              <EmployeeDrop
                key={e.id}
                id={e.id}
                name={e.name}
                photo={e.photo}
                open={e.open_count ?? 0}
                overdue={e.overdue_count ?? 0}
                active={highlight === e.id || employeeId === e.id}
                onClick={() => (employeeId ? onSelectEmployee(e.id) : setHighlight(highlight === e.id ? null : e.id))}
                onOpen={() => onSelectEmployee(e.id)}
                buffer={!!e.is_buffer}
                employee={e}
              />
            ))}
          </aside>
        </div>
        <DragOverlay dropAnimation={null}>{dragged && <TaskCard task={dragged} className="dragging" showResponsible={!employeeId} />}</DragOverlay>
      </DndContext>
    </>
  );
}

function KanbanColumn({ column, count, children }: { column: Column; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <div ref={setNodeRef} className={`kanban-col ${isOver ? 'over' : ''}`}>
      <div className="kanban-col-head" style={{ borderTopColor: `#${column.color || 'ccc'}` }}>
        <span>{column.title}</span>
        <span className="count">{count}</span>
      </div>
      <div className="kanban-col-body">{children}</div>
    </div>
  );
}

function DraggableCard({ task, dimmed, showResponsible, showStage }: { task: Task; dimmed: boolean; showResponsible: boolean; showStage: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.35 : dimmed ? 0.3 : 1 }}>
      <TaskCard task={task} showResponsible={showResponsible} showStage={showStage} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

function EmployeeDrop(p: { id: number; name: string; photo: string | null; open: number; overdue: number; active: boolean; buffer: boolean; employee: Employee; onClick: () => void; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `emp:${p.id}` });
  return (
    <div ref={setNodeRef} className={`emp-drop ${isOver ? 'over' : ''} ${p.active ? 'active' : ''}`} onClick={p.onClick}>
      <Avatar name={p.name} icon={p.photo} size={28} />
      <div className="emp-drop-text">
        <div className="emp-name">{p.name}{p.buffer && <span className="chip warn buffer-chip">буфер</span>}</div>
        <AbsenceBadge employee={p.employee} />
        <div className="muted small">{p.open} откр.{p.overdue > 0 && <span className="danger-text"> · {p.overdue} просроч.</span>}</div>
      </div>
      <button className="btn ghost xs" title="Все задачи сотрудника" onClick={(e) => { e.stopPropagation(); p.onOpen(); }}>→</button>
    </div>
  );
}
