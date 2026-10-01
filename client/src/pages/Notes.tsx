import { useCallback, useEffect, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, fmtYmd, relTime, toYmd } from '../api';
import { useApp } from '../App';
import { RichEditor, safeHtml } from '../components/RichEditor';

interface Tab { id: number; title: string; color: string | null; open_count: number; total_count: number }
interface Note {
  id: number;
  tab_id: number;
  tab_title?: string;
  title: string | null;
  content: string;
  content_text: string;
  color: string | null;
  pinned: boolean;
  done: boolean;
  remind_on: string | null;
  updated_at: string;
}

export const NOTE_COLORS: { id: string | null; label: string }[] = [
  { id: null, label: 'Без цвета' },
  { id: 'yellow', label: 'Жёлтый' },
  { id: 'green', label: 'Зелёный' },
  { id: 'blue', label: 'Синий' },
  { id: 'red', label: 'Красный' },
  { id: 'purple', label: 'Фиолетовый' },
];

const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] || '');

export function NotesPage() {
  const { toast, version } = useApp();
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [tabId, setTabId] = useState<number | null>(() => Number(hashParams().get('tab')) || null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Partial<Note> | null>(null);
  const [newTab, setNewTab] = useState<string | null>(null);
  const [tabEdit, setTabEdit] = useState<Tab | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const loadTabs = useCallback(() => api.get<Tab[]>('/notes/tabs').then((t) => {
    setTabs(t);
    setTabId((cur) => (cur && t.some((x) => x.id === cur) ? cur : t[0]?.id ?? null));
  }).catch((e) => toast(e.message, 'error')), [toast]);

  const loadNotes = useCallback(() => {
    if (search.trim()) return api.get<Note[]>(`/notes?q=${encodeURIComponent(search.trim())}`).then(setNotes);
    if (!tabId) return Promise.resolve(setNotes([]));
    return api.get<Note[]>(`/notes?tab=${tabId}`).then(setNotes);
  }, [search, tabId]);

  useEffect(() => void loadTabs(), [loadTabs, version]);
  useEffect(() => void loadNotes()?.catch((e: any) => toast(e.message, 'error')), [loadNotes, version, toast]);

  // Ссылка из напоминания: #/notes?note=ID
  useEffect(() => {
    const open = () => {
      const id = Number(hashParams().get('note'));
      if (!id) return;
      api.get<Note>(`/notes/${id}`).then((n) => { setTabId(n.tab_id); setEditing(n); }).catch((e) => toast(e.message, 'error'));
      window.history.replaceState(null, '', `#/notes?tab=${hashParams().get('tab') || ''}`);
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [toast]);

  useEffect(() => {
    if (tabId) window.history.replaceState(null, '', `#/notes?tab=${tabId}`);
  }, [tabId]);

  const refresh = () => { loadTabs(); loadNotes(); };

  const addTab = async () => {
    const title = (newTab || '').trim();
    if (!title) return setNewTab(null);
    try {
      const t = await api.post<Tab>('/notes/tabs', { title });
      setNewTab(null);
      await loadTabs();
      setTabId(t.id);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const onTabDrag = (e: DragEndEvent) => {
    if (!tabs || !e.over || e.active.id === e.over.id) return;
    const next = arrayMove(tabs, tabs.findIndex((t) => t.id === e.active.id), tabs.findIndex((t) => t.id === e.over!.id));
    setTabs(next);
    api.put('/notes/tabs-order', { ids: next.map((t) => t.id) }).catch((err) => toast(err.message, 'error'));
  };

  const visible = notes.filter((n) => showDone || !n.done);
  const doneCount = notes.filter((n) => n.done).length;

  const onNoteDrag = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id || search) return;
    const next = arrayMove(notes, notes.findIndex((n) => n.id === e.active.id), notes.findIndex((n) => n.id === e.over!.id));
    setNotes(next);
    api.put('/notes-order', { ids: next.map((n) => n.id) }).catch((err) => toast(err.message, 'error'));
  };

  const patch = async (n: Note, body: Partial<Note>) => {
    setNotes((list) => list.map((x) => (x.id === n.id ? { ...x, ...body } : x)));
    try {
      await api.patch(`/notes/${n.id}`, body);
      if ('done' in body || 'pinned' in body) refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  if (!tabs) return <div className="page muted">Загрузка…</div>;

  return (
    <div className="page page-wide notes-page">
      <div className="page-head">
        <h1>Заметки</h1>
        <div className="toolbar">
          <input className="search" placeholder="Поиск по всем заметкам" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Выполненные{doneCount ? ` (${doneCount})` : ''}</label>
          <button className="btn primary" disabled={!tabId} onClick={() => setEditing({ tab_id: tabId!, content: '', title: '', color: null, pinned: false, done: false, remind_on: null })}>
            + Заметка
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onTabDrag}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="note-tabs">
            {tabs.map((t) => (
              <TabPill key={t.id} tab={t} active={!search && t.id === tabId} onClick={() => { setSearch(''); setTabId(t.id); }} onEdit={() => setTabEdit(t)} />
            ))}
            {newTab === null ? (
              <button className="note-tab add" onClick={() => setNewTab('')}>+ Таб</button>
            ) : (
              <form className="note-tab-new" onSubmit={(e) => { e.preventDefault(); addTab(); }}>
                <input autoFocus placeholder="Например, Бюджет" value={newTab} onChange={(e) => setNewTab(e.target.value)} onBlur={addTab} onKeyDown={(e) => e.key === 'Escape' && setNewTab(null)} />
              </form>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {tabs.length === 0 && (
        <div className="card notes-empty">
          <h3>Создайте первый таб</h3>
          <p className="muted">Табы — это разделы заметок: «Финансы», «Бюджет», «Проекты», «Серверы»…</p>
          <button className="btn primary" onClick={() => setNewTab('')}>+ Таб</button>
        </div>
      )}

      {search && <p className="muted small page-note">Найдено заметок: {visible.length} (поиск по всем табам)</p>}

      {tabs.length > 0 && visible.length === 0 && (
        <div className="card muted center notes-empty">{search ? 'Ничего не найдено' : 'В этом табе пока нет заметок'}</div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onNoteDrag}>
        <SortableContext items={visible.map((n) => n.id)} strategy={rectSortingStrategy}>
          <div className="notes-grid">
            {visible.map((n) => (
              <NoteCard key={n.id} note={n} showTab={!!search} onOpen={() => setEditing(n)} onPatch={(b) => patch(n, b)} onDeleted={refresh} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {editing && <NoteEditor note={editing} tabs={tabs} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {tabEdit && <TabEditor tab={tabEdit} onClose={() => setTabEdit(null)} onSaved={() => { setTabEdit(null); refresh(); }} />}
    </div>
  );
}

function TabPill({ tab, active, onClick, onEdit }: { tab: Tab; active: boolean; onClick: () => void; onEdit: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  return (
    <div
      ref={setNodeRef}
      className={`note-tab ${active ? 'active' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      onClick={onClick}
      onDoubleClick={onEdit}
      title="Двойной клик — переименовать. Перетащите, чтобы поменять порядок."
      {...attributes}
      {...listeners}
    >
      {tab.title}
      {tab.open_count > 0 && <span className="note-tab-count">{tab.open_count}</span>}
      {active && <button className="note-tab-edit" title="Переименовать или удалить" onClick={(e) => { e.stopPropagation(); onEdit(); }}>⋯</button>}
    </div>
  );
}

function NoteCard({ note: n, showTab, onOpen, onPatch, onDeleted }: { note: Note; showTab: boolean; onOpen: () => void; onPatch: (b: Partial<Note>) => void; onDeleted: () => void }) {
  const { toast } = useApp();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: n.id });
  const [confirmDel, setConfirmDel] = useState(false);
  const today = toYmd(new Date().toISOString());
  const due = n.remind_on && n.remind_on <= today && !n.done;

  const del = async () => {
    try {
      await api.del(`/notes/${n.id}`);
      onDeleted();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div
      ref={setNodeRef}
      className={`note-card ${n.color ? 'c-' + n.color : ''} ${n.done ? 'done' : ''} ${n.pinned ? 'pinned' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
    >
      <div className="note-body" onClick={(e) => !(e.target as HTMLElement).closest('a') && onOpen()}>
        {showTab && n.tab_title && <div className="note-tabname">{n.tab_title}</div>}
        {n.title && <div className="note-title">{n.title}</div>}
        {n.content && <div className="rich-content note-content" dangerouslySetInnerHTML={{ __html: safeHtml(n.content) }} />}
      </div>
      <div className="note-foot" onPointerDown={(e) => e.stopPropagation()}>
        <label className="check" title="Выполнено">
          <input type="checkbox" checked={n.done} onChange={(e) => onPatch({ done: e.target.checked })} />
        </label>
        {n.remind_on && <span className={`chip ${due ? 'danger' : 'muted'}`} title="Напоминание">⏰ {fmtYmd(n.remind_on)}</span>}
        <span className="muted small note-time" title={new Date(n.updated_at).toLocaleString('ru-RU')}>{relTime(n.updated_at)}</span>
        <button className={`btn ghost xs ${n.pinned ? 'pin-on' : ''}`} title={n.pinned ? 'Открепить' : 'Закрепить сверху'} onClick={() => onPatch({ pinned: !n.pinned })}>📌</button>
        {!confirmDel ? (
          <button className="btn ghost xs" title="Удалить" onClick={() => setConfirmDel(true)}>🗑</button>
        ) : (
          <>
            <button className="btn xs danger" onClick={del}>Удалить</button>
            <button className="btn ghost xs" onClick={() => setConfirmDel(false)}>Нет</button>
          </>
        )}
      </div>
    </div>
  );
}

function NoteEditor({ note, tabs, onClose, onSaved }: { note: Partial<Note>; tabs: Tab[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({
    tab_id: note.tab_id!, title: note.title || '', content: note.content || '', content_text: note.content_text || '',
    color: note.color ?? null, pinned: !!note.pinned, done: !!note.done, remind_on: note.remind_on || '',
  });
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => { setF((x) => ({ ...x, ...patch })); setDirty(true); };

  const saving = useRef(false); // защита от двойного сохранения (кнопка + горячая клавиша)
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const body = { ...f, remind_on: f.remind_on || null };
      if (note.id) await api.put(`/notes/${note.id}`, body);
      else await api.post('/notes', body);
      toast('Заметка сохранена', 'ok');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const tryClose = () => (dirty ? setAskClose(true) : onClose());

  // Ctrl+Enter / Ctrl+S — сохранить из любого места окна, Esc — закрыть
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return tryClose();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'KeyS')) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div className={`modal card note-editor ${f.color ? 'c-' + f.color : ''}`}>
        <input className="note-title-input" placeholder="Заголовок (необязательно)" value={f.title} onChange={(e) => set({ title: e.target.value })} />
        <RichEditor
          value={f.content}
          autoFocus={!note.id}
          onChange={(html, text) => set({ content: html, content_text: text })}

        />
        <div className="note-editor-meta">
          <label className="field inline">
            <span>Таб</span>
            <select value={f.tab_id} onChange={(e) => set({ tab_id: Number(e.target.value) })}>
              {tabs.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </label>
          <label className="field inline">
            <span>Напомнить</span>
            <input type="date" value={f.remind_on} onChange={(e) => set({ remind_on: e.target.value })} />
            {f.remind_on && <button type="button" className="btn ghost xs" onClick={() => set({ remind_on: '' })}>✕</button>}
          </label>
          <div className="color-pick" title="Цвет карточки">
            {NOTE_COLORS.map((c) => (
              <button key={c.id ?? 'none'} type="button" title={c.label} className={`swatch ${c.id ? 'c-' + c.id : 'none'} ${f.color === c.id ? 'on' : ''}`} onClick={() => set({ color: c.id })} />
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => set({ pinned: e.target.checked })} /> Закрепить</label>
          {note.id && <label className="check"><input type="checkbox" checked={f.done} onChange={(e) => set({ done: e.target.checked })} /> Выполнено</label>}
        </div>
        <div className="row between">
          <span className="muted small">Ctrl+Enter или Ctrl+S — сохранить · Esc — закрыть</span>
          {askClose ? (
            <div className="row">
              <span className="small">Есть несохранённые изменения</span>
              <button className="btn ghost" onClick={onClose}>Не сохранять</button>
              <button className="btn primary" disabled={busy} onClick={save}>Сохранить</button>
            </div>
          ) : (
            <div className="row">
              <button className="btn ghost" onClick={tryClose}>Отмена</button>
              <button className="btn primary" disabled={busy} onClick={save}>Сохранить</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabEditor({ tab, onClose, onSaved }: { tab: Tab; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [title, setTitle] = useState(tab.title);
  const [confirmDel, setConfirmDel] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card form tab-editor" onSubmit={(e) => { e.preventDefault(); run(() => api.put(`/notes/tabs/${tab.id}`, { title })); }}>
        <h2>Таб</h2>
        <label className="field"><span>Название</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row between">
          {!confirmDel ? (
            <button type="button" className="btn ghost danger" onClick={() => setConfirmDel(true)}>Удалить таб</button>
          ) : (
            <button type="button" className="btn danger" onClick={() => run(() => api.del(`/notes/tabs/${tab.id}`))}>
              Удалить вместе с заметками ({tab.total_count})?
            </button>
          )}
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>Отмена</button>
            <button className="btn primary">Сохранить</button>
          </div>
        </div>
      </form>
    </div>
  );
}
