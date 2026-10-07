import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import DOMPurify from 'dompurify';
import { mentionExtension, type MentionCtx } from './mentions';

/** Безопасный HTML заметки для показа (ссылки — в новой вкладке) */
export function safeHtml(html: string) {
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-type', 'data-checked', 'data-id', 'data-label', 'data-mention-suggestion-char'] });
  return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

interface Props {
  value: string;
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Упоминания: # задача, @ сотрудник, [[ заметка */
  mentions?: MentionCtx;
}

export function RichEditor({ value, onChange, placeholder, autoFocus, mentions }: Props) {
  // useEditor запоминает обработчики при создании — берём актуальный onChange через ref
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mentionsRef = useRef<MentionCtx>(mentions || {});
  mentionsRef.current = mentions || {};
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder || 'Текст заметки… # задача, @ сотрудник, [[ заметка' }),
      mentionExtension(mentionsRef),
    ],
    content: value,
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor }) => onChangeRef.current(editor.isEmpty ? '' : editor.getHTML(), editor.getText({ blockSeparator: '\n' })),
    editorProps: { attributes: { class: 'rich-content rich-editable' } },
  });

  if (!editor) return null;
  return (
    <div className="rich-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

/** Кнопка панели: не забирает фокус у редактора */
function B({ on, title, onClick, children, disabled }: { on?: boolean; title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`tb ${on ? 'on' : ''}`} title={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      code: e.isActive('code'), highlight: e.isActive('highlight'), link: e.isActive('link'),
      h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      quote: e.isActive('blockquote'), codeBlock: e.isActive('codeBlock'),
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const c = () => editor.chain().focus();

  return (
    <div className="rich-toolbar">
      <B on={st.bold} title="Жирный (Ctrl+B)" onClick={() => c().toggleBold().run()}><b>Ж</b></B>
      <B on={st.italic} title="Курсив (Ctrl+I)" onClick={() => c().toggleItalic().run()}><i>К</i></B>
      <B on={st.underline} title="Подчёркнутый (Ctrl+U)" onClick={() => c().toggleUnderline().run()}><u>Ч</u></B>
      <B on={st.strike} title="Зачёркнутый" onClick={() => c().toggleStrike().run()}><s>З</s></B>
      <B on={st.highlight} title="Выделить маркером" onClick={() => c().toggleHighlight().run()}><mark>М</mark></B>
      <span className="tb-sep" />
      <B on={st.h2} title="Заголовок" onClick={() => c().toggleHeading({ level: 2 }).run()}>H2</B>
      <B on={st.h3} title="Подзаголовок" onClick={() => c().toggleHeading({ level: 3 }).run()}>H3</B>
      <span className="tb-sep" />
      <B on={st.bullet} title="Маркированный список" onClick={() => c().toggleBulletList().run()}>•≡</B>
      <B on={st.ordered} title="Нумерованный список" onClick={() => c().toggleOrderedList().run()}>1.</B>
      <B on={st.task} title="Чек-лист" onClick={() => c().toggleTaskList().run()}>☑</B>
      <span className="tb-sep" />
      <B on={st.quote} title="Цитата" onClick={() => c().toggleBlockquote().run()}>❝</B>
      <B on={st.code} title="Код в строке" onClick={() => c().toggleCode().run()}>{'</>'}</B>
      <B on={st.codeBlock} title="Блок кода" onClick={() => c().toggleCodeBlock().run()}>{'{ }'}</B>
      <B title="Разделитель" onClick={() => c().setHorizontalRule().run()}>―</B>
      <span className="tb-sep" />
      <div className="tb-link">
        <B on={st.link || linkOpen} title="Ссылка" onClick={() => setLinkOpen(!linkOpen)}>🔗</B>
        {linkOpen && <LinkPopover editor={editor} onClose={() => setLinkOpen(false)} />}
      </div>
      <B title="Очистить форматирование" onClick={() => c().unsetAllMarks().clearNodes().run()}>⌫</B>
      <span className="tb-sep" />
      <B title="Отменить (Ctrl+Z)" disabled={!st.canUndo} onClick={() => c().undo().run()}>↶</B>
      <B title="Повторить (Ctrl+Shift+Z)" disabled={!st.canRedo} onClick={() => c().redo().run()}>↷</B>
    </div>
  );
}

function LinkPopover({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState(() => editor.getAttributes('link').href || '');
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else {
      const full = /^(https?:|mailto:|tel:|\/|#)/i.test(href) ? href : `https://${href}`;
      if (editor.state.selection.empty && !editor.isActive('link')) {
        // Нет выделения — вставляем саму ссылку как текст
        editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href: full } }] }).insertContent(' ').run();
      } else chain.setLink({ href: full }).run();
    }
    onClose();
  };

  return (
    <div className="link-pop" onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
      />
      <button type="button" className="btn sm primary" onClick={apply}>OK</button>
      {editor.isActive('link') && (
        <button type="button" className="btn sm ghost" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); }}>Убрать</button>
      )}
    </div>
  );
}
