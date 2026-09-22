/**
 * Can the editor actually write the five new blocks, and do they survive a save?
 *
 *   npm run test:report-blocks --workspace client
 *
 * The server suite proves the document end: a page break is a page break, a callout is a shaded
 * box, a reference resolves to an identifier, a footnote goes to the foot of the page. This proves
 * the end that can quietly stop working — that ProseMirror's schema keeps the attributes at all.
 *
 * That is the whole contract between the two halves. If TipTap drops `data-callout`, every warning
 * box in every report silently becomes an ordinary paragraph, every server check still passes, and
 * nothing anywhere says so.
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
const { ParagraphWithClass } = await import('../src/components/editor/KeepClass.js');
const { FindingRef } = await import('../src/components/editor/FindingRef.js');
const { Callout, PageBreak, Footnote, CALLOUT_KINDS } = await import(
  '../src/components/editor/ReportBlocks.js'
);

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

const makeEditor = (content) =>
  new Editor({
    element: dom.window.document.body,
    extensions: [
      StarterKit.configure({ paragraph: false, horizontalRule: false }),
      ParagraphWithClass,
      PageBreak,
      Callout,
      Footnote,
      FindingRef,
    ],
    content,
  });

/* The round trip that matters: HTML in, HTML out, nothing lost in between. */
const roundTrip = (html) => makeEditor(html).getHTML();

/* --------------------------------------------------------------- the attributes --- */

console.log('The schema keeps what the server reads:');

check(
  'a page break comes back as one',
  roundTrip('<p>a</p><hr data-page-break><p>b</p>').includes('data-page-break'),
  roundTrip('<p>a</p><hr data-page-break><p>b</p>')
);
check(
  'and an ordinary rule does not acquire one',
  !roundTrip('<p>a</p><hr><p>b</p>').includes('data-page-break'),
  roundTrip('<p>a</p><hr><p>b</p>')
);

for (const { value } of CALLOUT_KINDS) {
  const html = roundTrip(`<aside data-callout="${value}"><p>Body.</p></aside>`);
  check(`a ${value} callout keeps its kind`, html.includes(`data-callout="${value}"`), html);
}
check(
  'and its contents',
  roundTrip('<aside data-callout="note"><p>Body.</p></aside>').includes('Body.')
);
check(
  'a callout can hold a list',
  roundTrip('<aside data-callout="danger"><ul><li>prod</li></ul></aside>').includes('<li>'),
  roundTrip('<aside data-callout="danger"><ul><li>prod</li></ul></aside>')
);

const ref = roundTrip('<p>See <span data-findingref="aaaaaaaaaaaaaaaaaaaaaaaa">Stored XSS</span>.</p>');
check('a finding reference keeps its id', ref.includes('data-findingref="aaaaaaaaaaaaaaaaaaaaaaaa"'), ref);
check('and the title the author saw', ref.includes('Stored XSS'), ref);

const note = roundTrip('<p>Scanned<span data-footnote>nmap 7.94.</span> it.</p>');
check('a footnote keeps its marker', note.includes('data-footnote'), note);
check('and its words', note.includes('nmap 7.94.'), note);

/* ------------------------------------------------------------------ the commands --- */

console.log('\nThe commands write them:');

const editor = makeEditor('<p>Something.</p>');
editor.commands.setTextSelection(2);

editor.commands.setCallout('warning');
check(
  'wrapping a paragraph makes a callout of it',
  /<aside[^>]*data-callout="warning"[^>]*>[\s\S]*Something\./.test(editor.getHTML()),
  editor.getHTML()
);
editor.commands.setCalloutKind('danger');
check(
  'and the kind can be changed without unwrapping',
  editor.getHTML().includes('data-callout="danger"') && editor.getHTML().includes('Something.'),
  editor.getHTML()
);
editor.commands.unsetCallout();
check(
  'lifting it gives the paragraph back',
  !editor.getHTML().includes('data-callout') && editor.getHTML().includes('Something.'),
  editor.getHTML()
);

const breaker = makeEditor('<p>Before.</p>');
breaker.commands.setTextSelection(2);
breaker.commands.setPageBreak();
check(
  'the page-break command writes the attribute, not a bare rule',
  breaker.getHTML().includes('data-page-break'),
  breaker.getHTML()
);

const footer = makeEditor('<p>Scanned it.</p>');
footer.commands.setTextSelection(8);
footer.commands.insertFootnote('nmap 7.94, default scripts.');
check(
  'the footnote command inserts one where the cursor is',
  footer.getHTML().includes('data-footnote') && footer.getHTML().includes('nmap 7.94'),
  footer.getHTML()
);

const referrer = makeEditor('<p>See .</p>');
referrer.commands.setTextSelection(5);
referrer.commands.insertFindingRef({ finding: 'bbbbbbbbbbbbbbbbbbbbbbbb', label: 'SSRF' });
check(
  'the reference command inserts a chip',
  referrer.getHTML().includes('data-findingref="bbbbbbbbbbbbbbbbbbbbbbbb"'),
  referrer.getHTML()
);

/* ----------------------------------------------------------------- they are atoms --- */

console.log('\nThe chips are one thing, not editable text:');

const atomic = makeEditor('<p><span data-findingref="aaaaaaaaaaaaaaaaaaaaaaaa">Stored XSS</span></p>');
let refNode = null;
atomic.state.doc.descendants((node) => {
  if (node.type.name === 'findingRef') refNode = node;
});
check('a finding reference is an atom', refNode?.type.isAtom === true, String(refNode?.type.name));
check('and inline', refNode?.type.isInline === true);

const atomicNote = makeEditor('<p><span data-footnote>a note</span></p>');
let noteNode = null;
atomicNote.state.doc.descendants((node) => {
  if (node.type.name === 'footnote') noteNode = node;
});
check('a footnote is an atom too', noteNode?.type.isAtom === true, String(noteNode?.type.name));

/* Reinstating the fault: an editable chip is the version that rots silently. */
check(
  'the check would notice a chip becoming editable text',
  refNode?.type.isAtom !== false,
  'the atom assertion is not load-bearing'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
