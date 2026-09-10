import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { FigureImage } from './FigureImage.js';
import { FigureRef } from './FigureRef.js';
import FigureRefPicker from './FigureRefPicker.jsx';
import ScopeHostPicker from './ScopeHostPicker.jsx';
import { CodeBlockWithClass, ParagraphWithClass } from './KeepClass.js';
import Lightbox from '../ui/Lightbox.jsx';
import SnippetPicker from './SnippetPicker.jsx';
import { referenceableFigures } from '../../lib/figures.js';
import { hostsFromScope } from '../../lib/scope-hosts.js';
import SlashMenu from './SlashMenu.jsx';
import Annotator from './Annotator.jsx';
import { useImageLightbox } from '../../hooks/useImageLightbox.js';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';

import { AlignCenter, AlignLeft, AlignRight, ArrowLeftRight, Bold, BookmarkPlus, Code, Code2, Heading2, Heading3, Highlighter, Image as ImageIcon, ImagePlus, Italic, Link2, Link2Off, List, ListOrdered, Minus, Quote, Redo2, RefreshCw, ServerCog, Strikethrough, Table as TableIcon, Trash2, Underline as UnderlineIcon, Undo2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { ignoredNote, pickEvidence, shrinkImage } from '../../lib/images.js';
import { isRecording, posterFromRecording } from '../../lib/recordings.js';
import {
  blankHttpExchange,
  httpExchangeHtml,
  looksLikeHttp,
  parseHttpExchange,
} from '../../lib/http-evidence.js';
import { parsePastedTable, tableHtml } from '../../lib/table-paste.js';
import { cn } from '../../lib/utils.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * Per-image ceiling. Generous, because it is no longer doing double duty as a
 * limit on the engagement as a whole: images are uploaded to storage and the
 * document keeps only a reference, so total evidence is bounded by disk rather
 * than by MongoDB's 16 MB document cap.
 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/**
 * A recording gets more room, matching the server's own ceiling.
 *
 * Both numbers live in `media.service.js` as well, which is where they are enforced. Repeated here
 * so the browser can say "that is too long" before spending two minutes uploading it.
 */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

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
  /**
   * The engagement's scope, so the affected-assets field can be filled from it.
   *
   * Absent means the slash menu simply does not offer it, which is right for an editor with no
   * engagement behind it — a template, a library entry, a snippet.
   */
  scopeHosts = null,
  /**
   * A live shared document for this field, or null for the way it has always worked.
   *
   * `{ provider, doc }` from `useCollab`, and only ever handed over once the socket is actually
   * connected. The caller remounts this component when that changes — the extension list is fixed
   * when an editor is created, so becoming collaborative is a new editor rather than a new prop.
   */
  collab = null,
}) {
  const toast = useToast();
  const fileInputRef = useRef(null);
  /** The rendered content, for the delegated image-click listener. */
  const contentRef = useRef(null);
  const replaceInputRef = useRef(null);
  /**
   * The uploader, reachable from the drop and paste handlers.
   *
   * Those are built as part of the editor's configuration, which happens before `readImages`
   * exists and captures whatever binding was current at the time — and on the first render that
   * binding closes over an `editor` that is still null, so a paste would have uploaded the file
   * and then quietly failed to insert it. The editor itself already goes through a ref for exactly
   * this reason; this is the same fix for the other half of the same handler.
   */
  const readImagesRef = useRef(null);
  /**
   * How many pictures are going up, and how far along.
   *
   * A count rather than a boolean because the gesture is now "drop the folder": a spinner that
   * says nothing for four minutes is indistinguishable from one that has hung, and the person
   * who dropped fifty screenshots is entitled to know it is on the eleventh.
   */
  const [uploading, setUploading] = useState(null);
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
        /*
         * The kit's undo is turned off while a document is shared, and only then.
         *
         * Two undo stacks over one document is the classic way to undo somebody else's sentence:
         * the local history has no idea which changes were yours. `Collaboration` brings its own,
         * which is scoped to the person pressing the key.
         */
        ...(collab ? { history: false } : {}),
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
      ...(collab
        ? [
            Collaboration.configure({ document: collab.doc }),
            /*
             * The caret with a name on it, and the name has to be given *here*.
             *
             * `CollaborationCursor` writes its own `user` into the provider's awareness when it is
             * created, so whatever the hook set a moment earlier is overwritten — and its default
             * is `{ name: null }`, which is why the label read "User: 2343865819": with no name to
             * render, y-prosemirror falls back to printing the client id at somebody.
             */
            CollaborationCursor.configure({
              provider: collab.provider,
              user: collab.user,
            }),
          ]
        : []),
    ],
    [placeholder, collab]
  );

  /*
   * The paste handler needs the editor, and the editor needs the paste handler — a ref settles it
   * rather than rebuilding the instance, which would drop the undo history on every keystroke.
   */
  const editorRef = useRef(null);
  /*
   * The current collaboration handle, for the update callback.
   *
   * `useEditor` closes over the props it was created with, and `synced` flips *after* creation —
   * so the callback below would go on believing the document was still catching up for ever. Same
   * arrangement as `editorRef` above, and for the same reason.
   */
  const collabRef = useRef(collab);
  useEffect(() => {
    collabRef.current = collab;
  }, [collab]);

  const editor = useEditor({
    extensions,
    /*
     * A shared document seeds itself, and must not be seeded here.
     *
     * `Collaboration` reads the document out of the Y doc. Passing `content` as well would insert
     * this client's copy of the text *into* whatever is already there — so the second person to
     * open a finding would double it. Which client puts the stored HTML in, and when, is decided
     * in `useCollabField`; every other client simply receives it.
     */
    content: collab ? undefined : value ?? '',
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
        const pasted = items
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (pasted.length) {
          event.preventDefault();
          readImagesRef.current?.(pasted);
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

        /*
         * A grid — from a spreadsheet, a database client, or a tool that prints markdown tables.
         *
         * Taken as prose the columns collapse and the rows run together, and what people do about
         * that is paste a *screenshot* of the table instead: an image of text that cannot be
         * searched, copied, or read in a printed report at under full size. The editor has had
         * tables all along; this is the step that was missing between the clipboard and using them.
         *
         * Only claimed for tab-separated and markdown grids — see `table-paste.js` for why not
         * commas. Anything else falls through to the editor's own paste, and ⌘Z puts back a
         * conversion that was not wanted.
         */
        const grid = parsePastedTable(text);
        if (grid) {
          event.preventDefault();
          view.dispatch(view.state.tr.scrollIntoView());
          editorRef.current?.chain().focus().insertContent(tableHtml(grid)).run();
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        /*
         * Everything dropped, not the first thing dropped.
         *
         * This took `.find(...)`, so dragging in a folder of evidence inserted one screenshot and
         * discarded the rest without saying so — which looks like it worked, and is found out
         * later by a report with one picture in it.
         */
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.some((file) => file.type.startsWith('image/'))) return false;
        event.preventDefault();
        /* Where they were let go, rather than wherever the caret happened to be. */
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        readImagesRef.current?.(files, at);
        return true;
      },
    },
    onFocus() {
      onFocus?.();
    },
    onUpdate({ editor: instance }) {
      /*
       * Nothing is reported while a shared document is still catching up.
       *
       * `Collaboration` mounts the editor empty and fills it from the document a moment later, and
       * that arrival is itself an update — so without this the form is told the field is now blank,
       * is marked as edited, and a save in the next second writes an empty finding over somebody's
       * write-up. The document holds the real text by the time it is synced, and every update after
       * that is a real one.
       */
      if (collabRef.current && !collabRef.current.synced) return;

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
  /** One picture: shrink it, store it, drop it in. Returns why it failed, or nothing. */
  const uploadOne = useCallback(
    async (file, at) => {
      /*
       * Shrunk before the size check, not after it.
       *
       * A screenshot off a 4K display is seven-eighths pixels the page cannot print, and the
       * old behaviour was to refuse it and tell somebody to go and crop it themselves. Almost
       * every one of those now simply fits, and the ones that still do not get the same message.
       */
      /*
       * A recording goes in as two objects: a still frame, and the recording behind it.
       *
       * The frame first, because the video's own record points at it — and because the frame is
       * what the prose, the numbering and the document all use. If the browser cannot produce one
       * it cannot play the file either, so the whole thing is refused with the reason rather than
       * storing evidence nobody can watch.
       */
      let posterUrl = '';
      let videoUrl = '';
      if (isRecording(file)) {
        if (file.size > MAX_RECORDING_BYTES) {
          return `${file.name || 'that recording'} is over ${Math.round(
            MAX_RECORDING_BYTES / 1024 / 1024
          )} MB — trim it to the part that matters`;
        }
        const still = await posterFromRecording(file);
        if (!still) {
          return `${file.name || 'that recording'} could not be read by this browser — export it as MP4 or WebM`;
        }

        const posterBody = new FormData();
        posterBody.append('file', still.file, still.file.name);
        const storedPoster = await api.post('/media', posterBody);

        const videoBody = new FormData();
        videoBody.append('file', file, file.name || 'recording.mp4');
        videoBody.append('poster', storedPoster.id);
        const storedVideo = await api.post('/media', videoBody);

        posterUrl = storedPoster.url;
        videoUrl = storedVideo.url;
      }

      const shrunk = posterUrl ? null : await shrinkImage(file);
      const upload = shrunk?.file;
      if (upload && upload.size > MAX_IMAGE_BYTES) {
        return `${file.name || 'a screenshot'} is over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB even after scaling`;
      }

      let stored = { url: posterUrl };
      if (!posterUrl) {
        const body = new FormData();
        body.append('file', upload, upload.name || 'screenshot.png');
        stored = await api.post('/media', body);
      }
      /*
       * `focus(at)` for the first one only — where it was dropped. Every one after it follows the
       * caret, which the insert has just moved past the previous picture, so twenty screenshots
       * land in the order they were selected. That order is not cosmetic: the report numbers
       * figures by the order they appear in it.
       */
      const chain = editor?.chain();
      if (!chain) return null;
      /* A position only when there is one: `focus(undefined)` and `focus(null)` do not mean the
         same thing to TipTap, and the second one is not "leave the caret alone". */
      (typeof at === 'number' ? chain.focus(at) : chain.focus())
        .setImage({ src: stored.url, alt: file.name || '', video: videoUrl })
        .run();
      return null;
    },
    [editor]
  );

  /**
   * Every picture in one gesture, one after another.
   *
   * Sequential rather than parallel, deliberately. Twenty concurrent uploads would arrive in
   * whatever order the network felt like, and the order pictures appear in is the order they are
   * numbered in — so "Figure 3" would be whichever happened to finish third.
   *
   * One that fails does not stop the rest: on an engagement's worth of evidence the useful
   * outcome is nineteen in and one named, not nineteen abandoned because the seventh was a .heic
   * the browser cannot decode.
   */
  const readImages = useCallback(
    async (list, at) => {
      const { items: images, ignored, dropped, videos } = pickEvidence(list);
      const note = ignoredNote({ ignored, dropped, what: 'a picture or a recording' });
      if (!images.length) {
        toast.error(
          note ? 'Nothing there was evidence' : 'That file is not a picture or a recording',
          note
        );
        return;
      }
      if (note) toast.info(`Taking ${images.length}`, note);
      /*
       * Said once, before the uploading starts: a recording takes a visible moment to decode a
       * frame out of, and an editor that appears to have frozen is one somebody clicks again.
       */
      if (videos) {
        toast.info(
          `Reading ${videos} recording${videos === 1 ? '' : 's'}`,
          'A still frame is taken from each one — that is what the report prints.'
        );
      }

      setUploading({ done: 0, total: images.length });
      const failed = [];
      try {
        for (const [index, file] of images.entries()) {
          try {
            const why = await uploadOne(file, index === 0 ? at : undefined);
            if (why) failed.push(why);
          } catch (error) {
            failed.push(`${file.name || 'a screenshot'}: ${error.message}`);
          }
          setUploading({ done: index + 1, total: images.length });
        }
      } finally {
        setUploading(null);
      }

      if (failed.length) {
        toast.error(
          `${failed.length} of ${images.length} did not go in`,
          /* The first two by name; a list of fifty is not a message. */
          failed.slice(0, 2).join(' · ') + (failed.length > 2 ? ` · and ${failed.length - 2} more` : '')
        );
      } else if (images.length > 1) {
        toast.success(`${images.length} screenshots added`, 'Each one is numbered in the report.');
      }
    },
    [toast, uploadOne]
  );

  // So the paste and drop handlers, built before the editor exists, can reach both.
  useEffect(() => {
    editorRef.current = editor;
    readImagesRef.current = readImages;
  }, [editor, readImages]);

  /**
   * The stored text, put into the shared document once, by one client.
   *
   * A room starts empty — the server holds no copy of anything between sessions, deliberately, so
   * that Mongo stays the only home the text has. Somebody therefore has to put the HTML in, and it
   * must be exactly one somebody: two clients seeding the same paragraph would leave the finding
   * saying it twice.
   *
   * Two conditions, both required. The document has to be *empty*, which rules out joining an
   * edit already in progress; and this client has to be the writer — the lowest client id in the
   * room, the same one that saves — which settles it when two people open a cold finding at the
   * same moment.
   */
  useEffect(() => {
    if (!editor || !collab?.doc) return;
    /*
     * Not before the server's copy has arrived. A document is empty for a moment after the socket
     * opens whether or not it has anything in it, and seeding in that window is how a finding
     * comes to contain itself twice.
     */
    if (!collab.synced) return;
    if (!collab.canSeed) return;
    const fragment = collab.doc.getXmlFragment('default');
    if (fragment.length > 0) return;
    const html = value ?? '';
    if (!html.trim()) return;
    lastEmitted.current = html;
    editor.commands.setContent(html, false);
  }, [editor, collab?.doc, collab?.canSeed, collab?.synced, value]);

  // Reflect external value changes (loading a different finding into the form).
  useEffect(() => {
    if (!editor) return;
    /*
     * Never while the document is shared.
     *
     * This effect exists for a form being re-seeded — a different finding loaded into the same
     * editor. With a shared document the text arrives through the document itself, and writing
     * this client's copy over it would undo whatever a colleague typed in the last second.
     */
    if (collab?.doc) return;
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
  const [scopePicker, setScopePicker] = useState(false);

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

  /** Whether the scope has anything pickable in it, which decides if the command exists at all. */
  const hasScopeHosts = useMemo(
    () => hostsFromScope(scopeHosts).some((group) => group.hosts.length),
    [scopeHosts]
  );

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
      /*
       * Only when there is a scope to pick from. A command that opens a dialog saying "there is
       * nothing here" is worse than no command, and this editor is used on templates and library
       * entries that have no engagement behind them at all.
       */
      ...(hasScopeHosts
        ? [
            {
              id: 'scope-hosts',
              label: 'Hosts from scope',
              hint: 'Pick the affected assets and print “nine of the forty”',
              icon: ServerCog,
              keywords: ['asset', 'affected', 'host', 'ip', 'scope', 'target'],
              run: () => setScopePicker(true),
            },
          ]
        : []),
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
    [hasScopeHosts]
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
            title={
              uploading
                ? `Uploading ${Math.min(uploading.done + 1, uploading.total)} of ${uploading.total}…`
                : 'Insert screenshots — as many as you like, or just paste one'
            }
            icon={ImagePlus}
            disabled={Boolean(uploading)}
            active={Boolean(uploading)}
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
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              /* Cleared before the upload starts, so picking the same files again still fires. */
              event.target.value = '';
              if (files.length) readImages(files);
            }}
          />
        </div>
      ) : null}

      {/*
        What is happening, while fifty screenshots go up.

        A tooltip on a disabled button is not progress: nobody hovers a control they cannot press.
        This is the only place the editor says how far along it is, and it is the difference
        between waiting and wondering whether it has hung.
      */}
      {uploading ? (
        <div className="flex items-center gap-3 border-b border-line-soft bg-brand-500/[0.06] px-3 py-2">
          <span className="text-[0.6875rem] tabular-nums text-fg-muted">
            {uploading.total === 1
              ? 'Uploading a screenshot…'
              : `Uploading ${Math.min(uploading.done + 1, uploading.total)} of ${uploading.total} screenshots…`}
          </span>
          <span className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full bg-brand-400 transition-[width] duration-200"
              style={{ width: `${Math.round((uploading.done / uploading.total) * 100)}%` }}
            />
          </span>
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

      <ScopeHostPicker
        open={scopePicker}
        onClose={() => setScopePicker(false)}
        scope={scopeHosts}
        onInsert={(html) => {
          editor?.chain().focus().insertContent(html).run();
          setScopePicker(false);
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
