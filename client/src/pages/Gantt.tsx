import { useEffect, useMemo, useRef, useState } from 'react';
import { ABSENCE_TYPES, api, fmtDate, fmtYmd, toYmd, type Absence, type Task } from '../api';
import { useApp } from '../App';

const ROW_H = 32;
const HEAD_H = 46;
const LABEL_W = 300;
const DAY_MS = 86400e3;

const dayNum = (ymd: string) => Math.round(Date.parse(ymd + 'T00:00:00Z') / DAY_MS);
const numToYmd = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

interface Row {
  kind: 'group' | 'task';
  label: string;
  respId?: number | null;
  task?: Task;
  start?: number; // номер дня
  end?: number;
  planned?: boolean;
}

interface Drag { taskId: number; mode: 'move' | 'l' | 'r'; x0: number; start: number; end: number; delta: number }

export function GanttPage() {
  const { employees, version, toast, bump, openTask, meta } = useApp();
  const [scope, setScope] = useState<string>('all');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [dayW, setDayW] = useState(28);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [onlyPlanned, setOnlyPlanned] = useState(false);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  const setDrag = (d: Drag | null | ((p: Drag | null) => Drag | null)) => {
    const next = typeof d === 'function' ? d(dragRef.current) : d;
    dragRef.current = next;
    setDragState(next);
  };
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = scope === 'all' ? '/tasks?scope=all' : scope === 'group' ? '/tasks?scope=group' : `/tasks?scope=employee&employeeId=${scope}`;
    api.get<Task[]>(url).then((ts) => setTasks(ts.filter((t) => t.status !== 5 && t.status !== 7))).catch((e) => toast(e.message, 'error'));
  }, [scope, version, toast]);

  const today = dayNum(toYmd(new Date().toISOString()));

  // Строки: группировка по ответственному
  const rows: Row[] = useMemo(() => {
    const empOrder = new Map(employees.map((e, i) => [e.id, i]));
    const groups = new Map<string, Task[]>();
    for (const t of tasks) {
      const key = t.responsible_name || '—';
      groups.set(key, [...(groups.get(key) || []), t]);
    }
    const sorted = [...groups.entries()].sort(([, a], [, b]) => {
      const ea = empOrder.get(a[0].responsible_id!) ?? 1e6;
      const eb = empOrder.get(b[0].responsible_id!) ?? 1e6;
      return ea - eb || (a[0].responsible_name || '').localeCompare(b[0].responsible_name || '');
    });
    const out: Row[] = [];
    for (const [name, list] of sorted) {
      const items = list.map((t) => {
        const s = t.start_date_plan ? dayNum(toYmd(t.start_date_plan)) : undefined;
        const e = t.end_date_plan ? dayNum(toYmd(t.end_date_plan)) : undefined;
        const planned = s !== undefined && e !== undefined;
        return { kind: 'task' as const, label: t.title, task: t, start: planned ? s : undefined, end: planned ? Math.max(e!, s!) : undefined, planned };
      }).filter((r) => !onlyPlanned || r.planned);
      if (!items.length) continue;
      items.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9) || (a.task.queue_pos ?? 1e9) - (b.task.queue_pos ?? 1e9));
      out.push({ kind: 'group', label: name, respId: list[0].responsible_id }, ...items);
    }
    return out;
  }, [tasks, employees, onlyPlanned]);

  // Диапазон дат
  const [from, to] = useMemo(() => {
    let lo = today - 7, hi = today + 30;
    for (const r of rows) {
      if (r.start !== undefined) lo = Math.min(lo, r.start - 3);
      if (r.end !== undefined) hi = Math.max(hi, r.end + 7);
      if (r.task?.deadline) {
        const d = dayNum(toYmd(r.task.deadline));
        lo = Math.min(lo, d - 3);
        hi = Math.max(hi, d + 7);
      }
    }
    lo = Math.max(lo, today - 180);
    hi = Math.min(hi, today + 365);
    return [lo, hi];
  }, [rows, today]);

  const days = to - from + 1;

  // Отсутствия сотрудников — штриховка на их строках
  useEffect(() => {
    api.get<Absence[]>(`/absences?from=${numToYmd(from)}&to=${numToYmd(to)}`).then(setAbsences).catch(() => setAbsences([]));
  }, [from, to, version]);
  const absStrips = (empId: number | null | undefined) =>
    absences.filter((a) => a.employee_id === empId).map((a) => {
      const s = Math.max(dayNum(a.date_from), from);
      const e = Math.min(dayNum(a.date_to), to);
      if (s > e) return null;
      const t = ABSENCE_TYPES[a.type];
      return (
        <div
          key={'abs' + a.id}
          className="gantt-absence"
          style={{ left: LABEL_W + (s - from) * dayW, width: (e - s + 1) * dayW, ['--abs' as string]: t.color }}
          title={`${t.label}: ${fmtYmd(a.date_from)} – ${fmtYmd(a.date_to)}`}
        />
      );
    });
  const width = days * dayW;
  const x = (d: number) => (d - from) * dayW;

  // Прокрутка к сегодняшнему дню
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, x(today) - 200);
  }, [from, dayW]); // eslint-disable-line

  // Перетаскивание баров
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, delta: Math.round((e.clientX - d.x0) / dayW) } : d));
    const up = async () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || d.delta === 0) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 50);
      let s = d.start, en = d.end;
      if (d.mode === 'move') { s += d.delta; en += d.delta; }
      if (d.mode === 'l') s = Math.min(s + d.delta, en);
      if (d.mode === 'r') en = Math.max(en + d.delta, s);
      const body = { startDatePlan: numToYmd(s), endDatePlan: numToYmd(en) };
      const prev = tasks;
      setTasks(tasks.map((t) => (t.id === d.taskId ? { ...t, start_date_plan: body.startDatePlan + 'T09:00:00+03:00', end_date_plan: body.endDatePlan + 'T18:00:00+03:00' } : t)));
      try {
        await api.patch(`/tasks/${d.taskId}/dates`, body);
        bump();
      } catch (err: any) {
        setTasks(prev);
        toast(err.message, 'error');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag?.taskId, drag?.mode, dayW]); // eslint-disable-line

  const barPos = (r: Row) => {
    if (r.start === undefined || r.end === undefined) return null;
    let s = r.start, e = r.end;
    if (drag && r.task?.id === drag.taskId) {
      if (drag.mode === 'move') { s += drag.delta; e += drag.delta; }
      if (drag.mode === 'l') s = Math.min(s + drag.delta, e);
      if (drag.mode === 'r') e = Math.max(e + drag.delta, s);
    }
    return { s, e };
  };

  const rowIndex = new Map<number, number>();
  rows.forEach((r, i) => r.task && rowIndex.set(r.task.id, i));

  const planTask = async (t: Task) => {
    const end = today + 1;
    try {
      await api.patch(`/tasks/${t.id}/dates`, { startDatePlan: numToYmd(today), endDatePlan: numToYmd(end) });
      bump();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const clickBar = async (t: Task) => {
    if (!linkMode) return openTask(t.id);
    if (linkFrom === null) return setLinkFrom(t.id);
    if (linkFrom === t.id) return setLinkFrom(null);
    try {
      await api.post(`/tasks/${t.id}/deps`, { predecessorId: linkFrom });
      toast(`Связь #${linkFrom} → #${t.id} добавлена`, 'ok');
      bump();
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setLinkFrom(null);
  };

  // Стрелки зависимостей
  const arrows: { d: string; bad: boolean; key: string }[] = [];
  for (const r of rows) {
    if (!r.task) continue;
    const toPos = barPos(r);
    for (const predId of r.task.depends_on) {
      const pi = rowIndex.get(predId);
      if (pi === undefined) continue;
      const fromPos = barPos(rows[pi]);
      if (!toPos || !fromPos) continue;
      const ti = rowIndex.get(r.task.id)!;
      const x1 = x(fromPos.e + 1), y1 = HEAD_H + pi * ROW_H + ROW_H / 2;
      const x2 = x(toPos.s), y2 = HEAD_H + ti * ROW_H + ROW_H / 2;
      const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 8));
      const d = x2 - 8 >= x1 + 8
        ? `M${x1},${y1} H${mid} V${y2} H${x2}`
        : `M${x1},${y1} H${x1 + 8} V${y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2)} H${x2 - 8} V${y2} H${x2}`;
      arrows.push({ d, bad: toPos.s <= fromPos.e, key: `${predId}-${r.task.id}` });
    }
  }

  // Шкала
  const headDays = [];
  for (let d = from; d <= to; d++) {
    const date = new Date(d * DAY_MS);
    headDays.push({ d, day: date.getUTCDate(), month: date.getUTCMonth(), year: date.getUTCFullYear(), we: date.getUTCDay() === 0 || date.getUTCDay() === 6 });
  }
  const conflicts = rows.filter((r) => r.task?.deadline && r.end !== undefined && r.end > dayNum(toYmd(r.task.deadline))).length;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>Гант</h1>
        <div className="toolbar">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">Отдел + задачи сотрудников</option>
            <option value="group">Только группа {meta?.groupId}</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyPlanned} onChange={(e) => setOnlyPlanned(e.target.checked)} /> Только с планом</label>
          <div className="seg">
            {[16, 28, 44].map((w) => <button key={w} className={dayW === w ? 'active' : ''} onClick={() => setDayW(w)}>{w === 16 ? 'Квартал' : w === 28 ? 'Месяц' : 'Неделя'}</button>)}
          </div>
          <button className={`btn sm ${linkMode ? 'primary' : ''}`} onClick={() => { setLinkMode(!linkMode); setLinkFrom(null); }}>
            {linkMode ? (linkFrom ? `Связь от #${linkFrom}: выберите следующую` : 'Режим связей: выберите первую задачу') : 'Связать задачи'}
          </button>
        </div>
      </div>
      <p className="muted small page-note">
        Тяните бар — сдвиг плана, края — изменение длительности. Изменения сразу пишутся в Битрикс24.
        {conflicts > 0 && <span className="danger-text"> Задач, план которых выходит за крайний срок: {conflicts}.</span>}
      </p>

      <div className="gantt card" ref={scrollRef}>
        <div className="gantt-inner" style={{ width: LABEL_W + width, height: HEAD_H + rows.length * ROW_H }}>
          {/* Шапка */}
          <div className="gantt-head" style={{ height: HEAD_H, left: 0, width: LABEL_W + width }}>
            <div className="gantt-corner" style={{ width: LABEL_W }}>Задача</div>
            <div className="gantt-scale" style={{ left: LABEL_W, width }}>
              {headDays.filter((h) => h.day === 1 || h.d === from).map((h) => (
                <div key={'m' + h.d} className="gantt-month" style={{ left: x(h.d) }}>{MONTHS[h.month]} {h.year}</div>
              ))}
              {headDays.map((h) => (
                <div key={h.d} className={`gantt-day ${h.we ? 'we' : ''} ${h.d === today ? 'today' : ''}`} style={{ left: x(h.d), width: dayW }}>
                  {dayW >= 20 || h.day % 2 === 1 ? h.day : ''}
                </div>
              ))}
            </div>
          </div>

          {/* Фон: выходные и сегодня */}
          <div className="gantt-bg" style={{ left: LABEL_W, top: HEAD_H, width, height: rows.length * ROW_H }}>
            {headDays.filter((h) => h.we).map((h) => <div key={h.d} className="gantt-we" style={{ left: x(h.d), width: dayW }} />)}
            <div className="gantt-today" style={{ left: x(today) + dayW / 2 }} />
          </div>

          {/* Строки */}
          {rows.map((r, i) => {
            const top = HEAD_H + i * ROW_H;
            if (r.kind === 'group') {
              return (
                <div key={'g' + i} className="gantt-group" style={{ top, height: ROW_H, width: LABEL_W + width }}>
                  {absStrips(r.respId)}
                  <span className="gantt-label" style={{ width: LABEL_W }}>{r.label}</span>
                </div>
              );
            }
            const t = r.task!;
            const pos = barPos(r);
            const dl = t.deadline ? dayNum(toYmd(t.deadline)) : null;
            const late = dl !== null && pos && pos.e > dl;
            return (
              <div key={t.id} className="gantt-row" style={{ top, height: ROW_H, width: LABEL_W + width }}>
                {absStrips(t.responsible_id)}
                <span className={`gantt-label task ${linkFrom === t.id ? 'link-src' : ''}`} style={{ width: LABEL_W }} onClick={() => (linkMode ? clickBar(t) : openTask(t.id))} title={t.title}>
                  <span className="gantt-label-text"><span className="task-id">#{t.id}</span> {t.title}</span>
                  {!pos && !linkMode && (
                    <button className="gantt-plan-btn" title="Задать план: сегодня + 2 дня" onClick={(e) => { e.stopPropagation(); planTask(t); }}>+ план</button>
                  )}
                </span>
                {pos ? (
                  <div
                    className={`gantt-bar st${t.status} ${late ? 'late' : ''} ${linkFrom === t.id ? 'link-src' : ''} ${linkMode ? 'linking' : ''}`}
                    style={{ left: LABEL_W + x(pos.s), width: (pos.e - pos.s + 1) * dayW - 2, top: 5, height: ROW_H - 10 }}
                    title={`${t.title}\n${fmtDate(numToYmd(pos.s))} – ${fmtDate(numToYmd(pos.e))}${t.deadline ? `\nКрайний срок: ${fmtDate(t.deadline)}` : ''}`}
                    onPointerDown={(e) => {
                      if (linkMode) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const mode = e.clientX - rect.left < 7 ? 'l' : rect.right - e.clientX < 7 ? 'r' : 'move';
                      setDrag({ taskId: t.id, mode, x0: e.clientX, start: r.start!, end: r.end!, delta: 0 });
                      e.preventDefault();
                    }}
                    onClick={() => !justDragged.current && clickBar(t)}
                  >
                    <span className="gantt-bar-text">{t.title}</span>
                  </div>
                ) : null}
                {dl !== null && dl >= from && dl <= to && (
                  <div className={`gantt-deadline ${late ? 'late' : ''}`} style={{ left: LABEL_W + x(dl) + dayW - 5, top: ROW_H / 2 - 5 }} title={`Крайний срок: ${fmtDate(t.deadline)}`} />
                )}
              </div>
            );
          })}

          {/* Стрелки */}
          <svg className="gantt-arrows" style={{ left: LABEL_W, top: 0 }} width={width} height={HEAD_H + rows.length * ROW_H}>
            <defs>
              <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--arrow)" /></marker>
              <marker id="arr-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" /></marker>
            </defs>
            {arrows.map((a) => (
              <path key={a.key} d={a.d} fill="none" stroke={a.bad ? 'var(--danger)' : 'var(--arrow)'} strokeWidth={1.5} markerEnd={`url(#${a.bad ? 'arr-bad' : 'arr'})`} />
            ))}
          </svg>
        </div>
        {rows.length === 0 && <div className="muted center" style={{ padding: 24 }}>Нет открытых задач</div>}
      </div>
    </div>
  );
}
