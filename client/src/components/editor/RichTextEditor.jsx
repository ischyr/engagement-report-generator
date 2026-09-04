import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { FigureImage } from './FigureImage.js';
import { FigureRef } from './FigureRef.js';
import FigureRefPicker from './FigureRefPicker.jsx';
import { CodeBlockWithClass, ParagraphWithClass } from './KeepClass.js';
import Lightbox from '../ui/Lightbox.jsx';
import SnippetPicker from './SnippetPicker.jsx';
import { referenceableFigures } from '../../lib/figures.js';
import SlashMenu from './SlashMenu.jsx';
import Annotator from './Annotator.jsx';
import { useImageLightbox } from '../../hooks/useImageLightbox.js';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';

import { AlignCenter, AlignLeft, AlignRight, ArrowLeftRight, Bold, BookmarkPlus, Code, Code2, Heading2, Heading3, Highlighter, Image as ImageIcon, ImagePlus, Italic, Link2, Link2Off, List, ListOrdered, Minus, Quote, Redo2, RefreshCw, Strikethrough, Table as TableIcon, Trash2, Underline as UnderlineIcon, Undo2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { shrinkImage } from '../../lib/images.js';
import {
  blankHttpExchange,
  httpExchangeHtml,
  looksLikeHttp,
  parseHttpExchange,
} from '../../lib/http-evidence.js';
import { cn } from '../../lib/utils.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * Per-image ceiling. Generous, because it is no longer doing double duty as a
 * limit on the engagement as a whole: images are uploaded to storage and the
 * document keeps only a reference, so total evidence is bounded by disk rather
 * than by MongoDB's 16 MB document cap.
 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function ToolbarButton({ onClick, active, disabled, title, icon: Icon, danger }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      className={cn(
        'grid size-7 place-items-center rounded-md transition-colors disabled:opacity-35',
        active
          ? 'bg-brand-500/20 text-brand-300'
          : danger
            ? 'text-fg-subtle hover:bg-crit/12 hover:text-crit'
            : 'text-fg-muted hover:bg-white/8 hover:text-fg'
      )}
    >
      <Icon size={14} />
    </button>
  );
}

const Divider = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-line" />;

/**
 * The editor used for every long-form field (finding description, remediation,
 * proof of concept, report sections).
 *
 * Its HTML output is what the server converts into WordprocessingML, so the
 * enabled marks map deliberately onto things Word can represent: headings,
 * lists, tables, code blocks, links and inline images.
 */
/** A stored image, as opposed to one pasted in as a data URI. */
const MEDIA_SRC = /\/api\/media\/([0-9a-f]{24})/i;

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Start writing…',
  minHeight = 180,
  className,
  editable = true,
  compact = false,
  /**
   * Swaps one stored image for another everywhere it appears, then reloads.
   *
   * Passed in rather than done here: the rewrite happens server-side across a whole
   * engagement, so whoever owns the surrounding data is the only one who can refetch it.
   * No handler, no button — an editor that cannot reload must not start a change it would
   * then show a stale version of.
   */
  onReplaceImage,
  /** Told when this editor takes the cursor, so a caller can insert into the right field. */
  onFocus,
  /**
   * The other fields of the same record, so a sentence here can refer to a figure over there.
   *
   * Passed in rather than discovered: a reference written in the description usually points at a
   * screenshot in the proof of concept, and this editor only ever holds one field. Absent simply
   * means the picker offers this field's own pictures, which is what a standalone editor should do.
   */
  siblingFields = null,
}) {
  const toast = useToast();
  const fileInputRef = useRef(null);
  /** The rendered content, for the delegated image-click listener. */
  const contentRef = useRef(null);
  const replaceInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [replacing, setReplacing] = useState(false);
  /** The stored image being marked up, if any. */
  const [annotating, setAnnotating] = useState(null);
  // Guards against feeding our own change back in as an external update.
  const lastEmitted = useRef(value ?? '');

  const extensions = useMemo(
    () => [
      // StarterKit brings paragraphs, marks, lists, history and code blocks.
      // Link and Underline are not part of it, so they are added separately.
      /*
        * The kit's own paragraph and code block are turned off and replaced with versions that keep
        * a `class` — see KeepClass.js. Everything else about them is unchanged.
        */
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        paragraph: false,
        codeBlock: false,
      }),
      ParagraphWithClass,
      CodeBlockWithClass.configure({ HTMLAttributes: { class: 'engy-code-block' } }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      FigureImage.configure({ inline: false, allowBase64: true }),
      FigureRef,
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
    ],
    [placeholder]
  );

  /*
   * The paste handler needs the editor, and the editor needs the paste handler — a ref settles it
   * rather than rebuilding the instance, which would drop the undo history on every keystroke.
   */
  const editorRef = useRef(null);

  const editor = useEditor({
    extensions,
    content: value ?? '',
    editable,
    editorProps: {
      attributes: {
        class: cn('engy-prose focus:outline-none'),
        style: `min-height:${minHeight}px`,
      },
      handlePaste(view, event) {
        // Pasting a screenshot straight from the clipboard is the common case
        // for proof-of-concept evidence, so handle it explicitly.
        const items = [...(event.clipboardData?.items ?? [])];
        const imageItem = items.find((item) => item.type.startsWith('image/'));
        if (imageItem) {
          const file = imageItem.getAsFile();
          if (!file) return false;
          event.preventDefault();
          readImage(file);
          return true;
        }

        /*
         * A request and its response, pasted from a proxy or from curl -i.
         *
         * Taken as prose the headers reflow into a paragraph and the evidence becomes
         * unreadable, which is why people screenshot their terminal instead — an image of text
         * that cannot be copied or searched. Only claimed when it really looks like an
         * exchange; anything else falls through to the editor's own paste.
         */
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (looksLikeHttp(text)) {
          event.preventDefault();
          const html = httpExchangeHtml(parseHttpExchange(text));
          // `insertContent` with a false second argument keeps the pasted text verbatim.
          view.dispatch(view.state.tr.scrollIntoView());
          editorRef.current?.chain().focus().insertContent(html).run();
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        const file = [...(event.dataTransfer?.files ?? [])].find((f) =>
          f.type.startsWith('image/')
        );
        if (!file) return false;
        event.preventDefault();
        readImage(file);
        return true;
      },
    },
    onFocus() {
      onFocus?.();
    },
    onUpdate({ editor: instance }) {
      const html = instance.getHTML();
      // TipTap represents "empty" as <p></p>; normalise so required-field
      // checks and "is this section written yet" logic agree.
      const normalised = html === '<p></p>' ? '' : html;
      lastEmitted.current = normalised;
      onChange?.(normalised);
    },
  });

  /**
   * Uploads an image and inserts a reference to it.
   *
   * Uploaded rather than inlined as a data URI: the engagement is one MongoDB
   * document capped at 16 MB, and a handful of screenshots used to be enough to
   * make saving fail outright. The document now holds a `/api/media/<id>` link and
   * the bytes live in GridFS.
   */
  const readImage = useCallback(
    async (file) => {
      if (!file.type.startsWith('image/')) {
        toast.error('That file is not an image');
        return;
      }
      setUploading(true);
      try {
        /*
         * Shrunk before the size check, not after it.
         *
         * A screenshot off a 4K display is seven-eighths pixels the page cannot print, and the
         * old behaviour was to refuse it and tell somebody to go and crop it themselves. Almost
         * every one of those now simply fits, and the ones that still do not get the same message.
         */
        const shrunk = await shrinkImage(file);
        const upload = shrunk.file;
        if (upload.size > MAX_IMAGE_BYTES) {
          toast.error(
            'Screenshot is too large',
            `Images are limited to ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB each. Crop it or save as JPEG.`
          );
          return;
        }

        const body = new FormData();
        body.append('file', upload, upload.name || 'screenshot.png');
        const stored = await api.post('/media', body);
        editor
          ?.chain()
          .focus()
          .setImage({ src: stored.url, alt: file.name || '' })
          .run();
      } catch (error) {
        toast.fromError(error, 'Could not upload that image');
      } finally {
        setUploading(false);
      }
    },
    [editor, toast]
  );

  // So the paste handler, which is built before the editor exists, can reach it.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Reflect external value changes (loading a different finding into the form).
  useEffect(() => {
    if (!editor) return;
    const incoming = value ?? '';
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    editor.commands.setContent(incoming, false);
  }, [value, editor]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editable, editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previous = editor.getAttributes('link').href ?? '';
    // eslint-disable-next-line no-alert -- a prompt is proportionate here
    const url = window.prompt('Link URL', previous);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }, [editor]);

  /*
   * Evidence, openable.
   *
   * A screenshot rendered at the width of a text column is not readable, and the only way to
   * actually look at one was to generate the report. `dblclick` while editing and a plain click
   * when read-only: in the editor a single click has to keep selecting the node, because that is
   * what makes the caption field and the replace button appear.
   */
  const lightbox = useImageLightbox(contentRef, { trigger: editable ? 'dblclick' : 'click' });

  /** Reusable text: the picker, and whatever is selected when it opens. */
  const [snippets, setSnippets] = useState(false);
  const [figureRefs, setFigureRefs] = useState(false);

  /**
   * What `/` offers.
   *
   * Ordered by how often a tester wants it rather than alphabetically: evidence first, then the
   * things that shape a write-up. Each one has to be describable in a few words — a command whose
   * hint needs a sentence is a sign it belongs in the toolbar, not here.
   */
  /**
   * The figures a sentence here could point at.
   *
   * This field's own pictures plus its siblings', in the order the report prints them, so a
   * reference written in the description can reach the screenshot in the proof of concept. Read
   * from the *unsaved* text on purpose: the picture somebody wants to refer to is usually the one
   * they pasted a minute ago, and asking the server would offer them the version before that.
   */
  const referenceFigures = useMemo(() => {
    const record = siblingFields ?? { self: value ?? '' };
    const fields = siblingFields ? Object.keys(siblingFields) : ['self'];
    return referenceableFigures(record, fields);
  }, [siblingFields, value]);

  const slashCommands = useMemo(
    () => [
      {
        id: 'http',
        label: 'Request and response',
        hint: 'Two labelled blocks, ready to paste into',
        icon: ArrowLeftRight,
        keywords: ['request', 'response', 'curl', 'burp'],
        run: (instance) => instance.chain().focus().insertContent(blankHttpExchange()).run(),
      },
      {
        id: 'screenshot',
        label: 'Screenshot',
        hint: 'Choose an image to upload',
        icon: ImagePlus,
        keywords: ['image', 'evidence', 'png'],
        run: () => fileInputRef.current?.click(),
      },
      {
        id: 'code',
        label: 'Code block',
        hint: 'Monospaced, for output and payloads',
        icon: Code2,
        keywords: ['pre', 'output', 'payload'],
        run: (instance) => instance.chain().focus().toggleCodeBlock().run(),
      },
      {
        id: 'table',
        label: 'Table',
        hint: 'Three columns with a header row',
        icon: TableIcon,
        keywords: ['grid', 'rows'],
        run: (instance) =>
          instance.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      },
      {
        id: 'figref',
        label: 'Refer to a figure',
        hint: 'Prints as “Figure 7” and stays right when things move',
        icon: Quote,
        keywords: ['figure', 'screenshot', 'reference', 'cross-reference', 'evidence'],
        run: () => setFigureRefs(true),
      },
      {
        id: 'snippet',
        label: 'Insert a snippet',
        hint: 'Reusable text you have saved',
        icon: BookmarkPlus,
        keywords: ['reuse', 'library', 'boilerplate'],
        run: () => setSnippets(true),
      },
      {
        id: 'list',
        label: 'Bulleted list',
        hint: 'One point per line',
        icon: List,
        keywords: ['bullets', 'points'],
        run: (instance) => instance.chain().focus().toggleBulletList().run(),
      },
      {
        id: 'numbered',
        label: 'Numbered list',
        hint: 'For steps somebody has to follow in order',
        icon: ListOrdered,
        keywords: ['ordered', 'steps'],
        run: (instance) => instance.chain().focus().toggleOrderedList().run(),
      },
      {
        id: 'heading',
        label: 'Heading',
        hint: 'A subheading inside this field',
        icon: Heading2,
        keywords: ['title', 'section'],
        run: (instance) => instance.chain().focus().toggleHeading({ level: 3 }).run(),
      },
      {
        id: 'quote',
        label: 'Quote',
        hint: 'Something the client or a document said',
        icon: Quote,
        keywords: ['blockquote', 'citation'],
        run: (instance) => instance.chain().focus().toggleBlockquote().run(),
      },
      {
        id: 'rule',
        label: 'Divider',
        hint: 'A horizontal line',
        icon: Minus,
        keywords: ['hr', 'separator'],
        run: (instance) => instance.chain().focus().setHorizontalRule().run(),
      },
    ],
    []
  );

  if (!editor) {
    return (
      <div
        className={cn('rounded-lg bg-canvas/60 ring-1 ring-line', className)}
        style={{ minHeight: minHeight + 40 }}
      />
    );
  }

  const inTable = editor.isActive('table');

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg bg-canvas/60 ring-1 ring-line transition focus-within:ring-2 focus-within:ring-brand-500',
        className
      )}
    >
      {editable ? (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line-soft bg-surface/60 px-1.5 py-1.5">
          {/*
            Reusable text, at the front of the toolbar rather than buried in it: the paragraph
            about how testing was authorised gets written every engagement, and the whole point is
            that it should not be typed again.
          */}
          <ToolbarButton
            title="Snippets — reusable text (and save what is selected)"
            icon={BookmarkPlus}
            onClick={() => setSnippets(true)}
          />
          <span className="mx-0.5 h-5 w-px shrink-0 bg-line-soft" aria-hidden />
          <ToolbarButton
            title="Bold"
            icon={Bold}
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolbarButton
            title="Italic"
            icon={Italic}
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolbarButton
            title="Underline"
            icon={UnderlineIcon}
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <ToolbarButton
            title="Strikethrough"
            icon={Strikethrough}
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolbarButton
            title="Highlight"
            icon={Highlighter}
            active={editor.isActive('highlight')}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
          />

          <Divider />

          <ToolbarButton
            title="Heading"
            icon={Heading2}
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <ToolbarButton
            title="Subheading"
            icon={Heading3}
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          />

          <Divider />

          <ToolbarButton
            title="Bullet list"
            icon={List}
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <ToolbarButton
            title="Numbered list"
            icon={ListOrdered}
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <ToolbarButton
            title="Quote"
            icon={Quote}
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />

          <Divider />

          <ToolbarButton
            title="Inline code"
            icon={Code}
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <ToolbarButton
            title="Code block"
            icon={Code2}
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />
          {/*
            * For when the paste heuristic does not fire: select what was pasted and press this to
            * label and format it, or press it with nothing selected to write a pair out by hand.
            */}
          <ToolbarButton
            title="Request and response"
            icon={ArrowLeftRight}
            onClick={() => {
              const { from, to, empty } = editor.state.selection;
              // Block separator, so the selection comes back with its line breaks intact.
              const selected = empty ? '' : editor.state.doc.textBetween(from, to, '\n');
              const html = selected
                ? httpExchangeHtml(parseHttpExchange(selected))
                : blankHttpExchange();
              editor.chain().focus().insertContent(html).run();
            }}
          />

          {compact ? null : (
            <>
              <Divider />
              <ToolbarButton
                title="Align left"
                icon={AlignLeft}
                active={editor.isActive({ textAlign: 'left' })}
                onClick={() => editor.chain().focus().setTextAlign('left').run()}
              />
              <ToolbarButton
                title="Align centre"
                icon={AlignCenter}
                active={editor.isActive({ textAlign: 'center' })}
                onClick={() => editor.chain().focus().setTextAlign('center').run()}
              />
              <ToolbarButton
                title="Align right"
                icon={AlignRight}
                active={editor.isActive({ textAlign: 'right' })}
                onClick={() => editor.chain().focus().setTextAlign('right').run()}
              />
            </>
          )}

          <Divider />

          <ToolbarButton
            title={editor.isActive('link') ? 'Edit link' : 'Add link'}
            icon={Link2}
            active={editor.isActive('link')}
            onClick={setLink}
          />
          {editor.isActive('link') ? (
            <ToolbarButton
              title="Remove link"
              icon={Link2Off}
              onClick={() => editor.chain().focus().unsetLink().run()}
            />
          ) : null}
          <ToolbarButton
            title={uploading ? 'Uploading…' : 'Insert screenshot (or just paste one)'}
            icon={ImagePlus}
            disabled={uploading}
            active={uploading}
            onClick={() => fileInputRef.current?.click()}
          />
          <ToolbarButton
            title="Insert table"
            icon={TableIcon}
            active={inTable}
            onClick={() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
          />
          <ToolbarButton
            title="Horizontal rule"
            icon={Minus}
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />

          {inTable ? (
            <>
              <Divider />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.chain().focus().addRowAfter().run()}
                className="rounded-md px-1.5 py-1 text-[0.6875rem] font-medium text-fg-muted transition hover:bg-white/8 hover:text-fg"
              >
                +Row
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                className="rounded-md px-1.5 py-1 text-[0.6875rem] font-medium text-fg-muted transition hover:bg-white/8 hover:text-fg"
              >
                +Col
              </button>
              <ToolbarButton
                title="Delete table"
                icon={Trash2}
                danger
                onClick={() => editor.chain().focus().deleteTable().run()}
              />
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-0.5">
            <ToolbarButton
              title="Undo"
              icon={Undo2}
              disabled={!editor.can().undo()}
              onClick={() => editor.chain().focus().undo().run()}
            />
            <ToolbarButton
              title="Redo"
              icon={Redo2}
              disabled={!editor.can().redo()}
              onClick={() => editor.chain().focus().redo().run()}
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) readImage(file);
              event.target.value = '';
            }}
          />
        </div>
      ) : null}

      {/* A caption belongs to one image, so the field only exists while one is
          selected — and it is the only place an image is more than decoration. */}
      {editable && editor.isActive('image') ? (
        <div className="flex items-center gap-2 border-b border-line-soft bg-brand-500/[0.06] px-3 py-2">
          <ImageIcon size={13} className="shrink-0 text-brand-300" />
          {/* Discoverable: double-clicking works, but nobody guesses a gesture. */}
          <button
            type="button"
            title="View this screenshot full size"
            onClick={() => lightbox.openBySrc(editor.getAttributes('image').src)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] text-fg-subtle transition hover:bg-white/5 hover:text-fg"
          >
            View
          </button>
          <input
            value={editor.getAttributes('image').caption ?? ''}
            placeholder="Caption this screenshot — it is numbered as a figure in the report"
            onChange={(event) =>
              editor.chain().updateAttributes('image', { caption: event.target.value }).run()
            }
            className="min-w-0 flex-1 bg-transparent text-xs text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          {editor.getAttributes('image').caption ? (
            <button
              type="button"
              onClick={() =>
                editor.chain().focus().updateAttributes('image', { caption: '' }).run()
              }
              className="shrink-0 text-[0.625rem] text-fg-subtle transition hover:text-fg"
            >
              Clear
            </button>
          ) : null}
          {/*
            Retaking a screenshot is the common edit, and the old one is usually referenced in
            more than one place. Only offered for a stored image: a pasted data URI has no id
            to swap.
          */}
          {onReplaceImage && MEDIA_SRC.test(editor.getAttributes('image').src ?? '') ? (
            <>
              <input
                ref={replaceInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  const mediaId = MEDIA_SRC.exec(editor.getAttributes('image').src ?? '')?.[1];
                  if (!file || !mediaId) return;
                  setReplacing(true);
                  try {
                    await onReplaceImage(mediaId, file);
                  } finally {
                    setReplacing(false);
                  }
                }}
              />
              <button
                type="button"
                disabled={replacing}
                onClick={() => replaceInputRef.current?.click()}
                title="Replace this screenshot everywhere it appears in this engagement"
                className="flex shrink-0 items-center gap-1 text-[0.625rem] text-fg-subtle transition hover:text-fg disabled:opacity-50"
              >
                <RefreshCw size={10} className={replacing ? 'animate-spin' : undefined} />
                {replacing ? 'Replacing…' : 'Replace'}
              </button>
              {/*
                Marking up goes through the same door as replacing: annotate, and what comes back is
                a new screenshot that this engagement's references are pointed at. The original is
                left alone because it may be another client's too.
              */}
              <button
                type="button"
                disabled={replacing}
                onClick={() =>
                  setAnnotating({
                    src: editor.getAttributes('image').src,
                    mediaId: MEDIA_SRC.exec(editor.getAttributes('image').src ?? '')?.[1],
                  })
                }
                title="Draw on it, or redact something"
                className="flex shrink-0 items-center gap-1 text-[0.625rem] text-fg-subtle transition hover:text-fg disabled:opacity-50"
              >
                <Highlighter size={10} />
                Annotate
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div ref={contentRef}>
        <EditorContent editor={editor} className="px-3.5 py-3" />
      </div>
      {lightbox.props ? <Lightbox {...lightbox.props} /> : null}
      {editable ? <SlashMenu editor={editor} commands={slashCommands} /> : null}

      <FigureRefPicker
        open={figureRefs}
        onClose={() => setFigureRefs(false)}
        figures={referenceFigures}
        onPick={(figure) => {
          editor
            ?.chain()
            .focus()
            .insertFigureRef({ media: figure.media, label: figure.label || 'a figure' })
            .run();
          setFigureRefs(false);
        }}
      />

      {annotating ? (
        <Annotator
          open
          src={annotating.src}
          busy={replacing}
          onClose={() => setAnnotating(null)}
          onSave={async (file) => {
            if (!annotating.mediaId) return;
            setReplacing(true);
            try {
              await onReplaceImage(annotating.mediaId, file);
              setAnnotating(null);
            } finally {
              setReplacing(false);
            }
          }}
        />
      ) : null}

      <SnippetPicker
        open={snippets}
        onClose={() => setSnippets(false)}
        /*
         * What is selected right now, as HTML — so "save this paragraph" is one action rather
         * than copy, open, paste, name.
         */
        selectionHtml={(() => {
          const { from, to } = editor.state.selection;
          if (from === to) return '';
          const slice = editor.state.doc.slice(from, to);
          const div = document.createElement('div');
          div.appendChild(
            DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content)
          );
          return div.innerHTML;
        })()}
        onInsert={(html) => editor.chain().focus().insertContent(html).run()}
      />
    </div>
  );
}

export default RichTextEditor;
