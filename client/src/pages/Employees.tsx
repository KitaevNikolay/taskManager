import { useState } from 'react';
import { api, type Employee } from '../api';
import { useApp } from '../App';
import { Avatar } from '../components/TaskCard';
import { AbsenceBadge } from '../components/AbsenceBadge';

const EMPTY = { id: '', name: '', department: '', email: '', position: '', photo: '', is_buffer: false, dayoff_granted: '0' };
type Form = typeof EMPTY;

export function EmployeesPage() {
  const { employees, reloadEmployees, toast } = useApp();
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  const set = (k: Exclude<keyof Form, 'is_buffer' | 'dayoff_granted'>) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const fill = async () => {
    if (!form.id) return toast('Введите ID сотрудника в Битрикс24', 'error');
    setBusy(true);
    setHint('');
    try {
      const u = await api.get<any>(`/bitrix/user/${form.id}`);
      setForm({
        ...form,
        name: u.name || form.name,
        position: u.position || form.position,
        email: u.email || form.email,
        department: u.department || form.department,
        photo: u.photo || form.photo,
      });
      if (u.hint) setHint(u.hint);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, id: Number(form.id), photo: form.photo || null, dayoff_granted: Number(form.dayoff_granted) || 0 };
      if (editing) await api.put(`/employees/${editing}`, body);
      else await api.post('/employees', body);
      toast(editing ? 'Сохранено' : 'Сотрудник добавлен, подтягиваю его задачи…', 'ok');
      setForm(EMPTY);
      setEditing(null);
      setHint('');
      reloadEmployees();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const edit = (e: Employee) => {
    setEditing(e.id);
    setHint('');
    setForm({ id: String(e.id), name: e.name, department: e.department || '', email: e.email || '', position: e.position || '', photo: e.photo || '', is_buffer: !!e.is_buffer, dayoff_granted: String(e.dayoff_granted ?? 0) });
  };

  const adjustDayoff = async (e: Employee, delta: number) => {
    try {
      await api.post(`/employees/${e.id}/dayoffs`, { delta });
      reloadEmployees();
      if (editing === e.id) setForm((f) => ({ ...f, dayoff_granted: String((Number(f.dayoff_granted) || 0) + delta) }));
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const remove = async (e: Employee) => {
    if (!window.confirm(`Удалить ${e.name} из списка? Задачи в Битрикс24 не изменятся.`)) return;
    await api.del(`/employees/${e.id}`);
    reloadEmployees();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Сотрудники</h1>
        <span className="muted">{employees.length} чел. · порядок меняется перетаскиванием колонок в «Очередях»</span>
      </div>

      <div className="split">
        <form className="card form" onSubmit={save}>
          <h3>{editing ? `Редактирование #${editing}` : 'Новый сотрудник'}</h3>
          <label className="field">
            <span>ID в Битрикс24</span>
            <div className="row">
              <input value={form.id} disabled={!!editing} onChange={(e) => setForm({ ...form, id: e.target.value.replace(/\D/g, '') })} placeholder="например, 227" />
              <button type="button" className="btn" onClick={fill} disabled={busy || !form.id}>Заполнить из Б24</button>
            </div>
          </label>
          {hint && <div className="form-hint">{hint}</div>}
          <label className="field"><span>ФИО</span><input value={form.name} onChange={set('name')} required /></label>
          <label className="field"><span>Отдел</span><input value={form.department} onChange={set('department')} /></label>
          <label className="field"><span>Почта</span><input type="email" value={form.email} onChange={set('email')} /></label>
          <label className="field"><span>Должность</span><input value={form.position} onChange={set('position')} /></label>
          <label className="field">
            <span>Выдано дней отгула (всего)</span>
            <input type="number" step="0.5" value={form.dayoff_granted} onChange={(e) => setForm({ ...form, dayoff_granted: e.target.value })} />
            {editing && (() => {
              const d = employees.find((x) => x.id === editing)?.dayoff;
              if (!d) return null;
              const left = (Number(form.dayoff_granted) || 0) - d.used;
              return <small className={left < 0 ? 'danger-text' : 'muted'}>Использовано {d.used}, остаток {left}</small>;
            })()}
          </label>
          <label className="check">
            <input type="checkbox" checked={form.is_buffer} onChange={(e) => setForm({ ...form, is_buffer: e.target.checked })} />
            Буфер — на него сначала ставятся задачи, затем распределяются
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy}>{editing ? 'Сохранить' : 'Добавить'}</button>
            {editing && <button type="button" className="btn ghost" onClick={() => { setEditing(null); setForm(EMPTY); setHint(''); }}>Отмена</button>}
          </div>
        </form>

        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Сотрудник</th><th>ID</th><th>Отдел</th><th>Должность</th><th>Почта</th>
                <th title="Открытые / в работе / просрочено">Задачи</th><th title="Остаток отгулов (выдано − использовано)">Отгулы</th><th />
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr><td colSpan={8} className="muted center">Добавьте сотрудников отдела — по ним строятся очереди, алерты и фильтры</td></tr>
              )}
              {employees.map((e) => (
                <tr key={e.id}>
                  <td><span className="who"><Avatar name={e.name} icon={e.photo} size={26} /> {e.name}{!!e.is_buffer && <span className="chip warn buffer-chip">буфер</span>}<AbsenceBadge employee={e} /></span></td>
                  <td className="muted">{e.id}</td>
                  <td>{e.department || <span className="muted">—</span>}</td>
                  <td>{e.position || <span className="muted">—</span>}</td>
                  <td>{e.email || <span className="muted">—</span>}</td>
                  <td>
                    <span className="nums">
                      {e.open_count ?? 0} / <span className="accent-text">{e.in_progress_count ?? 0}</span>
                      {!!e.overdue_count && <> / <span className="danger-text">{e.overdue_count}</span></>}
                    </span>
                  </td>
                  <td>
                    <span className="dayoff-cell">
                      <button className="btn ghost xs" title="Списать день" onClick={() => adjustDayoff(e, -1)}>−</button>
                      <b className={(e.dayoff?.left ?? 0) < 0 ? 'danger-text' : ''} title={`Выдано ${e.dayoff?.granted ?? 0}, использовано ${e.dayoff?.used ?? 0}`}>{e.dayoff?.left ?? 0}</b>
                      <button className="btn ghost xs" title="Выдать день" onClick={() => adjustDayoff(e, 1)}>+</button>
                    </span>
                  </td>
                  <td className="actions">
                    <a className="btn ghost sm" href={`#/queues?employee=${e.id}`}>Задачи</a>
                    <button className="btn ghost sm" onClick={() => edit(e)}>Изменить</button>
                    <button className="btn ghost sm danger" onClick={() => remove(e)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
