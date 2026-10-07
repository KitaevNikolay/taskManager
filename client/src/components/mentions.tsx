// Упоминания в редакторе заметок: # задача Б24, @ сотрудник, [[ другая заметка.
// В HTML это <span data-type="mention" data-id data-label data-mention-suggestion-char>; сервер по ним строит связи.
import { forwardRef, useEffect, useImperativeHandle, useState, type RefObject } from 'react';
import { ReactRenderer, mergeAttributes, type Editor, type Range } from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { api } from '../api';

export type MentionKind = 'task' | 'employee' | 'note';
export const KIND_BY_CHAR: Record<string, MentionKind> = { '#': 'task', '@': 'employee', '[[': 'note' };
const CHAR: Record<MentionKind, string> = { task: '#', employee: '@', note: '[[' };

export interface MentionCtx {
  /** Не предлагать саму редактируемую заметку */
  except?: number;
  /** Создать заметку из [[ по введённому названию */
  createNote?: (title: string) => Promise<{ id: number; label: string }>;
}

interface Item { id: number; label: string; sub?: string; create?: boolean }

export const mentionText = (char: string, id: string | number, label?: string | null) =>
  char === '#' ? `#${id}${label ? ' ' + label : ''}` : String(label ?? id);

/** Упоминание из обработчика клика по отрисованной заметке */
export function mentionFromEvent(e: { target: EventTarget | null }) {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-type="mention"]') as HTMLElement | null;
  if (!el) return null;
  const kind = KIND_BY_CHAR[el.dataset.mentionSuggestionChar || '@'];
  const id = Number(el.dataset.id);
  return kind && id > 0 ? { kind, id, label: el.dataset.label || '' } : null;
}

/** HTML упоминания для подстановки в новую заметку (например, «+ Заметка» из карточки задачи) */
export function mentionHtml(kind: MentionKind, id: number, label: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<span data-type="mention" data-id="${id}" data-label="${esc(label)}" data-mention-suggestion-char="${CHAR[kind]}">${esc(mentionText(CHAR[kind], id, label))}</span>`;
}

function insertMention(editor: Editor, range: Range, char: string, item: { id: number; label: string }) {
  // Как в стандартной команде Mention: не плодим двойной пробел после упоминания
  const after = editor.view.state.selection.$to.nodeAfter;
  if (after?.text?.startsWith(' ')) range.to += 1;
  editor.chain().focus().insertContentAt(range, [
    { type: 'mention', attrs: { id: String(item.id), label: item.label, mentionSuggestionChar: char } },
    { type: 'text', text: ' ' },
  ]).run();
}

// Выбранный пункт приходит в command как props; у Mention он типизирован атрибутами узла — приводим к Item
function suggestion(kind: MentionKind, ctx: RefObject<MentionCtx>): Omit<SuggestionOptions<Item, any>, 'editor'> {
  const char = CHAR[kind];
  return {
    char,
    pluginKey: new PluginKey(`mention-${kind}`),
    allowSpaces: kind === 'note', // названия заметок с пробелами; у задач и людей ищем по одному слову
    debounce: 120,
    items: async ({ query }) => {
      const q = query.trim();
      const list = await api.get<Item[]>(`/notes/suggest?kind=${kind}&q=${encodeURIComponent(q)}&except=${ctx.current.except || 0}`).catch(() => [] as Item[]);
      if (kind === 'note' && q && ctx.current.createNote && !list.some((i) => i.label.toLowerCase() === q.toLowerCase())) {
        list.push({ id: 0, label: q, create: true });
      }
      return list;
    },
    command: ({ editor, range, props }) => {
      const item = props as Item;
      if (!item.create) return insertMention(editor, range, char, item);
      void ctx.current.createNote?.(item.label).then((n) => insertMention(editor, range, char, n)).catch(() => null);
    },
    render: () => {
      let comp: ReactRenderer<ListHandle, ListProps> | null = null;
      let unmount: (() => void) | null = null;
      return {
        onStart: (p) => {
          comp = new ReactRenderer(MentionList, { props: { ...p, kind }, editor: p.editor });
          unmount = p.mount(comp.element as HTMLElement);
        },
        onUpdate: (p) => comp?.updateProps({ ...p, kind }),
        onKeyDown: (p) => comp?.ref?.onKeyDown(p.event) ?? false,
        onExit: () => {
          unmount?.();
          comp?.destroy();
          comp = null;
        },
      };
    },
  };
}

export function mentionExtension(ctx: RefObject<MentionCtx>) {
  return Mention.configure({
    renderText: ({ node }) => mentionText(node.attrs.mentionSuggestionChar, node.attrs.id, node.attrs.label),
    renderHTML: ({ options, node }) => [
      'span',
      mergeAttributes(options.HTMLAttributes, { class: `mention m-${KIND_BY_CHAR[node.attrs.mentionSuggestionChar] || 'employee'}` }),
      mentionText(node.attrs.mentionSuggestionChar, node.attrs.id, node.attrs.label),
    ],
    suggestions: [suggestion('task', ctx), suggestion('employee', ctx), suggestion('note', ctx)],
  });
}

// ---------- Выпадающий список ----------
interface ListHandle { onKeyDown: (e: KeyboardEvent) => boolean }
type ListProps = SuggestionProps<Item, any> & { kind: MentionKind };

const TITLES: Record<MentionKind, string> = { task: 'Задача Битрикс24', employee: 'Сотрудник', note: 'Заметка' };
const EMPTY: Record<MentionKind, string> = {
  task: 'Нет задач в ваших отделах и у ваших сотрудников. Ищите по номеру или слову из названия',
  employee: 'Нет такого сотрудника в вашем списке',
  note: 'Начните вводить название заметки',
};

const MentionList = forwardRef<ListHandle, ListProps>(function MentionList({ items, command, kind, loading }, ref) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // иначе закроется окно заметки
        return true;
      }
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setSel((s) => (s + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setSel((s) => (s + items.length - 1) % items.length); return true; }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        command(items[Math.min(sel, items.length - 1)]);
        return true;
      }
      return false;
    },
  }), [items, sel, command]);

  return (
    <div className="mention-pop" onMouseDown={(e) => e.preventDefault()}>
      <div className="mention-pop-head">{CHAR[kind]} {TITLES[kind]}</div>
      {items.length === 0 && <div className="mention-pop-empty">{loading ? 'Ищу…' : EMPTY[kind]}</div>}
      {items.map((it, i) => (
        <button key={`${it.id}-${it.label}`} type="button" className={`mention-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => command(it)}>
          {it.create ? (
            <span>Создать заметку «{it.label}»</span>
          ) : (
            <>
              <span className="mention-item-label">{kind === 'task' && <b>#{it.id} </b>}{it.label}</span>
              {it.sub && <span className="mention-item-sub">{it.sub}</span>}
            </>
          )}
        </button>
      ))}
    </div>
  );
});
