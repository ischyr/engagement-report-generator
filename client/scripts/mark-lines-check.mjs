/**
 * Can a write-up point at a line of its own pane, and does the pointing reach the document?
 *
 *   npm run test:mark-lines --workspace client
 *
 * The .docx converter has drawn `data-mark-lines` in the accent colour since the enumeration panes
 * gained them, and `npm run test:code-pane` proves that end. This proves the other end and the
 * join: that the editor can *write* the attribute, that ProseMirror's schema does not drop it the
 * moment anybody saves, and that the two halves agree on what `"4,7"` means.
 *
 * The attribute is the entire contract between them. If TipTap strips it, every check on the
 * server still passes and no line in any write-up is ever highlighted again — which is why this
 * runs the editor's own output through the real converter rather than asserting on markup twice.
 */

import { JSDOM } from 'jsdom';

/* Before TipTap is imported: ProseMirror reads `document` while its modules load. */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const name of [
  'window',
  'document',
  'navigator',
  'DOMParser',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'Text',
  'Range',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'ClipboardEvent',
  'getSelection',
  'MutationObserver',
]) {
  if (globalThis[name] === undefined && dom.window[name] !== undefined) {
    globalThis[name] = dom.window[name];
  }
}

const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { CodeBlockWithClass, ParagraphWithClass } = await import(
  '../src/components/editor/KeepClass.js'
);
const { htmlToOoxml } = await import('../../server/src/services/ooxml/html2ooxml.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** The same schema the app builds, minus everything that needs a network or a socket. */
const makeEditor = (content) =>
  new Editor({
    element: dom.window.document.body,
    extensions: [
      StarterKit.configure({ paragraph: false, codeBlock: false }),
      ParagraphWithClass,
      CodeBlockWithClass.configure({ HTMLAttributes: { class: 'engy-code-block' } }),
    ],
    content,
  });

const PANE = 'GET /invoice?id=1 HTTP/1.1\nHost: billing.example.com\nCookie: session=abc\nX-Debug: 1';

/** The runs of the rendered pane, so a check can ask which line came out accented. */
const runsOf = (xml) =>
  [...xml.matchAll(/<w:r>(?:(?!<w:r>)[\s\S])*?<\/w:r>/g)].map((m) => ({
    bold: m[0].includes('<w:b/>'),
    text: [...m[0].matchAll(/<w:t(?=[ >])[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => t[1])
      .join('')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'),
  }));

/* ------------------------------------------------------------------ the attribute --- */

console.log('The editor keeps it:');

const pasted = makeEditor(`<pre data-mark-lines="3"><code>${PANE}</code></pre>`);
check(
  'an attribute already on the markup survives being loaded',
  pasted.getHTML().includes('data-mark-lines="3"'),
  pasted.getHTML().slice(0, 140)
);

/* The class the editor configures and the one the node carries must both still be there: this
 * extension used to be only about `class`, and adding an attribute is how that gets broken. */
check(
  'and the class it was configured with is still on the pre',
  pasted.getHTML().includes('engy-code-block'),
  pasted.getHTML().slice(0, 140)
);

const clean = makeEditor(`<pre><code>${PANE}</code></pre>`);
check(
  'a pane nobody marked carries no attribute at all',
  !clean.getHTML().includes('data-mark-lines'),
  clean.getHTML().slice(0, 140)
);

/* ---------------------------------------------------------------- setting it ------- */

console.log('\nMarking a line:');

const editor = makeEditor(`<pre><code>${PANE}</code></pre>`);
/* Into the pane's text, which is one step inside the node. */
editor.commands.setTextSelection(2);
editor.chain().updateAttributes('codeBlock', { markLines: '3' }).run();
check(
  'the command writes the attribute',
  editor.getHTML().includes('data-mark-lines="3"'),
  editor.getHTML().slice(0, 140)
);

editor.chain().updateAttributes('codeBlock', { markLines: '1,3' }).run();
check('a second line is added to it', editor.getHTML().includes('data-mark-lines="1,3"'));

editor.chain().updateAttributes('codeBlock', { markLines: null }).run();
check(
  'clearing the last one removes the attribute rather than leaving it empty',
  !editor.getHTML().includes('data-mark-lines'),
  editor.getHTML().slice(0, 140)
);

/* Typing must not disturb it — this is the attribute's whole job, surviving an edit. */
const edited = makeEditor(`<pre data-mark-lines="2"><code>${PANE}</code></pre>`);
edited.commands.setTextSelection(2);
edited.commands.insertContent('X');
check(
  'editing the text leaves the mark where it was',
  edited.getHTML().includes('data-mark-lines="2"'),
  edited.getHTML().slice(0, 140)
);

/* ------------------------------------------------------------- and into the docx --- */

console.log('\nAnd it reaches the document:');

const options = { codeTheme: 'terminal', codeLineNumbers: true, codeHighlight: false };
const marked = htmlToOoxml(makeEditor(`<pre data-mark-lines="3"><code>${PANE}</code></pre>`).getHTML(), options);
const unmarked = htmlToOoxml(makeEditor(`<pre><code>${PANE}</code></pre>`).getHTML(), options);

const boldText = runsOf(marked)
  .filter((run) => run.bold)
  .map((run) => run.text);

check(
  'the marked line is the one drawn in the accent',
  boldText.join('|') === 'Cookie: session=abc',
  JSON.stringify(boldText)
);
check('and it is the only one', boldText.length === 1, String(boldText.length));
check(
  'a pane with nothing marked has nothing accented',
  runsOf(unmarked).every((run) => !run.bold)
);

/*
 * The grammar has to be the same on both sides, or the picker writes something the converter
 * reads as no lines at all — which looks exactly like the feature not working.
 */
const several = htmlToOoxml(
  makeEditor(`<pre data-mark-lines="1,4"><code>${PANE}</code></pre>`).getHTML(),
  options
);
check(
  'a comma-separated list marks each of them',
  runsOf(several)
    .filter((run) => run.bold)
    .map((run) => run.text)
    .join('|') === 'GET /invoice?id=1 HTTP/1.1|X-Debug: 1',
  JSON.stringify(runsOf(several).filter((r) => r.bold).map((r) => r.text))
);

/* A number past the end of the pane is nonsense rather than a crash: the pane shrank after it was
 * marked, which is exactly what happens when somebody trims their output afterwards. */
const beyond = htmlToOoxml(
  makeEditor(`<pre data-mark-lines="99"><code>${PANE}</code></pre>`).getHTML(),
  options
);
check(
  'a line number past the end of the pane marks nothing and breaks nothing',
  runsOf(beyond).every((run) => !run.bold) && beyond.includes('X-Debug: 1')
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
