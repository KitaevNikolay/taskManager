import { useEffect, useState } from 'react';
import { api, type Department } from '../api';
import { useApp } from '../App';

export const DEPARTMENT_COLORS = ['#2f6fed', '#2e9d4f', '#d9822b', '#8a5cd6', '#d33a3a', '#0e9aa7', '#c2185b', '#7a8794'];

interface GroupInfo { id: number; name: string | null; stages: { id: number; title: string; color: string }[] }
interface Suggestion { group_id: number; name: string | null; tasks: number }

/** Цветная метка отдела */
export function DepartmentDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span className="dep-dot" style={{ background: color, width: size, height: size }} />;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-pick">
      {DEPARTMENT_COLORS.map((c) => (
        <button key={c} type="button" className={`swatch ${value === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <input type="color" className="swatch-custom" value={value} onChange={(e) => onChange(e.target.value)} title="Свой цвет" />
    </div>
  );
}

/** Добавление отдела по ID группы Битрикс24 */
export function DepartmentAdd({ onAdded, onCancel }: { onAdded: (d: Department) => void; onCancel?: () => void }) {
  const { toast, meta } = useApp();
  const [groupId, setGroupId] = useState('');
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [title, setTitle] = useState('');
  const [color, setColor] = useState(DEPARTMENT_COLORS[(meta?.departments.length || 0) % DEPARTMENT_COLORS.length]);
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<Suggestion[]>([]);

  useEffect(() => void api.get<Suggestion[]>('/departments/suggestions').then(setSuggest).catch(() => null), []);

  const check = async (id = groupId) => {
    if (!id) return;
    setBusy(true);
    setInfo(null);
    try {
      const g = await api.get<GroupInfo>(`/bitrix/group/${id}`);
      setInfo(g);
      setTitle(g.name || `Группа ${id}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api.post<Department>('/departments', { group_id: Number(groupId), title, color });
      toast(`Отдел «${d.title}» добавлен, подтягиваю задачи…`, 'ok');
      onAdded(d);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="dep-add" onSubmit={add}>
      <label className="field">
        <span>ID группы (проекта) в Битрикс24 — число из адреса группы: …/workgroups/group/<b>28</b>/</span>
        <div className="row">
          <input value={groupId} onChange={(e) => { setGroupId(e.target.value.replace(/\D/g, '')); setInfo(null); }} placeholder="например, 28" autoFocus />
          <button type="button" className="btn" disabled={busy || !groupId} onClick={() => check()}>Проверить</button>
        </div>
      </label>
      {suggest.length > 0 && !info && (
        <div className="dep-suggest">
          <span className="muted small">Группы, которые уже встречаются в задачах:</span>
          {suggest.map((s) => (
            <button key={s.group_id} type="button" className="chip" onClick={() => { setGroupId(String(s.group_id)); void check(String(s.group_id)); }}>
              {s.name || `#${s.group_id}`} <span className="muted">· {s.tasks}</span>
            </button>
          ))}
        </div>
      )}
      {info && (
        <>
          <div className="form-hint ok">
            Группа найдена{info.name ? `: «${info.name}»` : ''}. Стадии канбана: {info.stages.length ? info.stages.map((s) => s.title).join(' → ') : 'нет (канбан в группе не настроен)'}
          </div>
          <label className="field"><span>Название отдела в приложении</span><input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
          <div className="field"><span>Цвет — им отмечаются задачи отдела на карточках</span><ColorPicker value={color} onChange={setColor} /></div>
        </>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy || !info}>Добавить отдел</button>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Отмена</button>}
      </div>
    </form>
  );
}

/** Отделы пользователя в личном кабинете */
export function DepartmentsSettings() {
  const { toast, reloadMeta, bump, version } = useApp();
  const [list, setList] = useState<Department[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Department | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const load = () => api.get<Department[]>('/departments').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), [version]); // eslint-disable-line
  const changed = () => { load(); reloadMeta(); bump(); };

  const save = async () => {
    if (!edit) return;
    try {
      await api.put(`/departments/${edit.id}`, { title: edit.title, color: edit.color });
      setEdit(null);
      changed();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const move = async (i: number, dir: -1 | 1) => {
    if (!list) return;
    const next = [...list];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    setList(next);
    await api.put('/departments-order', { ids: next.map((d) => d.id) });
    changed();
  };
  const remove = async (d: Department) => {
    await api.del(`/departments/${d.id}`);
    setConfirmDel(null);
    changed();
  };

  return (
    <div className="card form" id="departments">
      <div className="row between">
        <h3>Мои отделы</h3>
        {!adding && <button className="btn sm" onClick={() => setAdding(true)}>+ Отдел</button>}
      </div>
      <p className="muted small">Отдел — группа Битрикс24. По её стадиям строится канбан, а цветом отдела отмечаются его задачи.</p>
      {adding && <DepartmentAdd onAdded={() => { setAdding(false); changed(); }} onCancel={() => setAdding(false)} />}
      {list?.length === 0 && !adding && <div className="muted small">Отделов пока нет — добавьте первый.</div>}
      {list?.map((d, i) => (
        <div key={d.id} className="dep-row">
          {edit?.id === d.id ? (
            <div className="dep-edit">
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              <ColorPicker value={edit.color} onChange={(c) => setEdit({ ...edit, color: c })} />
              <div className="row">
                <button className="btn sm primary" onClick={save}>Сохранить</button>
                <button className="btn sm ghost" onClick={() => setEdit(null)}>Отмена</button>
              </div>
            </div>
          ) : (
            <>
              <DepartmentDot color={d.color} size={12} />
              <div className="dep-row-main">
                <b>{d.title}</b>
                <div className="muted small">группа #{d.group_id} · {d.open_count ?? 0} откр. задач{d.stages_count ? ` · ${d.stages_count} стадий` : ' · нет стадий канбана'}</div>
              </div>
              <button className="btn ghost xs" disabled={i === 0} title="Выше" onClick={() => move(i, -1)}>↑</button>
              <button className="btn ghost xs" disabled={i === list.length - 1} title="Ниже" onClick={() => move(i, 1)}>↓</button>
              <button className="btn ghost sm" onClick={() => setEdit(d)}>Изменить</button>
              {confirmDel === d.id ? (
                <button className="btn sm danger" onClick={() => remove(d)}>Точно убрать?</button>
              ) : (
                <button className="btn ghost sm danger" onClick={() => setConfirmDel(d.id)}>Убрать</button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
