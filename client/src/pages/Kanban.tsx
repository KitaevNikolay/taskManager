import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { api, deadlineState, stagesOf, type Department, type Task } from '../api';
import { useApp } from '../App';
import { Avatar, TaskCard } from '../components/TaskCard';
import { AbsenceBadge } from '../components/AbsenceBadge';
import { DepartmentAdd, DepartmentDot } from '../components/Departments';
import type { Employee } from '../api';

interface Column { id: string; title: string; color?: string; match: (t: Task) => boolean }

const OTHER_COL = 'other';

const hashParam = (k: string) => Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get(k)) || null;

export function KanbanPage() {
  const { employees, meta } = useApp();
  const [employeeId, setEmployeeId] = useState<number | null>(() => hashParam('employee'));
  const [groupId, setGroupId] = useState<number | null>(() => hashParam('dep'));

  const syncHash = (dep: number | null, emp: number | null) => {
    const p = new URLSearchParams();
    if (dep) p.set('dep', String(dep));
    if (emp) p.set('employee', String(emp));
    window.history.replaceState(null, '', `#/kanban${p.toString() ? '?' + p : ''}`);
  };
  const selectEmployee = (id: number | null) => { setEmployeeId(id); syncHash(groupId, id); };
  const selectGroup = (g: number) => { setGroupId(g); syncHash(g, employeeId); };

  useEffect(() => {
    const h = () => { setEmployeeId(hashParam('employee')); setGroupId(hashParam('dep')); };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const currentEmp = employees.find((e) => e.id === employeeId);
  const dep = meta?.departments.find((d) => d.group_id === groupId) || meta?.departments[0];
  return (
    <div className="page page-wide">
      <TaskBoard
        employeeId={employeeId}
        groupId={dep?.group_id ?? null}
        onSelectGroup={selectGroup}
        onSelectEmployee={selectEmployee}
        title={currentEmp ? `Задачи: ${currentEmp.name}` : dep ? dep.title : 'Канбан'}
        selector={
          <select value={employeeId ?? ''} onChange={(e) => selectEmployee(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Все задачи отдела</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.is_buffer ? ' (буфер)' : ''}</option>)}
          </select>
        }
      />
    </div>
  );
}

/** Вкладки отделов + добавление нового отдела */
export function DepartmentTabs({ active, onSelect }: { active: number | null; onSelect: (groupId: number) => void }) {
  const { meta, reloadMeta, bump } = useApp();
  const [adding, setAdding] = useState(false);
  const deps = meta?.departments || [];
  return (
    <>
      <div className="dep-tabs">
        {deps.map((d) => (
          <button key={d.id} className={`dep-tab ${d.group_id === active ? 'active' : ''}`} style={{ ['--dep' as string]: d.color }} onClick={() => onSelect(d.group_id)}>
            <DepartmentDot color={d.color} />
            {d.title}
          </button>
        ))}
        <button className="dep-tab add" onClick={() => setAdding(true)} title="Добавить отдел (группу Битрикс24)">+ Отдел</button>
      </div>
      {adding && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div className="modal card dep-modal">
            <h2>Новый отдел</h2>
            <DepartmentAdd
              onAdded={(d: Department) => { setAdding(false); reloadMeta(); bump(); onSelect(d.group_id); }}
              onCancel={() => setAdding(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

interface BoardProps {
  /** null — канбан отдела, иначе все задачи сотрудника */
  employeeId: number | null;
  /** Отдел (группа Б24), по стадиям которого строятся колонки */
  groupId: number | null;
  onSelectGroup: (groupId: number) => void;
  onSelectEmployee: (id: number | null) => void;
  title: ReactNode;
  selector?: ReactNode;
}

/** Канбан по стадиям группы отдела + панель сотрудников для назначения перетаскиванием */
export function TaskBoard({ employeeId, groupId, onSelectGroup, onSelectEmployee, title, selector }: BoardProps) {
  const { meta, employees, version, toast, bump, warnHours } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [dragged, setDragged] = useState<Task | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const dep = meta?.departments.find((d) => d.group_id === groupId) || null;

  useEffect(() => setHighlight(null), [employeeId, groupId]);

  useEffect(() => {
    if (!employeeId && !groupId) { setTasks([]); setLoading(false); return; }
    const url = employeeId ? `/tasks?scope=employee&employeeId=${employeeId}` : `/tasks?scope=department&groupId=${groupId}`;
    setLoading(true);
    api.get<Task[]>(url).then((t) => { setTasks(t); setLoading(false); }).catch((e) => { toast(e.message, 'error'); setLoading(false); });
  }, [employeeId, groupId, version, toast]);

  // Колонки — стадии канбана выбранного отдела. В режиме сотрудника его задачи из других групп — в отдельной колонке.
  const columns: Column[] = useMemo(() => {
    const stages = stagesOf(meta, groupId);
    const inGroup = (t: Task) => t.group_id === groupId;
    let cols: Column[];
    if (stages.length) {
      const first = stages[0].id;
      cols = stages.map((s) => ({
        id: `g${s.id}`, title: s.title, color: s.color,
        match: (t: Task) => inGroup(t) && (t.stage_id === s.id || (s.id === first && !stages.some((x) => x.id === t.stage_id))),
      }));
    } else {
      cols = groupId ? [{ id: 'nostage', title: 'Задачи (в группе нет канбана)', color: 'a0a8b0', match: inGroup }] : [];
    }
    if (employeeId) cols.push({ id: OTHER_COL, title: groupId ? 'Другие отделы и группы' : 'Задачи', color: 'a0a8b0', match: (t) => !inGroup(t) });
    return cols;
  }, [employeeId, groupId, meta]);

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
        if (task.group_id !== groupId) {
          toast('Задача из другой группы — её стадии в другом канбане', 'error');
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

  if (meta && !meta.departments.length && !employeeId) {
    return (
      <div className="card onboarding">
        <h2>Добавьте первый отдел</h2>
        <p className="muted">Отдел — это группа (проект) Битрикс24. Канбан строится по её стадиям, а задачи отдела отмечаются его цветом. Отделов может быть несколько — между ними можно переключаться.</p>
        <DepartmentAdd onAdded={(d) => onSelectGroup(d.group_id)} />
      </div>
    );
  }

  return (
    <>
      <DepartmentTabs active={groupId} onSelect={onSelectGroup} />
      <div className="page-head">
        <h1 className="dep-title">{dep && <DepartmentDot color={dep.color} size={12} />}{title}</h1>
        <div className="toolbar">
          {selector}
          <input className="search" placeholder="Поиск: название, ID, исполнитель, #тег" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Только проблемные</label>
          <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Закрытые</label>
        </div>
      </div>
      {employeeId && (
        <p className="muted small page-note">
          Все задачи сотрудника. Колонки — стадии отдела «{dep?.title || '—'}»; задачи других отделов и групп — в последней колонке, с их стадией и отделом.
        </p>
      )}

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
      <TaskCard task={task} showResponsible={showResponsible} showStage={showStage} showDepartment={showStage} dragHandleProps={{ ...attributes, ...listeners }} />
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
