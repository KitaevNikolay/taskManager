import { useCallback, useEffect, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, fmtYmd, relTime, toYmd } from '../api';
import { useApp } from '../App';
import { RichEditor, safeHtml } from '../components/RichEditor';
import { mentionFromEvent, mentionHtml, type MentionKind } from '../components/mentions';
import { NotesGraph } from '../components/NotesGraph';

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
  /** Отрывок с совпадением при поиске: \u0001…\u0002 — границы совпадения */
  snippet?: string;
}
interface Link { kind: MentionKind; id: number }

export const NOTE_COLORS: { id: string | null; label: string }[] = [
  { id: null, label: 'Без цвета' },
  { id: 'yellow', label: 'Жёлтый' },
  { id: 'green', label: 'Зелёный' },
  { id: 'blue', label: 'Синий' },
  { id: 'red', label: 'Красный' },
  { id: 'purple', label: 'Фиолетовый' },
];

const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] || '');
const parseLink = (s: string | null): Link | null => {
  const m = (s || '').match(/^(task|employee|note):(\d+)$/);
  return m ? { kind: m[1] as MentionKind, id: Number(m[2]) } : null;
};
const noteLabel = (n: Pick<Note, 'id' | 'title' | 'content_text'>) =>
  n.title || (n.content_text || '').split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 60) || `Заметка ${n.id}`;
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const snippetHtml = (s: string) => escHtml(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');

const savedMode = (): 'cards' | 'graph' => {
  try {
    return localStorage.getItem('notes-mode') === 'graph' ? 'graph' : 'cards';
  } catch {
    return 'cards';
  }
};

export function NotesPage() {
  const { toast, version, openTask, employees } = useApp();
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [tabId, setTabId] = useState<number | null>(() => Number(hashParams().get('tab')) || null);
  const [link, setLink] = useState<Link | null>(() => parseLink(hashParams().get('link')));
  const [linkLabel, setLinkLabel] = useState('');
  const [mode, setMode] = useState<'cards' | 'graph'>(savedMode);
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Partial<Note> | null>(null);
  const [newTab, setNewTab] = useState<string | null>(null);
  const [tabEdit, setTabEdit] = useState<Tab | null>(null);
  const [vaultOpen, setVaultOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const loadTabs = useCallback(() => api.get<Tab[]>('/notes/tabs').then((t) => {
    setTabs(t);
    setTabId((cur) => (cur && t.some((x) => x.id === cur) ? cur : t[0]?.id ?? null));
    return t;
  }).catch((e) => { toast(e.message, 'error'); return [] as Tab[]; }), [toast]);

  const loadNotes = useCallback(() => {
    if (search.trim()) return api.get<Note[]>(`/notes?q=${encodeURIComponent(search.trim())}`).then(setNotes);
    if (link) return api.get<Note[]>(`/notes?link=${link.kind}:${link.id}`).then(setNotes);
    if (!tabId) return Promise.resolve(setNotes([]));
    return api.get<Note[]>(`/notes?tab=${tabId}`).then(setNotes);
  }, [search, tabId, link]);

  useEffect(() => void loadTabs(), [loadTabs, version]);
  useEffect(() => void loadNotes()?.catch((e: any) => toast(e.message, 'error')), [loadNotes, version, toast]);

  const openNote = useCallback((id: number) => {
    api.get<Note>(`/notes/${id}`).then((n) => setEditing(n)).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  /** Новая заметка; если табов нет — создаём первый */
  const startNew = useCallback(async (content = '') => {
    let tab = tabId;
    if (!tab) tab = (await loadTabs())[0]?.id ?? null; // открыли по ссылке, табы ещё не загружены
    if (!tab) {
      try {
        tab = (await api.post<Tab>('/notes/tabs', { title: 'Заметки' })).id;
        await loadTabs();
        setTabId(tab);
      } catch (e: any) {
        return toast(e.message, 'error');
      }
    }
    setEditing({ tab_id: tab, content, title: '', color: null, pinned: false, done: false, remind_on: null });
  }, [tabId, loadTabs, toast]);

  // Ссылки на страницу: #/notes?note=ID (напоминание), ?link=task:ID (заметки по задаче), ?new=task:ID&label=… (новая заметка)
  const startNewRef = useRef(startNew);
  startNewRef.current = startNew;
  useEffect(() => {
    const read = () => {
      const p = hashParams();
      const id = Number(p.get('note'));
      if (id) openNote(id);
      const l = parseLink(p.get('link'));
      if (l) { setSearch(''); setLink(l); }
      const n = parseLink(p.get('new'));
      if (n) void startNewRef.current(`<p>${mentionHtml(n.kind, n.id, p.get('label') || '')} </p>`);
      if (id || n) {
        // Одноразовые параметры убираем, чтобы обновление страницы не открыло заметку повторно
        ['note', 'new', 'label'].forEach((k) => p.delete(k));
        window.history.replaceState(null, '', `#/notes${p.size ? '?' + p : ''}`);
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [openNote]);

  // Адрес отражает текущий таб или фильтр по связи
  useEffect(() => {
    const q = link ? `link=${link.kind}:${link.id}` : tabId ? `tab=${tabId}` : '';
    window.history.replaceState(null, '', `#/notes${q ? '?' + q : ''}`);
  }, [tabId, link]);

  // Подпись фильтра по связи
  useEffect(() => {
    if (!link) return setLinkLabel('');
    if (link.kind === 'employee') return setLinkLabel(employees.find((e) => e.id === link.id)?.name || `сотрудник #${link.id}`);
    if (link.kind === 'note') {
      api.get<Note>(`/notes/${link.id}`).then((n) => setLinkLabel(`«${noteLabel(n)}»`)).catch(() => setLinkLabel(`заметка #${link.id}`));
      return;
    }
    setLinkLabel(`задача #${link.id}`);
    api.get<{ id: number; label: string }[]>(`/notes/suggest?kind=task&q=${link.id}`)
      .then((r) => { const t = r.find((x) => x.id === link.id); if (t) setLinkLabel(`задача #${t.id} «${t.label}»`); })
      .catch(() => null);
  }, [link, employees]);

  const refresh = () => { loadTabs(); loadNotes(); };

  const addTab = async () => {
    const title = (newTab || '').trim();
    if (!title) return setNewTab(null);
    try {
      const t = await api.post<Tab>('/notes/tabs', { title });
      setNewTab(null);
      await loadTabs();
      setTabId(t.id);
      setLink(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const openDaily = async () => {
    try {
      const n = await api.post<Note>('/notes/daily');
      await loadTabs();
      setSearch('');
      setLink(null);
      setTabId(n.tab_id);
      setMode('cards');
      setEditing(n);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const switchMode = (m: 'cards' | 'graph') => {
    setMode(m);
    try {
      localStorage.setItem('notes-mode', m);
    } catch {
      /* приватный режим — просто не запомним */
    }
  };

  /** Клик по упоминанию в карточке или графе */
  const followLink = useCallback((l: Link) => {
    if (l.kind === 'task') return openTask(l.id);
    if (l.kind === 'note') return openNote(l.id);
    setSearch('');
    setMode('cards');
    setLink(l);
  }, [openTask, openNote]);

  const onTabDrag = (e: DragEndEvent) => {
    if (!tabs || !e.over || e.active.id === e.over.id) return;
    const next = arrayMove(tabs, tabs.findIndex((t) => t.id === e.active.id), tabs.findIndex((t) => t.id === e.over!.id));
    setTabs(next);
    api.put('/notes/tabs-order', { ids: next.map((t) => t.id) }).catch((err) => toast(err.message, 'error'));
  };

  const visible = notes.filter((n) => showDone || !n.done);
  const doneCount = notes.filter((n) => n.done).length;
  const filtered = !!search.trim() || !!link;

  const onNoteDrag = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id || filtered) return;
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
          <input className="search" placeholder="Поиск по всем заметкам" value={search} onChange={(e) => { setSearch(e.target.value); if (e.target.value) setMode('cards'); }} />
          <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Выполненные{doneCount && mode === 'cards' ? ` (${doneCount})` : ''}</label>
          <div className="seg" role="group" aria-label="Вид">
            <button className={mode === 'cards' ? 'active' : ''} onClick={() => switchMode('cards')}>Карточки</button>
            <button className={mode === 'graph' ? 'active' : ''} onClick={() => switchMode('graph')}>Граф</button>
          </div>
          <button className="btn" onClick={openDaily} title="Заметка на сегодня: кто отсутствует, сроки и план дня">Сегодня</button>
          <button className="btn" onClick={() => setVaultOpen(true)} title="Выгрузка заметок в Markdown для Obsidian">Obsidian</button>
          <button className="btn primary" onClick={() => void startNew()}>+ Заметка</button>
        </div>
      </div>

      {mode === 'graph' ? (
        <NotesGraph showDone={showDone} onNote={openNote} onTask={openTask} onEmployee={(id) => followLink({ kind: 'employee', id })} />
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onTabDrag}>
            <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              <div className="note-tabs">
                {tabs.map((t) => (
                  <TabPill key={t.id} tab={t} active={!filtered && t.id === tabId} onClick={() => { setSearch(''); setLink(null); setTabId(t.id); }} onEdit={() => setTabEdit(t)} />
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

          {tabs.length === 0 && !link && (
            <div className="card notes-empty">
              <h3>Создайте первый таб</h3>
              <p className="muted">Табы — это разделы заметок: «Финансы», «Бюджет», «Проекты», «Серверы»…</p>
              <button className="btn primary" onClick={() => setNewTab('')}>+ Таб</button>
            </div>
          )}

          {search.trim() && <p className="muted small page-note">Найдено заметок: {visible.length} (поиск по всем табам)</p>}
          {!search.trim() && link && (
            <div className="link-filter">
              <span>Заметки, где упомянут{link.kind === 'task' ? 'а' : link.kind === 'note' ? 'а' : ''} <b>{linkLabel}</b>: {visible.length}</span>
              <button className="btn ghost sm" onClick={() => setLink(null)}>✕ Сбросить</button>
            </div>
          )}

          {(tabs.length > 0 || link) && visible.length === 0 && (
            <div className="card muted center notes-empty">{search ? 'Ничего не найдено' : link ? 'Таких заметок пока нет' : 'В этом табе пока нет заметок'}</div>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onNoteDrag}>
            <SortableContext items={visible.map((n) => n.id)} strategy={rectSortingStrategy}>
              <div className="notes-grid">
                {visible.map((n) => (
                  <NoteCard key={n.id} note={n} showTab={filtered} onOpen={() => setEditing(n)} onPatch={(b) => patch(n, b)} onDeleted={refresh} onLink={followLink} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}

      {editing && (
        <NoteEditor
          key={editing.id ?? 'new'}
          note={editing}
          tabs={tabs}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
          onOpenNote={openNote}
          onTabsChanged={loadTabs}
        />
      )}
      {tabEdit && <TabEditor tab={tabEdit} onClose={() => setTabEdit(null)} onSaved={() => { setTabEdit(null); refresh(); }} />}
      {vaultOpen && <VaultDialog onClose={() => setVaultOpen(false)} />}
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

function NoteCard({ note: n, showTab, onOpen, onPatch, onDeleted, onLink }: {
  note: Note; showTab: boolean; onOpen: () => void; onPatch: (b: Partial<Note>) => void; onDeleted: () => void; onLink: (l: Link) => void;
}) {
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

  const onBodyClick = (e: React.MouseEvent) => {
    const m = mentionFromEvent(e);
    if (m) return onLink(m);
    if (!(e.target as HTMLElement).closest('a')) onOpen();
  };

  return (
    <div
      ref={setNodeRef}
      className={`note-card ${n.color ? 'c-' + n.color : ''} ${n.done ? 'done' : ''} ${n.pinned ? 'pinned' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
    >
      <div className="note-body" onClick={onBodyClick}>
        {showTab && n.tab_title && <div className="note-tabname">{n.tab_title}</div>}
        {n.title && <div className="note-title">{n.title}</div>}
        {n.snippet && n.snippet.includes('\u0001') ? (
          <div className="note-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(n.snippet) }} />
        ) : (
          n.content && <div className="rich-content note-content" dangerouslySetInnerHTML={{ __html: safeHtml(n.content) }} />
        )}
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

// ---------- Шаблоны ----------
const TODO = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>';
const UL = '<ul><li><p></p></li></ul>';
const ddmm = () => new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
const BUILTIN_TEMPLATES = [
  { id: 'standup', title: 'Планёрка', make: () => ({ title: `Планёрка ${ddmm()}`, content: `<h2>Что сделано</h2>${UL}<h2>В работе</h2>${UL}<h2>Блокеры</h2>${UL}<h2>Договорились</h2>${TODO}` }) },
  { id: 'one-on-one', title: '1:1', make: () => ({ title: `1:1 ${ddmm()}`, content: `<p><strong>С кем:</strong> </p><h2>Как дела, что мешает</h2>${UL}<h2>Обратная связь</h2>${UL}<h2>Развитие</h2>${UL}<h2>Договорились</h2>${TODO}` }) },
  { id: 'retro', title: 'Ретро', make: () => ({ title: `Ретро ${ddmm()}`, content: `<h2>Что было хорошо</h2>${UL}<h2>Что мешало</h2>${UL}<h2>Что меняем</h2>${TODO}` }) },
];
const TEMPLATES_TAB = 'шаблоны';

function NoteEditor({ note, tabs, onClose, onSaved, onOpenNote, onTabsChanged }: {
  note: Partial<Note>; tabs: Tab[]; onClose: () => void; onSaved: () => void; onOpenNote: (id: number) => void; onTabsChanged: () => void;
}) {
  const { toast } = useApp();
  const [f, setF] = useState({
    tab_id: note.tab_id!, title: note.title || '', content: note.content || '', content_text: note.content_text || '',
    color: note.color ?? null, pinned: !!note.pinned, done: !!note.done, remind_on: note.remind_on || '',
  });
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [backlinks, setBacklinks] = useState<Note[]>([]);
  const [custom, setCustom] = useState<Note[]>([]);
  const set = (patch: Partial<typeof f>) => { setF((x) => ({ ...x, ...patch })); setDirty(true); };

  // Обратные ссылки: какие заметки ссылаются на эту через [[
  useEffect(() => {
    if (note.id) api.get<Note[]>(`/notes?link=note:${note.id}`).then(setBacklinks).catch(() => null);
  }, [note.id]);
  // Свои шаблоны — заметки в табе «Шаблоны»
  const templatesTab = tabs.find((t) => t.title.trim().toLowerCase() === TEMPLATES_TAB);
  useEffect(() => {
    if (!note.id && templatesTab) api.get<Note[]>(`/notes?tab=${templatesTab.id}`).then(setCustom).catch(() => null);
  }, [note.id, templatesTab?.id]); // eslint-disable-line

  const applyTemplate = (t: { title: string; content: string }) => {
    setF((x) => ({ ...x, title: x.title || t.title, content: t.content, content_text: '' }));
    setDirty(true);
    setEditorKey((k) => k + 1); // редактор берёт содержимое только при создании
  };

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
  const goTo = (id: number) => (dirty ? toast('Сначала сохраните или закройте эту заметку', 'info') : onOpenNote(id));

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

  // [[Новая заметка — создаём пустую заметку с этим заголовком в том же табе
  const mentions = {
    except: note.id,
    createNote: async (title: string) => {
      const n = await api.post<Note>('/notes', { tab_id: f.tab_id, title, content: '', content_text: '' });
      onTabsChanged();
      return { id: n.id, label: title };
    },
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div className={`modal card note-editor ${f.color ? 'c-' + f.color : ''}`}>
        <input className="note-title-input" placeholder="Заголовок (необязательно)" value={f.title} onChange={(e) => set({ title: e.target.value })} />
        {!note.id && !f.content_text.trim() && (
          <div className="note-templates">
            <span className="muted small">Шаблон:</span>
            {BUILTIN_TEMPLATES.map((t) => <button key={t.id} type="button" className="btn ghost xs" onClick={() => applyTemplate(t.make())}>{t.title}</button>)}
            {custom.map((t) => <button key={t.id} type="button" className="btn ghost xs" onClick={() => applyTemplate({ title: t.title || '', content: t.content })}>{noteLabel(t)}</button>)}
            {!templatesTab && <span className="muted small">· свои шаблоны — заметки в табе «Шаблоны»</span>}
          </div>
        )}
        <RichEditor
          key={editorKey}
          value={f.content}
          autoFocus={!note.id}
          mentions={mentions}
          onChange={(html, text) => set({ content: html, content_text: text })}
        />
        {backlinks.length > 0 && (
          <div className="note-backlinks">
            <span className="muted small">Ссылаются сюда:</span>
            {backlinks.map((b) => <button key={b.id} type="button" className="mention m-note" onClick={() => goTo(b.id)}>{noteLabel(b)}</button>)}
          </div>
        )}
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
          <span className="muted small"># задача · @ сотрудник · [[ заметка · Ctrl+Enter — сохранить · Esc — закрыть</span>
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

// ---------- Obsidian ----------
interface VaultState { enabled: boolean; lastAt: string | null; files: number; error: string | null; dir: string }

function VaultDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [st, setSt] = useState<VaultState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<VaultState>('/notes/vault').then(setSt).catch((e) => toast(e.message, 'error'));
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [toast, onClose]);
  const run = async (fn: () => Promise<VaultState>, ok?: string) => {
    setBusy(true);
    try {
      const s = await fn();
      setSt(s);
      if (s.error) toast(`Не удалось выгрузить: ${s.error}`, 'error');
      else if (ok) toast(ok, 'ok');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card form vault-dialog">
        <h2>Заметки в Obsidian</h2>
        <p className="muted small">
          Каждый таб становится папкой, заметка — файлом Markdown. Упомянутые задачи и сотрудники получают свои карточки в папке «Кабинет»,
          поэтому граф и обратные ссылки работают и в Obsidian. Выгрузка односторонняя: правки, сделанные в Obsidian, в кабинет не возвращаются.
        </p>
        <div className="vault-block">
          <h3>Архив</h3>
          <p className="small muted">Распакуйте в папку хранилища Obsidian. Повторная выгрузка перезапишет эти файлы.</p>
          <a className="btn" href="/api/notes/export.zip" download>Скачать архив .zip</a>
        </div>
        <div className="vault-block">
          <h3>Папка на сервере</h3>
          <label className="check">
            <input type="checkbox" checked={!!st?.enabled} disabled={!st || busy} onChange={(e) => run(() => api.put('/notes/vault', { enabled: e.target.checked }), e.target.checked ? 'Выгрузка включена' : 'Выгрузка выключена')} />
            Выгружать автоматически после каждого изменения
          </label>
          {st && (
            <>
              <div className="small">Папка: <code>{st.dir}</code></div>
              <p className="small muted">Подключите её к Obsidian через Syncthing или WebDAV. Файлы, добавленные в папку вручную, выгрузка не трогает.</p>
              {st.lastAt && <div className="small muted">Последняя выгрузка {relTime(st.lastAt)} · файлов: {st.files}</div>}
              {st.error && <div className="small danger-text">Ошибка: {st.error}</div>}
              {st.enabled && <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => api.post('/notes/vault/export'), 'Заметки выгружены')}>Выгрузить сейчас</button>}
            </>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
