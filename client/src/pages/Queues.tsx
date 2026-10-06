import { useEffect, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, departmentOf, fmtDate, taskState, toYmd, type Employee, type Task } from '../api';
import { useApp } from '../App';
import { Avatar, TaskCard } from '../components/TaskCard';
import { TaskBoard } from './Kanban';
import { AbsenceBadge } from '../components/AbsenceBadge';

interface Queue { employee: Employee; tasks: Task[] }

const COL = 'col:';
const DROP = 'drop:';
const readEmployeeFromHash = () => Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('employee')) || null;

export function QueuesPage() {
  const { employees, meta } = useApp();
  const [selected, setSelected] = useState<number | null>(readEmployeeFromHash);
  const [groupId, setGroupId] = useState<number | null>(null);
  const boardGroup = groupId ?? meta?.departments[0]?.group_id ?? null;

  const select = (id: number | null) => {
    setSelected(id);
    window.history.replaceState(null, '', id ? `#/queues?employee=${id}` : '#/queues');
  };
  useEffect(() => {
    const h = () => setSelected(readEmployeeFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const emp = employees.find((e) => e.id === selected);
  return (
    <div className="page page-wide">
      <div className="emp-tabs">
        <button className={selected === null ? 'active' : ''} onClick={() => select(null)}>Все очереди</button>
        {employees.map((e) => (
          <button key={e.id} className={selected === e.id ? 'active' : ''} onClick={() => select(e.id)} title={e.position || ''}>
            <Avatar name={e.name} icon={e.photo} size={20} />
            {e.name}
            {!!e.is_buffer && <span className="chip warn buffer-chip">буфер</span>}
            <AbsenceBadge employee={e} compact />
            <span className="muted">{e.open_count ?? 0}</span>
          </button>
        ))}
      </div>
      {emp ? (
        <TaskBoard
          employeeId={emp.id}
          groupId={boardGroup}
          onSelectGroup={setGroupId}
          onSelectEmployee={select}
          title={<>Задачи: {emp.name}{!!emp.is_buffer && <span className="chip warn buffer-chip">буфер</span>} <AbsenceBadge employee={emp} /></>}
        />
      ) : (
        <AllQueues onOpen={select} />
      )}
    </div>
  );
}

/** Все очереди: колонки сотрудников (порядок меняется перетаскиванием за шапку),
 *  задачи переставляются внутри очереди и переносятся между сотрудниками (= смена ответственного в Б24) */
function AllQueues({ onOpen }: { onOpen: (id: number) => void }) {
  const { version, toast, bump, reloadEmployees } = useApp();
  const [queues, setQueues] = useState<Queue[] | null>(null);
  const [planFor, setPlanFor] = useState<Queue | null>(null);
  const [pickFor, setPickFor] = useState<Queue | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [activeCol, setActiveCol] = useState<Queue | null>(null);
  const [overEmp, setOverEmp] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    api.get<Queue[]>('/queues').then(setQueues).catch((e) => toast(e.message, 'error'));
  }, [version, toast]);

  if (!queues) return <div className="muted">Загрузка…</div>;

  const empOf = (id: unknown): number | null => {
    const s = String(id);
    if (s.startsWith(DROP)) return Number(s.slice(DROP.length));
    const qu = queues.find((x) => x.tasks.some((t) => t.id === Number(id)));
    return qu ? qu.employee.id : null;
  };

  // Колонки сравниваем только с колонками; задачи — с задачами той колонки, над которой курсор
  const collision: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith(COL)) {
      return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith(COL)) });
    }
    const zones = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith(DROP)) });
    if (!zones.length) return [];
    const emp = Number(String(zones[0].id).slice(DROP.length));
    const ids = new Set(queues.find((x) => x.employee.id === emp)?.tasks.map((t) => t.id));
    const items = args.droppableContainers.filter((c) => ids.has(Number(c.id)));
    return items.length ? closestCenter({ ...args, droppableContainers: items }) : zones;
  };

  const saveOrder = (empId: number, tasks: Task[]) => api.put(`/queues/${empId}`, { taskIds: tasks.map((t) => t.id) });

  const reset = () => {
    setActiveTask(null);
    setActiveCol(null);
    setOverEmp(null);
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith(COL)) setActiveCol(queues.find((x) => x.employee.id === Number(id.slice(COL.length))) || null);
    else setActiveTask(queues.flatMap((x) => x.tasks).find((t) => t.id === Number(id)) || null);
  };

  const onDragOver = (e: DragOverEvent) => setOverEmp(String(e.active.id).startsWith(COL) || !e.over ? null : empOf(e.over.id));

  const onDragEnd = async (e: DragEndEvent) => {
    reset();
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    // Перестановка сотрудников
    if (activeId.startsWith(COL)) {
      const from = queues.findIndex((x) => COL + x.employee.id === activeId);
      const to = queues.findIndex((x) => COL + x.employee.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      const next = arrayMove(queues, from, to);
      setQueues(next);
      try {
        await api.put('/employees-order', { ids: next.map((x) => x.employee.id) });
        reloadEmployees();
      } catch (err: any) {
        toast(err.message, 'error');
      }
      return;
    }

    const taskId = Number(activeId);
    const src = empOf(taskId);
    const dst = empOf(overId);
    if (src === null || dst === null) return;
    const srcQ = queues.find((x) => x.employee.id === src)!;
    const dstQ = queues.find((x) => x.employee.id === dst)!;
    const task = srcQ.tasks.find((t) => t.id === taskId)!;
    const overIdx = dstQ.tasks.findIndex((t) => t.id === Number(overId));

    // Внутри одной очереди — только порядок
    if (src === dst) {
      if (overIdx < 0 || taskId === Number(overId)) return;
      const tasks = arrayMove(srcQ.tasks, srcQ.tasks.indexOf(task), overIdx);
      setQueues(queues.map((x) => (x.employee.id === src ? { ...x, tasks } : x)));
      saveOrder(src, tasks).catch((err) => toast(err.message, 'error'));
      return;
    }

    // Перенос к другому сотруднику — смена ответственного в Б24
    const prev = queues;
    const moved = { ...task, responsible_id: dst, responsible_name: dstQ.employee.name };
    const dstTasks = [...dstQ.tasks];
    dstTasks.splice(overIdx < 0 ? dstTasks.length : overIdx, 0, moved);
    setQueues(queues.map((x) =>
      x.employee.id === src ? { ...x, tasks: x.tasks.filter((t) => t.id !== taskId) } : x.employee.id === dst ? { ...x, tasks: dstTasks } : x,
    ));
    try {
      await api.post(`/tasks/${taskId}/responsible`, { responsibleId: dst });
      await saveOrder(dst, dstTasks);
      toast(`#${taskId} → ${dstQ.employee.name}`, 'ok');
      bump();
    } catch (err: any) {
      setQueues(prev);
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Очереди задач</h1>
        <span className="muted small">
          Колонки сотрудников перетаскиваются за шапку. Задачу можно перетащить в очередь другого сотрудника — он станет ответственным в Битрикс24.
        </span>
      </div>
      {queues.length === 0 && <div className="card muted">Нет сотрудников. <a href="#/employees">Добавить →</a></div>}
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={reset}>
        <SortableContext items={queues.map((x) => COL + x.employee.id)} strategy={rectSortingStrategy}>
          <div className="queues">
            {queues.map((qu) => (
              <QueueColumn
                key={qu.employee.id}
                queue={qu}
                isTarget={!!activeTask && overEmp === qu.employee.id && activeTask.responsible_id !== qu.employee.id}
                onPlan={() => setPlanFor(qu)}
                onPick={() => setPickFor(qu)}
                onOpen={() => onOpen(qu.employee.id)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeTask && <TaskCard task={activeTask} className="dragging" showResponsible={false} showStage />}
          {activeCol && <div className="queue card dragging-col"><QueueHeader employee={activeCol.employee} /></div>}
        </DragOverlay>
      </DndContext>
      {planFor && <PlanModal queue={planFor} onClose={() => setPlanFor(null)} />}
      {pickFor && <PickModal queue={pickFor} onClose={() => setPickFor(null)} />}
    </>
  );
}

function QueueHeader({ employee: e, handle }: { employee: Employee; handle?: Record<string, unknown> }) {
  return (
    <div className="queue-head" {...handle}>
      <span className="grip" title="Перетащите, чтобы поменять порядок">⋮⋮</span>
      <Avatar name={e.name} icon={e.photo} size={34} />
      <div className="queue-head-text">
        <div className="emp-name">{e.name}{!!e.is_buffer && <span className="chip warn buffer-chip">буфер</span>}</div>
        <div className="muted small">{e.position || ''}</div>
        <AbsenceBadge employee={e} />
      </div>
    </div>
  );
}

function QueueColumn({ queue, isTarget, onPlan, onPick, onOpen }: { queue: Queue; isTarget: boolean; onPlan: () => void; onPick: () => void; onOpen: () => void }) {
  const { toast, bump, meta } = useApp();
  const { employee: e, tasks } = queue;
  const sortable = useSortable({ id: COL + e.id });
  const drop = useDroppable({ id: DROP + e.id });
  // «В работе» / «на паузе»: в группах со стадией «Выполняются» — по стадии, иначе по статусу задачи
  const isWorking = (t: Task) => taskState(meta, t).working;
  const isPaused = (t: Task) => taskState(meta, t).paused;
  const inWork = tasks.filter(isWorking);
  const next = tasks.find((t) => !isWorking(t) && !isPaused(t) && t.status !== 4);
  const overdue = tasks.filter((t) => t.deadline && new Date(t.deadline) < new Date()).length;
  const estHours = tasks.reduce((s, t) => s + (t.time_estimate || 0), 0) / 3600;

  const start = async (t: Task) => {
    try {
      const workStage = t.group_id != null ? meta?.workByGroup[t.group_id] : undefined;
      if (workStage) await api.post(`/tasks/${t.id}/stage`, { stageId: workStage });
      else await api.post(`/tasks/${t.id}/status`, { action: 'start' });
      toast(`#${t.id} взята в работу`, 'ok');
      bump();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  return (
    <div
      ref={sortable.setNodeRef}
      className={`queue card ${e.is_buffer ? 'buffer' : ''} ${isTarget ? 'drop-target' : ''}`}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.4 : 1 }}
    >
      <QueueHeader employee={e} handle={{ ...sortable.attributes, ...sortable.listeners }} />
      <div className="queue-stats">
        <span><b>{tasks.length}</b> в очереди</span>
        <span><b className="accent-text">{inWork.length}</b> в работе</span>
        {overdue > 0 && <span><b className="danger-text">{overdue}</b> просроч.</span>}
        {estHours > 0 && <span><b>{Math.round(estHours)}</b> ч оценка</span>}
      </div>
      {!!e.is_buffer && tasks.length > 0 && (
        <div className="queue-buffer-hint">Буфер: перетащите задачу в очередь сотрудника, чтобы назначить её</div>
      )}
      {!e.is_buffer && inWork.length === 0 && next && (
        <div className="queue-next">
          Нет задачи в работе. Следующая: <b>#{next.id}</b>
          <button className="btn sm primary" onClick={() => start(next)}>Начать</button>
        </div>
      )}
      <div className="row">
        <button className="btn sm" onClick={onOpen}>Канбан</button>
        <button className="btn sm" onClick={onPlan} disabled={!tasks.length}>Цепочка в Гант</button>
        <button className="btn sm ghost" onClick={onPick}>+ Из бэклога</button>
      </div>
      <div ref={drop.setNodeRef} className="queue-list">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 && <div className="muted small center queue-empty">Очередь пуста</div>}
          {tasks.map((t, i) => <SortableItem key={t.id} task={t} index={i} />)}
        </SortableContext>
      </div>
    </div>
  );
}

function SortableItem({ task, index }: { task: Task; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div ref={setNodeRef} className="queue-item" style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      <span className="queue-pos">{index + 1}</span>
      <TaskCard
        task={task}
        showResponsible={false}
        showStage
        dragHandleProps={{ ...attributes, ...listeners }}
        extra={task.start_date_plan && <span className="chip muted" title="План">{fmtDate(task.start_date_plan)}–{fmtDate(task.end_date_plan)}</span>}
      />
    </div>
  );
}

interface PlanRow { taskId: number; title: string; days: number; start: string; end: string; deadline: string | null; conflict: boolean }

function PlanModal({ queue, onClose }: { queue: Queue; onClose: () => void }) {
  const { toast, bump } = useApp();
  const [startDate, setStartDate] = useState(toYmd(new Date().toISOString()));
  const [link, setLink] = useState(true);
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/queues/${queue.employee.id}/plan`;

  useEffect(() => {
    api.post<{ plan: PlanRow[] }>(url, { startDate }).then((r) => setPlan(r.plan)).catch((e) => toast(e.message, 'error'));
  }, [startDate, url, toast]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ errors: string[] }>(url, { startDate, link, apply: true });
      if (r.errors.length) toast(`Применено с ошибками:\n${r.errors.join('\n')}`, 'error');
      else toast('План записан в Битрикс24', 'ok');
      bump();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2>Цепочка задач: {queue.employee.name}</h2>
        <p className="muted small">
          Задачи из очереди (кроме стоящих на паузе, отложенных и ждущих контроля) встают друг за другом по рабочим дням. Длительность берётся из оценки времени, затем из текущего плана, иначе — значение по умолчанию из настроек.
        </p>
        <div className="row">
          <label className="field inline"><span>Начало</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> Связать задачи «окончание → начало»</label>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Задача</th><th>Дней</th><th>Начало</th><th>Окончание</th><th>Крайний срок</th></tr></thead>
            <tbody>
              {!plan && <tr><td colSpan={6} className="muted">Расчёт…</td></tr>}
              {plan?.map((p, i) => (
                <tr key={p.taskId} className={p.conflict ? 'row-danger' : ''}>
                  <td className="muted">{i + 1}</td>
                  <td>#{p.taskId} {p.title}</td>
                  <td>{p.days}</td>
                  <td>{fmtDate(p.start)}</td>
                  <td>{fmtDate(p.end)}</td>
                  <td>{p.deadline ? fmtDate(p.deadline) : '—'} {p.conflict && <span className="chip danger">не успевает</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={busy || !plan?.length} onClick={apply}>{busy ? 'Записываю…' : 'Записать план в Б24'}</button>
        </div>
      </div>
    </div>
  );
}

function PickModal({ queue, onClose }: { queue: Queue; onClose: () => void }) {
  const { meta, toast, bump, employees } = useApp();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const empIds = new Set(employees.map((e) => e.id));
  const stageTitle = (id: number | null) => meta?.allStages.find((s) => s.id === id)?.title || '—';
  const depTitle = (t: Task) => departmentOf(meta, t)?.title;

  useEffect(() => {
    api.get<Task[]>('/tasks?scope=departments').then((all) =>
      setTasks(all.filter((t) => t.status !== 5 && t.status !== 7 && t.responsible_id !== queue.employee.id)
        .sort((a, b) => Number(empIds.has(a.responsible_id!)) - Number(empIds.has(b.responsible_id!)) || (a.stage_id || 0) - (b.stage_id || 0))),
    );
  }, []); // eslint-disable-line

  const assign = async (t: Task) => {
    setBusy(true);
    try {
      await api.post(`/tasks/${t.id}/responsible`, { responsibleId: queue.employee.id });
      toast(`#${t.id} назначена: ${queue.employee.name}`, 'ok');
      bump();
      setTasks((ts) => ts!.filter((x) => x.id !== t.id));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const list = (tasks || []).filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()) || String(t.id).includes(search));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2>Назначить задачу: {queue.employee.name}</h2>
        <input className="search" autoFocus placeholder="Поиск по задачам отдела" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="pick-list">
          {!tasks && <div className="muted">Загрузка…</div>}
          {list.map((t) => (
            <div key={t.id} className="pick-row">
              <div>
                <div>#{t.id} {t.title}</div>
                <div className="muted small">{depTitle(t) ? `${depTitle(t)} · ` : ''}{stageTitle(t.stage_id)} · {t.responsible_name || 'без ответственного'}{t.deadline ? ` · до ${fmtDate(t.deadline)}` : ''}</div>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => assign(t)}>Назначить</button>
            </div>
          ))}
        </div>
        <div className="row end"><button className="btn ghost" onClick={onClose}>Закрыть</button></div>
      </div>
    </div>
  );
}
