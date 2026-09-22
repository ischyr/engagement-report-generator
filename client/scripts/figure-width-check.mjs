/**
 * Does "print this one half width" survive being saved?
 *
 *   npm run test:figure-width --workspace client
 *
 * `npm run test:figures` proves the document end: a picture asked for at half the column comes out
 * at half the column, and two in a two-column table each come out the size of their cell. This
 * proves the editor end, which is the half that fails silently — TipTap's schema decides what an
 * image may carry, and an attribute it does not know about is dropped on the way in. Every check
 * on the server would still pass, and no screenshot in any report would ever be resized again.
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
const { default: FigureImage } = await import('../src/components/editor/FigureImage.js');

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
    extensions: [StarterKit, FigureImage],
    content,
  });

const SRC = '/api/media/aaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Select the picture, wherever it ended up.
 *
 * Not position 0: an image is a block, so the document opens with the empty paragraph the content
 * was parsed alongside and position 0 is that. Selecting it meant `updateAttributes('image')` had
 * no image to update and quietly did nothing — which is a test that passes because it is not
 * testing anything.
 */
const selectImage = (editor) => {
  let at = null;
  editor.state.doc.descendants((node, pos) => {
    if (at === null && node.type.name === 'image') at = pos;
    return at === null;
  });
  if (at === null) throw new Error('no image in the document');
  editor.commands.setNodeSelection(at);
  return at;
};

/* ------------------------------------------------------------------ the attribute --- */

console.log('The editor keeps it:');

const plain = makeEditor(`<p><img src="${SRC}" data-width="50"></p>`);
check(
  'a bare image keeps the width it was loaded with',
  plain.getHTML().includes('data-width="50"'),
  plain.getHTML()
);

/*
 * A captioned picture is a `<figure>`, which parses through its own `getAttrs` rather than through
 * each attribute's own rule — so it is its own way of losing this, and its own check.
 */
const captioned = makeEditor(
  `<figure><img src="${SRC}" data-width="33"><figcaption>The dialog</figcaption></figure>`
);
check(
  'and so does a captioned one',
  captioned.getHTML().includes('data-width="33"'),
  captioned.getHTML()
);
check(
  'without losing the caption it came with',
  captioned.getHTML().includes('The dialog'),
  captioned.getHTML()
);

const untouched = makeEditor(`<p><img src="${SRC}"></p>`);
check(
  'a picture nobody resized carries no attribute at all',
  !untouched.getHTML().includes('data-width'),
  untouched.getHTML()
);

/* ---------------------------------------------------------------- setting it ------- */

console.log('\nChanging it:');

const editor = makeEditor(`<p><img src="${SRC}"></p>`);
selectImage(editor);
editor.chain().updateAttributes('image', { printWidth: '50' }).run();
check('the control writes the attribute', editor.getHTML().includes('data-width="50"'), editor.getHTML());

editor.chain().updateAttributes('image', { printWidth: '100' }).run();
check('and changes it', editor.getHTML().includes('data-width="100"'), editor.getHTML());

editor.chain().updateAttributes('image', { printWidth: null }).run();
check(
  'back to Auto removes it rather than writing a zero',
  !editor.getHTML().includes('data-width'),
  editor.getHTML()
);

/* The caption and the width are separate attributes on one node, and setting either must not
 * disturb the other — they share the bar in the editor, which is how that gets broken. */
const both = makeEditor(`<p><img src="${SRC}"></p>`);
selectImage(both);
both.chain().updateAttributes('image', { printWidth: '50' }).run();
both.chain().updateAttributes('image', { caption: 'Half width' }).run();
check(
  'a caption added afterwards keeps the width',
  both.getHTML().includes('data-width="50"') && both.getHTML().includes('Half width'),
  both.getHTML()
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
