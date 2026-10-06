// Очереди для большой команды: «Нагрузка» (строка на сотрудника) и «Распределение» (задачи → люди).
import { useEffect, useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api, deadlineState, departmentOf, fmtDate, fmtYmdShort, stagesOf, taskState, type Employee, type Meta, type Task } from '../api';
import { useApp } from '../App';
import { Avatar } from '../components/TaskCard';
import { AbsenceBadge } from '../components/AbsenceBadge';
import { PickModal, PlanModal, SortableItem, type Queue } from './Queues';

// ---------- Показатели сотрудника ----------
export interface QueueStats {
  open: number;
  working: Task[];
  next: Task | null;
  overdue: number;
  estHours: number;
  absent: boolean;
  idle: boolean;
  overloaded: boolean;
  load: number; // доля от нормы, 1 = норма
}

export function queueStats(meta: Meta | null, q: Queue, norm: number): QueueStats {
  const working = q.tasks.filter((t) => taskState(meta, t).working);
  const next = q.tasks.find((t) => { const s = taskState(meta, t); return !s.working && !s.paused && t.status !== 4; }) || null;
  const absent = !!q.employee.absence_now;
  const open = q.tasks.length;
  return {
    open,
    working,
    next,
    overdue: q.tasks.filter((t) => deadlineState(t) === 'overdue').length,
    estHours: Math.round(q.tasks.reduce((s, t) => s + (t.time_estimate || 0), 0) / 3600),
    absent,
    idle: !absent && working.length === 0,
    overloaded: open > norm,
    load: norm > 0 ? open / norm : 0,
  };
}

function LoadBar({ stats, norm }: { stats: QueueStats; norm: number }) {
  const pct = Math.min(100, Math.round(stats.load * 100));
  const tone = stats.load > 1 ? 'danger' : stats.load > 0.8 ? 'warn' : 'ok';
  return (
    <div className="loadbar" title={`Открытых задач: ${stats.open} при норме ${norm}`}>
      <div className={`loadbar-fill ${tone}`} style={{ width: `${Math.max(pct, stats.open ? 4 : 0)}%` }} />
      <span className="loadbar-text">{stats.open} / {norm}</span>
    </div>
  );
}

function Flags({ s }: { s: QueueStats }) {
  return (
    <>
      {s.idle && <span className="chip warn" title="Нет задачи в работе">простаивает</span>}
      {s.overloaded && <span className="chip danger" title="Открытых задач больше нормы">перегружен</span>}
      {s.overdue > 0 && <span className="chip danger">просрочено {s.overdue}</span>}
    </>
  );
}

const teamOf = (e: Employee) => (e.department || '').trim() || 'Без команды';

// ---------- Нагрузка ----------
type Problem = 'idle' | 'overloaded' | 'overdue' | 'absent';
const PROBLEMS: { id: Problem; label: string }[] = [
  { id: 'idle', label: 'Простаивают' },
  { id: 'overloaded', label: 'Перегружены' },
  { id: 'overdue', label: 'С просрочками' },
  { id: 'absent', label: 'Отсутствуют' },
];

export function LoadView({ queues, norm, onOpen, reload }: { queues: Queue[]; norm: number; onOpen: (id: number) => void; reload: () => void }) {
  const { meta, toast, bump, openTask } = useApp();
  const [search, setSearch] = useState('');
  const [team, setTeam] = useState('');
  const [problems, setProblems] = useState<Set<Problem>>(new Set());
  const [sort, setSort] = useState<'order' | 'load' | 'free' | 'name' | 'overdue'>('order');
  const [groupByTeam, setGroupByTeam] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [planFor, setPlanFor] = useState<Queue | null>(null);
  const [pickFor, setPickFor] = useState<Queue | null>(null);

  const rows = useMemo(() => queues.map((q) => ({ q, s: queueStats(meta, q, norm) })), [queues, meta, norm]);
  const teams = useMemo(() => [...new Set(queues.map((q) => teamOf(q.employee)))].sort(), [queues]);

  const visible = rows.filter(({ q, s }) => {
    if (search && !q.employee.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (team && teamOf(q.employee) !== team) return false;
    for (const p of problems) {
      if (p === 'idle' && !s.idle) return false;
      if (p === 'overloaded' && !s.overloaded) return false;
      if (p === 'overdue' && !s.overdue) return false;
      if (p === 'absent' && !s.absent) return false;
    }
    return true;
  });
  const sorted = [...visible].sort((a, b) => {
    if (sort === 'load') return b.s.open - a.s.open;
    if (sort === 'free') return a.s.open - b.s.open;
    if (sort === 'overdue') return b.s.overdue - a.s.overdue;
    if (sort === 'name') return a.q.employee.name.localeCompare(b.q.employee.name);
    return 0; // порядок из «Колонок» / списка сотрудников
  });
  const grouped = groupByTeam && teams.length > 1
    ? teams.map((t) => ({ team: t, items: sorted.filter((r) => teamOf(r.q.employee) === t) })).filter((g) => g.items.length)
    : [{ team: '', items: sorted }];

  // Сводка по команде
  const total = rows.reduce((a, { s }) => ({ open: a.open + s.open, working: a.working + (s.working.length ? 1 : 0), idle: a.idle + (s.idle ? 1 : 0), overloaded: a.overloaded + (s.overloaded ? 1 : 0), overdue: a.overdue + s.overdue, absent: a.absent + (s.absent ? 1 : 0) }),
    { open: 0, working: 0, idle: 0, overloaded: 0, overdue: 0, absent: 0 });

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };

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
    <>
      <div className="team-summary">
        <span><b>{queues.length}</b> сотрудников</span>
        <span><b>{total.open}</b> открытых задач</span>
        <span><b className="accent-text">{total.working}</b> в работе</span>
        <button className={`chip ${problems.has('idle') ? 'on' : ''} ${total.idle ? 'warn' : 'muted'}`} onClick={() => setProblems(toggle(problems, 'idle'))}>простаивают: {total.idle}</button>
        <button className={`chip ${problems.has('overloaded') ? 'on' : ''} ${total.overloaded ? 'danger' : 'muted'}`} onClick={() => setProblems(toggle(problems, 'overloaded'))}>перегружены: {total.overloaded}</button>
        <button className={`chip ${problems.has('overdue') ? 'on' : ''} ${total.overdue ? 'danger' : 'muted'}`} onClick={() => setProblems(toggle(problems, 'overdue'))}>просрочек: {total.overdue}</button>
        <button className={`chip ${problems.has('absent') ? 'on' : ''} muted`} onClick={() => setProblems(toggle(problems, 'absent'))}>отсутствуют: {total.absent}</button>
      </div>

      <div className="toolbar load-toolbar">
        <input className="search" placeholder="Поиск сотрудника" value={search} onChange={(e) => setSearch(e.target.value)} />
        {teams.length > 1 && (
          <select value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">Все команды</option>
            {teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="order">Порядок как в «Колонках»</option>
          <option value="load">Сначала загруженные</option>
          <option value="free">Сначала свободные</option>
          <option value="overdue">Сначала с просрочками</option>
          <option value="name">По имени</option>
        </select>
        {teams.length > 1 && <label className="check"><input type="checkbox" checked={groupByTeam} onChange={(e) => setGroupByTeam(e.target.checked)} /> По командам</label>}
        <button className="btn ghost sm" onClick={() => setExpanded(expanded.size ? new Set() : new Set(sorted.map((r) => r.q.employee.id)))}>
          {expanded.size ? 'Свернуть все' : 'Развернуть все'}
        </button>
      </div>
      <p className="muted small page-note">
        Команда — поле «Отдел» в карточке сотрудника. Норма загрузки ({norm} задач) меняется в «Кабинете». Строка раскрывается в очередь: порядок задач меняется перетаскиванием.
      </p>

      {sorted.length === 0 && <div className="card muted center">Никого не найдено</div>}
      {grouped.map((g) => (
        <div key={g.team || 'all'} className="load-group">
          {g.team && <div className="load-group-title">{g.team} <span className="muted">· {g.items.length}</span></div>}
          <div className="load-list card">
            {g.items.map(({ q, s }) => {
              const e = q.employee;
              const open = expanded.has(e.id);
              const cur = s.working[0];
              return (
                <div key={e.id} className={`load-row ${open ? 'open' : ''} ${s.absent ? 'absent' : ''} ${e.is_buffer ? 'buffer' : ''}`}>
                  <div className="load-main" onClick={() => setExpanded(toggle(expanded, e.id))}>
                    <span className="load-caret">{open ? '▾' : '▸'}</span>
                    <Avatar name={e.name} icon={e.photo} size={30} />
                    <div className="load-who">
                      <div className="emp-name">{e.name}{!!e.is_buffer && <span className="chip warn buffer-chip">буфер</span>}</div>
                      <div className="load-who-sub"><AbsenceBadge employee={e} compact /><span className="muted small">{e.position || ''}</span></div>
                    </div>
                    <LoadBar stats={s} norm={norm} />
                    <div className="load-now">
                      {cur ? (
                        <button className="link load-task" onClick={(ev) => { ev.stopPropagation(); openTask(cur.id); }} title={cur.title}>
                          <span className="dot-work" />#{cur.id} {cur.title}{s.working.length > 1 && <span className="muted"> +{s.working.length - 1}</span>}
                        </button>
                      ) : s.next && !s.absent ? (
                        <span className="load-task muted">
                          следующая: <button className="link" onClick={(ev) => { ev.stopPropagation(); openTask(s.next!.id); }}>#{s.next.id} {s.next.title}</button>
                          <button className="btn xs primary" onClick={(ev) => { ev.stopPropagation(); void start(s.next!); }}>Начать</button>
                        </span>
                      ) : (
                        <span className="muted small">{s.absent ? 'отсутствует' : 'очередь пуста'}</span>
                      )}
                    </div>
                    <div className="load-nums">
                      <span title="В работе"><b className="accent-text">{s.working.length}</b> в раб.</span>
                      {s.estHours > 0 && <span title="Сумма оценок открытых задач"><b>{s.estHours}</b> ч</span>}
                    </div>
                    <div className="load-flags"><Flags s={s} /></div>
                    <div className="load-actions" onClick={(ev) => ev.stopPropagation()}>
                      <button className="btn ghost xs" title="Канбан сотрудника" onClick={() => onOpen(e.id)}>Канбан</button>
                      <button className="btn ghost xs" title="Назначить задачу из отделов" onClick={() => setPickFor(q)}>+ задача</button>
                      <button className="btn ghost xs" title="Выстроить очередь цепочкой в Ганте" disabled={!q.tasks.length} onClick={() => setPlanFor(q)}>Гант</button>
                    </div>
                  </div>
                  {open && <InlineQueue queue={q} onChanged={reload} />}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {planFor && <PlanModal queue={planFor} onClose={() => setPlanFor(null)} />}
      {pickFor && <PickModal queue={pickFor} onClose={() => setPickFor(null)} />}
    </>
  );
}

/** Раскрытая очередь сотрудника: перестановка задач */
function InlineQueue({ queue, onChanged }: { queue: Queue; onChanged: () => void }) {
  const { toast } = useApp();
  const [tasks, setTasks] = useState(queue.tasks);
  useEffect(() => setTasks(queue.tasks), [queue.tasks]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(tasks, tasks.findIndex((t) => t.id === e.active.id), tasks.findIndex((t) => t.id === e.over!.id));
    setTasks(next);
    api.put(`/queues/${queue.employee.id}`, { taskIds: next.map((t) => t.id) }).then(onChanged).catch((err) => toast(err.message, 'error'));
  };
  if (!tasks.length) return <div className="load-queue muted small">Очередь пуста</div>;
  return (
    <div className="load-queue">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="load-queue-list">
            {tasks.map((t, i) => <SortableItem key={t.id} task={t} index={i} />)}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

// ---------- Распределение ----------
const FREE = 'free';

export function DistributeView({ queues, norm, reload }: { queues: Queue[]; norm: number; reload: () => void }) {
  const { meta, toast, bump, openTask } = useApp();
  const buffers = queues.filter((q) => q.employee.is_buffer);
  const [source, setSource] = useState<string>(() => (buffers[0] ? String(buffers[0].employee.id) : FREE));
  const [freeTasks, setFreeTasks] = useState<Task[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [targetSort, setTargetSort] = useState<'free' | 'name' | 'team'>('free');
  const [targetSearch, setTargetSearch] = useState('');
  const [dragged, setDragged] = useState<Task | null>(null);
  const [confirm, setConfirm] = useState<{ ids: number[]; emp: Employee } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (source !== FREE) return;
    api.get<Task[]>('/tasks?scope=departments').then((ts) => setFreeTasks(ts.filter((t) => !t.is_employee && t.status !== 5 && t.status !== 7))).catch((e) => toast(e.message, 'error'));
  }, [source, queues, toast]);
  useEffect(() => setSelected(new Set()), [source]);

  const sourceTasks = source === FREE ? freeTasks || [] : queues.find((q) => String(q.employee.id) === source)?.tasks || [];
  const list = sourceTasks.filter((t) => !search || `${t.id} ${t.title} ${(t.tags || []).join(' ')}`.toLowerCase().includes(search.toLowerCase()));

  const targets = queues
    .filter((q) => String(q.employee.id) !== source)
    .filter((q) => !targetSearch || q.employee.name.toLowerCase().includes(targetSearch.toLowerCase()))
    .map((q) => ({ q, s: queueStats(meta, q, norm) }))
    .sort((a, b) => {
      if (targetSort === 'name') return a.q.employee.name.localeCompare(b.q.employee.name);
      if (targetSort === 'team') return teamOf(a.q.employee).localeCompare(teamOf(b.q.employee)) || a.s.open - b.s.open;
      // Сначала свободные: отсутствующие — в конец
      return Number(a.s.absent) - Number(b.s.absent) || a.s.open - b.s.open;
    });

  const assign = async (ids: number[], emp: Employee, force = false) => {
    if (!ids.length) return;
    if (emp.absence_now && !force) return setConfirm({ ids, emp });
    setConfirm(null);
    setBusy(true);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await api.post(`/tasks/${id}/responsible`, { responsibleId: emp.id });
        ok++;
      } catch (e: any) {
        errors.push(`#${id}: ${e.message}`);
      }
    }
    setBusy(false);
    setSelected(new Set());
    if (errors.length) toast(`Назначено ${ok} из ${ids.length}. Ошибки:\n${errors.join('\n')}`, 'error');
    else toast(ok === 1 ? `#${ids[0]} → ${emp.name}` : `${ok} задач → ${emp.name}`, 'ok');
    bump();
    reload();
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragStart = (e: DragStartEvent) => setDragged(sourceTasks.find((t) => t.id === e.active.id) || null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragged(null);
    const over = e.over?.id ? String(e.over.id) : '';
    if (!over.startsWith('emp:')) return;
    const emp = queues.find((q) => q.employee.id === Number(over.slice(4)))?.employee;
    if (!emp) return;
    const id = Number(e.active.id);
    // Тащим отмеченную задачу — переносим все отмеченные
    const ids = selected.has(id) ? [...selected] : [id];
    void assign(ids, emp);
  };

  const allChecked = list.length > 0 && list.every((t) => selected.has(t.id));
  const sourceName = (v: string) => (v === FREE ? 'Задачи отделов без исполнителя из ваших сотрудников' : queues.find((q) => String(q.employee.id) === v)?.employee.name);

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragged(null)}>
      <div className={`distribute ${busy ? 'busy' : ''}`}>
        <section className="card dist-source">
          <div className="dist-head">
            <select value={source} onChange={(e) => setSource(e.target.value)} title={sourceName(source)}>
              {buffers.map((q) => <option key={q.employee.id} value={q.employee.id}>Буфер: {q.employee.name} ({q.tasks.length})</option>)}
              <option value={FREE}>Без исполнителя из ваших сотрудников{freeTasks ? ` (${freeTasks.length})` : ''}</option>
              <optgroup label="Очередь сотрудника">
                {queues.filter((q) => !q.employee.is_buffer).map((q) => <option key={q.employee.id} value={q.employee.id}>{q.employee.name} ({q.tasks.length})</option>)}
              </optgroup>
            </select>
            <input className="search" placeholder="Поиск: название, ID, тег" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="dist-bulk">
            <label className="check">
              <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(list.map((t) => t.id)))} />
              {selected.size ? `Выбрано: ${selected.size}` : 'Выбрать все'}
            </label>
            {selected.size > 0 && <span className="muted small">— перетащите на сотрудника или нажмите «Назначить» справа</span>}
          </div>
          <div className="dist-list">
            {source === FREE && !freeTasks && <div className="muted small">Загрузка…</div>}
            {list.length === 0 && (source !== FREE || freeTasks) && <div className="muted small center">Нет задач</div>}
            {list.map((t) => (
              <DistTask key={t.id} task={t} meta={meta} checked={selected.has(t.id)} onCheck={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }} onOpen={() => openTask(t.id)} />
            ))}
          </div>
        </section>

        <section className="card dist-targets">
          <div className="dist-head">
            <input className="search" placeholder="Найти сотрудника" value={targetSearch} onChange={(e) => setTargetSearch(e.target.value)} />
            <select value={targetSort} onChange={(e) => setTargetSort(e.target.value as typeof targetSort)}>
              <option value="free">Сначала свободные</option>
              <option value="team">По командам</option>
              <option value="name">По имени</option>
            </select>
          </div>
          {confirm && (
            <div className="form-hint dist-confirm">
              {confirm.emp.name} отсутствует до {fmtYmdShort(confirm.emp.absence_now!.date_to)}. Всё равно назначить {confirm.ids.length === 1 ? `#${confirm.ids[0]}` : `${confirm.ids.length} задач`}?
              <button className="btn xs primary" onClick={() => assign(confirm.ids, confirm.emp, true)}>Назначить</button>
              <button className="btn xs ghost" onClick={() => setConfirm(null)}>Отмена</button>
            </div>
          )}
          <div className="dist-target-list">
            {targets.map(({ q, s }) => (
              <DistTarget key={q.employee.id} q={q} s={s} norm={norm} selectedCount={selected.size} onAssign={() => assign([...selected], q.employee)} />
            ))}
          </div>
        </section>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged && (
          <div className="dist-task dragging">
            #{dragged.id} {dragged.title}
            {selected.has(dragged.id) && selected.size > 1 && <span className="chip accent">+{selected.size - 1}</span>}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function DistTask({ task: t, meta, checked, onCheck, onOpen }: { task: Task; meta: Meta | null; checked: boolean; onCheck: () => void; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id });
  const dep = departmentOf(meta, t);
  const stage = stagesOf(meta, t.group_id).find((s) => s.id === t.stage_id);
  const dl = deadlineState(t);
  return (
    <div ref={setNodeRef} className={`dist-task ${checked ? 'checked' : ''}`} style={{ opacity: isDragging ? 0.4 : 1, ['--dep' as string]: dep?.color }} {...attributes} {...listeners}>
      <input type="checkbox" checked={checked} onChange={onCheck} onPointerDown={(e) => e.stopPropagation()} />
      <div className="dist-task-main">
        <button className="link" onPointerDown={(e) => e.stopPropagation()} onClick={onOpen}>#{t.id} {t.title}</button>
        <div className="dist-task-meta">
          {dep && <span className="chip dep-chip">{dep.title}</span>}
          {stage && <span className="chip muted">{stage.title}</span>}
          {t.deadline && <span className={`chip ${dl === 'overdue' ? 'danger' : dl === 'soon' ? 'warn' : 'muted'}`}>⏱ {fmtDate(t.deadline)}</span>}
          {(t.time_estimate || 0) > 0 && <span className="chip muted">{Math.round(t.time_estimate! / 3600)} ч</span>}
          {!t.is_employee && t.responsible_name && <span className="muted small">сейчас: {t.responsible_name}</span>}
        </div>
      </div>
    </div>
  );
}

function DistTarget({ q, s, norm, selectedCount, onAssign }: { q: Queue; s: QueueStats; norm: number; selectedCount: number; onAssign: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `emp:${q.employee.id}` });
  const e = q.employee;
  return (
    <div ref={setNodeRef} className={`dist-target ${isOver ? 'over' : ''} ${s.absent ? 'absent' : ''}`}>
      <Avatar name={e.name} icon={e.photo} size={28} />
      <div className="dist-target-main">
        <div className="emp-name">{e.name}{!!e.is_buffer && <span className="chip warn buffer-chip">буфер</span>} <AbsenceBadge employee={e} compact /></div>
        <div className="dist-target-sub">
          <LoadBar stats={s} norm={norm} />
          <span className="muted small">{s.working.length} в раб.{s.overdue ? ` · ${s.overdue} просроч.` : ''}</span>
        </div>
      </div>
      {selectedCount > 0 && <button className="btn sm" onClick={onAssign}>Назначить{selectedCount > 1 ? ` (${selectedCount})` : ''}</button>}
    </div>
  );
}
