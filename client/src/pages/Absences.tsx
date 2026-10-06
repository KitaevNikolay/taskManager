import { useEffect, useMemo, useState } from 'react';
import {
  ABSENCE_TYPES, addDays, api, fmtDateTime, fmtYmd, isWeekend, toYmd, daysCount,
  type Absence, type AbsenceType, type Employee,
} from '../api';
import { useApp } from '../App';
import { Avatar } from '../components/TaskCard';
import { AbsenceBadge } from '../components/AbsenceBadge';
import { AbsenceImport, TemplateButtons } from '../components/AbsenceImport';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const VIEW_MONTHS = 2;
const DAY_W = 26;
const NAME_W = 240;

/** Закрытие модалки по Escape */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

const monthStart = (ymd: string) => ymd.slice(0, 8) + '01';
const shiftMonth = (ymd: string, n: number) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
};

type FormState = { id?: number; employee_id: number; type: AbsenceType; date_from: string; date_to: string; comment: string };

export function AbsencesPage() {
  const { employees, reloadEmployees, toast, version } = useApp();
  const today = toYmd(new Date().toISOString());
  const [start, setStart] = useState(monthStart(today));
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [impactFor, setImpactFor] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  const end = addDays(shiftMonth(start, VIEW_MONTHS), -1);
  const year = start.slice(0, 4);
  const loadFrom = start < `${year}-01-01` ? start : `${year}-01-01`;
  const loadTo = end > `${year}-12-31` ? end : `${year}-12-31`;

  const load = () => api.get<Absence[]>(`/absences?from=${loadFrom}&to=${loadTo}`).then(setAbsences).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), [loadFrom, loadTo, version]); // eslint-disable-line

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [start, end]);

  const afterSave = (saved: Absence | null, isNew: boolean) => {
    setForm(null);
    load();
    reloadEmployees();
    if (saved && isNew) setImpactFor(saved.id);
  };

  const openNew = (employee_id?: number, date?: string) =>
    setForm({ employee_id: employee_id ?? employees[0]?.id, type: 'vacation', date_from: date ?? today, date_to: date ?? today, comment: '' });

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>Отсутствия</h1>
        <div className="toolbar">
          <div className="seg">
            <button onClick={() => setStart(shiftMonth(start, -1))}>‹</button>
            <button onClick={() => setStart(monthStart(today))}>Сегодня</button>
            <button onClick={() => setStart(shiftMonth(start, 1))}>›</button>
          </div>
          <span className="month-title">
            {MONTHS[Number(start.slice(5, 7)) - 1]} – {MONTHS[Number(end.slice(5, 7)) - 1]} {end.slice(0, 4)}
          </span>
          <TemplateButtons />
          <button className="btn" disabled={!employees.length} onClick={() => setImporting(true)} title="Загрузить график отпусков из XLSX, CSV или JSON">Импорт из файла</button>
          <button className="btn primary" disabled={!employees.length} onClick={() => openNew()}>+ Добавить отсутствие</button>
        </div>
      </div>
      <div className="legend">
        {Object.entries(ABSENCE_TYPES).map(([k, t]) => (
          <span key={k}><i style={{ background: t.color }} />{t.label}</span>
        ))}
        <span className="muted small">Клик по дню — добавить отсутствие, по полосе — изменить. Сроки задач отсутствующих можно сдвинуть.</span>
      </div>

      {employees.length === 0 && <div className="card muted">Нет сотрудников. <a href="#/employees">Добавить →</a></div>}

      {employees.length > 0 && (
        <div className="abs-timeline card">
          <div className="abs-grid" style={{ width: NAME_W + days.length * DAY_W }}>
            <div className="abs-head">
              <div className="abs-name" style={{ width: NAME_W }} />
              {days.map((d) => (
                <div key={d} className={`abs-day ${isWeekend(d) ? 'we' : ''} ${d === today ? 'today' : ''} ${d.endsWith('-01') ? 'm1' : ''}`} style={{ width: DAY_W }}>
                  {d.endsWith('-01') && <span className="abs-month">{MONTHS[Number(d.slice(5, 7)) - 1]}</span>}
                  {Number(d.slice(8))}
                </div>
              ))}
            </div>
            {employees.map((e) => {
              const mine = absences.filter((a) => a.employee_id === e.id && a.date_to >= start && a.date_from <= end);
              return (
                <div key={e.id} className="abs-row">
                  <div className="abs-name" style={{ width: NAME_W }}>
                    <Avatar name={e.name} icon={e.photo} size={22} />
                    <span className="abs-emp">{e.name}</span>
                    <DayoffChip employee={e} />
                  </div>
                  {days.map((d) => (
                    <div
                      key={d}
                      className={`abs-cell ${isWeekend(d) ? 'we' : ''} ${d === today ? 'today' : ''}`}
                      style={{ width: DAY_W }}
                      onClick={() => openNew(e.id, d)}
                      title={`${e.name}: ${fmtYmd(d)}`}
                    />
                  ))}
                  {mine.map((a) => {
                    const s = a.date_from < start ? start : a.date_from;
                    const f = a.date_to > end ? end : a.date_to;
                    const left = NAME_W + days.indexOf(s) * DAY_W;
                    const width = (days.indexOf(f) - days.indexOf(s) + 1) * DAY_W - 2;
                    const t = ABSENCE_TYPES[a.type];
                    return (
                      <div
                        key={a.id}
                        className="abs-bar"
                        style={{ left, width, background: t.color }}
                        title={`${t.label}: ${fmtYmd(a.date_from)} – ${fmtYmd(a.date_to)} (${a.days} дн.)${a.comment ? `\n${a.comment}` : ''}`}
                        onClick={() => setForm({ id: a.id, employee_id: a.employee_id, type: a.type, date_from: a.date_from, date_to: a.date_to, comment: a.comment || '' })}
                      >
                        {width > 60 && <span>{t.label}{width > 120 && a.comment ? ` · ${a.comment}` : ''}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Summary year={year} absences={absences} onOpen={(a) => setForm({ id: a.id, employee_id: a.employee_id, type: a.type, date_from: a.date_from, date_to: a.date_to, comment: a.comment || '' })} onImpact={setImpactFor} />

      {form && <AbsenceForm initial={form} onClose={() => setForm(null)} onSaved={afterSave} onImpact={(id) => { setForm(null); setImpactFor(id); }} />}
      {importing && <AbsenceImport onClose={() => setImporting(false)} onDone={() => load()} onImpact={(id) => setImpactFor(id)} />}
      {impactFor !== null && <ImpactModal absenceId={impactFor} onClose={() => { setImpactFor(null); load(); }} />}
    </div>
  );
}

/** Остаток отгулов: «отгулы: 2», минус — красным */
export function DayoffChip({ employee }: { employee: Employee }) {
  const d = employee.dayoff;
  if (!d || (d.granted === 0 && d.used === 0)) return null;
  return (
    <span className={`chip ${d.left < 0 ? 'danger' : d.left > 0 ? 'ok' : 'muted'}`} title={`Отгулы: выдано ${d.granted}, использовано ${d.used}, остаток ${d.left}`}>
      отгулы {d.left}
    </span>
  );
}

function Summary({ year, absences, onOpen, onImpact }: { year: string; absences: Absence[]; onOpen: (a: Absence) => void; onImpact: (id: number) => void }) {
  const { employees, reloadEmployees, toast } = useApp();
  const today = toYmd(new Date().toISOString());
  const inYear = (a: Absence) => {
    const s = a.date_from < `${year}-01-01` ? `${year}-01-01` : a.date_from;
    const f = a.date_to > `${year}-12-31` ? `${year}-12-31` : a.date_to;
    return s <= f ? daysCount(s, f) : 0;
  };
  const adjust = async (e: Employee, delta: number) => {
    try {
      await api.post(`/employees/${e.id}/dayoffs`, { delta });
      reloadEmployees();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const upcoming = absences.filter((a) => a.date_to >= today).sort((a, b) => a.date_from.localeCompare(b.date_from));

  return (
    <div className="split abs-summary">
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr><th>Сотрудник</th><th title="Выдано / использовано / остаток">Отгулы</th><th>Отпуск {year}</th><th>Больничные {year}</th><th>Статус</th></tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const mine = absences.filter((a) => a.employee_id === e.id);
              const sum = (t: AbsenceType) => mine.filter((a) => a.type === t).reduce((n, a) => n + inYear(a), 0);
              const d = e.dayoff || { granted: 0, used: 0, left: 0 };
              return (
                <tr key={e.id}>
                  <td><span className="who"><Avatar name={e.name} icon={e.photo} size={22} /> {e.name}</span></td>
                  <td>
                    <span className="dayoff-cell">
                      <button className="btn ghost xs" title="Списать день" onClick={() => adjust(e, -1)}>−</button>
                      <b className={d.left < 0 ? 'danger-text' : ''}>{d.left}</b>
                      <button className="btn ghost xs" title="Выдать день" onClick={() => adjust(e, 1)}>+</button>
                      <span className="muted small">выдано {d.granted}, исп. {d.used}</span>
                    </span>
                  </td>
                  <td className="nums">{sum('vacation')} дн.</td>
                  <td className="nums">{sum('sick')} дн.</td>
                  <td><AbsenceBadge employee={e} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Текущие и предстоящие</h3>
        {upcoming.length === 0 && <div className="muted small">Нет запланированных отсутствий</div>}
        {upcoming.map((a) => {
          const e = employees.find((x) => x.id === a.employee_id);
          const t = ABSENCE_TYPES[a.type];
          return (
            <div key={a.id} className="abs-item">
              <i style={{ background: t.color }} />
              <div className="abs-item-main" onClick={() => onOpen(a)}>
                <div><b>{e?.name}</b> · {t.label}</div>
                <div className="muted small">{fmtYmd(a.date_from)} – {fmtYmd(a.date_to)} · {a.days} дн.{a.comment ? ` · ${a.comment}` : ''}</div>
              </div>
              <button className="btn sm" onClick={() => onImpact(a.id)} title="Задачи, сроки которых затрагивает отсутствие">
                Сроки{a.shifted ? ` ✓${a.shifted}` : ''}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AbsenceForm({ initial, onClose, onSaved, onImpact }: {
  initial: FormState; onClose: () => void; onSaved: (a: Absence | null, isNew: boolean) => void; onImpact: (id: number) => void;
}) {
  const { employees, toast } = useApp();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEscape(onClose);
  const emp = employees.find((e) => e.id === f.employee_id);
  const valid = f.date_from && f.date_to && f.date_to >= f.date_from;
  const wd = valid ? daysCount(f.date_from, f.date_to) : 0;

  // Остаток отгулов после сохранения (с учётом того, что редактируемый отгул уже посчитан)
  let leftAfter: number | null = null;
  if (f.type === 'dayoff' && emp?.dayoff) {
    const was = initial.id && initial.type === 'dayoff' && initial.employee_id === f.employee_id ? daysCount(initial.date_from, initial.date_to) : 0;
    leftAfter = emp.dayoff.left + was - wd;
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f };
      const saved = f.id ? await api.put<Absence>(`/absences/${f.id}`, body) : await api.post<Absence>('/absences', body);
      toast('Сохранено', 'ok');
      onSaved(saved, !f.id);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/absences/${f.id}`);
      toast('Отсутствие удалено. Сдвинутые ранее сроки задач не возвращаются автоматически.', 'ok');
      onSaved(null, false);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card form abs-form" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{f.id ? 'Изменить отсутствие' : 'Новое отсутствие'}</h2>
        <label className="field">
          <span>Сотрудник</span>
          <select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: Number(e.target.value) })}>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <div className="field">
          <span>Тип</span>
          <div className="seg">
            {(Object.keys(ABSENCE_TYPES) as AbsenceType[]).map((t) => (
              <button type="button" key={t} className={f.type === t ? 'active' : ''} onClick={() => setF({ ...f, type: t })}>{ABSENCE_TYPES[t].label}</button>
            ))}
          </div>
        </div>
        <div className="row">
          <label className="field"><span>С</span><input type="date" value={f.date_from} onChange={(e) => setF({ ...f, date_from: e.target.value, date_to: f.date_to < e.target.value ? e.target.value : f.date_to })} required /></label>
          <label className="field"><span>По (включительно)</span><input type="date" value={f.date_to} min={f.date_from} onChange={(e) => setF({ ...f, date_to: e.target.value })} required /></label>
        </div>
        <div className="muted small">Дней: <b>{wd}</b> (календарных, включая первый и последний)</div>
        {leftAfter !== null && (
          <div className={`form-hint ${leftAfter < 0 ? 'danger' : 'ok'}`}>
            Отгулов останется: <b>{leftAfter}</b>
            {leftAfter < 0 && ' — отгулы уйдут в минус'}
          </div>
        )}
        <label className="field"><span>Комментарий</span><input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} placeholder="необязательно" /></label>
        <div className="row between">
          <div className="row">
            {f.id && !confirmDelete && <button type="button" className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Удалить</button>}
            {f.id && confirmDelete && <button type="button" className="btn danger" disabled={busy} onClick={remove}>Точно удалить?</button>}
            {f.id && <button type="button" className="btn ghost" onClick={() => onImpact(f.id!)}>Сроки задач</button>}
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>Отмена</button>
            <button className="btn primary" disabled={busy || !valid}>Сохранить</button>
          </div>
        </div>
      </form>
    </div>
  );
}

interface ImpactTask {
  taskId: number;
  title: string;
  changes: Record<string, { label: string; from: string; to: string }>;
  applied: boolean;
  appliedAt: string | null;
}

function ImpactModal({ absenceId, onClose }: { absenceId: number; onClose: () => void }) {
  const { employees, toast, bump, openTask } = useApp();
  const [data, setData] = useState<{ absence: Absence; tasks: ImpactTask[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEscape(onClose);

  const load = () =>
    api.get<{ absence: Absence; tasks: ImpactTask[] }>(`/absences/${absenceId}/impact`).then((d) => {
      setData(d);
      setSelected(new Set(d.tasks.filter((t) => !t.applied).map((t) => t.taskId)));
    }).catch((e) => { toast(e.message, 'error'); onClose(); });
  useEffect(() => void load(), [absenceId]); // eslint-disable-line

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: number; errors: string[] }>(`/absences/${absenceId}/apply`, { taskIds: [...selected] });
      if (r.errors.length) toast(`Сдвинуто: ${r.ok}. Ошибки:\n${r.errors.join('\n')}`, 'error');
      else toast(`Сроки сдвинуты в Битрикс24: ${r.ok}`, 'ok');
      bump();
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };

  const a = data?.absence;
  const emp = a && employees.find((e) => e.id === a.employee_id);
  const pending = data?.tasks.filter((t) => !t.applied) || [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        {!data || !a ? <div className="muted">Загрузка…</div> : (
          <>
            <h2>Сроки задач: {emp?.name}</h2>
            <p className="muted small">
              {ABSENCE_TYPES[a.type].label} {fmtYmd(a.date_from)} – {fmtYmd(a.date_to)} ({a.days} дн.).
              Срок задачи сдвигается на столько дней, сколько дней отсутствия приходится до него; если новая дата выпала на выходной или другое отсутствие — на ближайший рабочий день.
            </p>
            {data.tasks.length === 0 && <div className="card muted center">Отсутствие не затрагивает сроки открытых задач</div>}
            {data.tasks.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th /><th>Задача</th><th>Изменения</th></tr></thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={t.taskId} className={t.applied ? 'row-muted' : ''}>
                        <td>
                          {t.applied
                            ? <span className="chip ok" title={`Сдвинуто ${fmtDateTime(t.appliedAt)}`}>✓</span>
                            : <input type="checkbox" checked={selected.has(t.taskId)} onChange={() => toggle(t.taskId)} />}
                        </td>
                        <td><button className="link" onClick={() => openTask(t.taskId)}>#{t.taskId} {t.title}</button></td>
                        <td className="small">
                          {Object.values(t.changes).map((c) => (
                            <div key={c.label}>{c.label}: <span className="muted">{fmtDateTime(c.from)}</span> → <b>{fmtDateTime(c.to)}</b></div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="row end">
              <button className="btn ghost" onClick={onClose}>Закрыть</button>
              {pending.length > 0 && (
                <button className="btn primary" disabled={busy || selected.size === 0} onClick={apply}>
                  {busy ? 'Записываю…' : `Сдвинуть сроки в Б24 (${selected.size})`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
