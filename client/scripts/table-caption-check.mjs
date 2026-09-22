/**
 * Can a table actually be given a caption, and does the caption survive the round trip?
 *
 *   npm run test:table-caption --workspace client
 *
 * The server suite (`npm run test:captions`) proves the document end: a marked paragraph before a
 * table becomes "Table 3 — Hosts in scope", numbered on Word's own counter. This proves the other
 * end, which is the one that can quietly stop working — that the editor can *write* that markup at
 * all, and that ProseMirror's schema does not drop the attribute the moment anybody saves.
 *
 * The attribute is the whole contract between the two halves. If TipTap strips it, everything on
 * the server still passes and no table in any report is ever captioned again.
 *
 * And the reason the caption is a sibling paragraph rather than a `<caption>` — that
 * `prosemirror-tables` reads a table's children as rows — is itself asserted here, by adding a
 * column to a captioned table and checking the table still has the shape it should.
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
const { default: Table } = await import('@tiptap/extension-table');
const { default: TableRow } = await import('@tiptap/extension-table-row');
const { default: TableCell } = await import('@tiptap/extension-table-cell');
const { default: TableHeader } = await import('@tiptap/extension-table-header');
const { ParagraphWithClass } = await import('../src/components/editor/KeepClass.js');
const { addTableCaption, removeTableCaption, tableAround } = await import(
  '../src/components/editor/TableCaption.js'
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

/** The same schema the app builds, minus everything that needs a network or a socket. */
const makeEditor = (content) =>
  new Editor({
    element: dom.window.document.body,
    extensions: [
      StarterKit.configure({ paragraph: false }),
      ParagraphWithClass,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content,
  });

const TABLE = '<table><tbody><tr><th>host</th><th>port</th></tr><tr><td>10.0.0.5</td><td>443</td></tr></tbody></table>';

/**
 * Put the cursor in the first cell of the first table.
 *
 * Inside the cell's *paragraph*, not the cell: a cell holds blocks, so a selection one step inside
 * it points at a node with no inline content and ProseMirror says so on the way past.
 */
const intoTable = (editor) => {
  let cell = null;
  editor.state.doc.descendants((node, at) => {
    if (cell === null && ['tableCell', 'tableHeader'].includes(node.type.name)) cell = at;
    return cell === null;
  });
  /* +2: one step into the cell, one into the paragraph it opens with. */
  const pos = cell + 2;
  editor.commands.setTextSelection(pos);
  return pos;
};

const run = (editor, command) => {
  const { state, view } = editor;
  return command(state, view.dispatch);
};

/* ------------------------------------------------------------------ the attribute --- */

console.log('The schema keeps the attribute:');

const parsed = makeEditor(`<p data-table-caption="">Hosts in scope</p>${TABLE}`);
check(
  'a marked paragraph is read back marked',
  parsed.getHTML().includes('data-table-caption'),
  parsed.getHTML().slice(0, 140)
);
check('with its words intact', parsed.getHTML().includes('Hosts in scope'));
check(
  'an ordinary paragraph is still ordinary',
  !makeEditor('<p>Plain.</p>').getHTML().includes('data-table-caption'),
  makeEditor('<p>Plain.</p>').getHTML()
);
check(
  'and the class attribute still survives alongside it',
  makeEditor('<p class="http-label">x</p>').getHTML().includes('class="http-label"'),
  makeEditor('<p class="http-label">x</p>').getHTML()
);

/* --------------------------------------------------------------------- the command --- */

console.log('\nAdding one:');

const editor = makeEditor(`<p>Before.</p>${TABLE}`);
intoTable(editor);

check('the command finds the table the cursor is in', tableAround(editor.state) !== null);
check('which has no caption yet', tableAround(editor.state)?.captionPos === null);

check('adding one reports that it did', run(editor, addTableCaption) === true);
check(
  'and the document now has one',
  editor.getHTML().includes('data-table-caption'),
  editor.getHTML().slice(0, 200)
);
check(
  'immediately before the table, which is the whole contract',
  /<p data-table-caption="">[^<]*<\/p>\s*<table/.test(editor.getHTML()),
  editor.getHTML().slice(0, 240)
);
check(
  'and not before the paragraph that was already there',
  editor.getHTML().indexOf('Before.') < editor.getHTML().indexOf('data-table-caption'),
  editor.getHTML().slice(0, 200)
);

/* The cursor has to land in it, or the operator presses the button and types into a cell. */
editor.commands.insertContent('Hosts in scope');
check(
  'the cursor was left inside it, so typing names the table',
  editor.getHTML().includes('>Hosts in scope</p>'),
  editor.getHTML().slice(0, 220)
);

intoTable(editor);
check('asked again, it finds the caption', tableAround(editor.state)?.captionPos !== null);
run(editor, addTableCaption);
check(
  'and adds no second one',
  (editor.getHTML().match(/data-table-caption/g) ?? []).length === 1,
  editor.getHTML().slice(0, 240)
);

console.log('\nTaking it away:');

intoTable(editor);
check('removing one reports that it did', run(editor, removeTableCaption) === true);
check('and it is gone', !editor.getHTML().includes('data-table-caption'), editor.getHTML().slice(0, 200));
check('the table is still there', editor.getHTML().includes('<table'), editor.getHTML().slice(0, 120));
check('and so is the paragraph that came before it', editor.getHTML().includes('Before.'));
intoTable(editor);
check('removing one that is not there does nothing', run(editor, removeTableCaption) === false);

const outside = makeEditor('<p>Nowhere near a table.</p>');
outside.commands.setTextSelection(2);
check('outside a table there is nothing to caption', run(outside, addTableCaption) === false);
check('and nothing to remove', run(outside, removeTableCaption) === false);

/* ------------------------------------------------------------ the reason it is a sibling --- */

console.log('\nThe table still behaves like a table:');

/** Cells per row, top to bottom — the shape `TableMap` would get wrong. */
const rowWidths = (editor) => {
  const widths = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') widths.push(node.childCount);
  });
  return widths;
};

const editing = makeEditor(`<p data-table-caption="">Named</p>${TABLE}`);
intoTable(editing);
const columnsBefore = rowWidths(editing)[0];
editing.commands.addColumnAfter();
const columnsAfter = rowWidths(editing)[0];

check(
  'a column can still be added to a captioned table',
  columnsAfter === columnsBefore + 1,
  `${columnsBefore} → ${columnsAfter}`
);
check('and the caption is untouched', editing.getHTML().includes('>Named</p>'), editing.getHTML().slice(0, 160));
check(
  'every row still has the same number of cells',
  rowWidths(editing).length > 1 && rowWidths(editing).every((n) => n === rowWidths(editing)[0]),
  `${rowWidths(editing).join(',')} — the table map is confused, which is what a caption inside the table would have done`
);

intoTable(editing);
editing.commands.addRowAfter();
check('and a row can be added too', rowWidths(editing).length === 3, `${rowWidths(editing).length} rows`);

/* ------------------------------------------------------------- column widths --- */

console.log('\nThe width somebody dragged a column to:');

/*
 * The editor has column resizing on, and ProseMirror records the result as `colwidth` on the cell
 * — a comma-separated list, one entry per column the cell spans. The converter reads exactly that
 * attribute (`npm run test:captions` proves the document end), so the whole feature rests on the
 * schema keeping it. If TipTap drops it, every check on the server still passes and every table in
 * every report goes back to an equal split.
 */
const sized = makeEditor(
  '<table><tbody>' +
    '<tr><th colwidth="400">Host</th><th colwidth="100">Port</th></tr>' +
    '<tr><td>10.0.0.5</td><td>443</td></tr>' +
    '</tbody></table>'
);
check(
  'a width already on the markup survives being loaded',
  /colwidth="400"/.test(sized.getHTML()),
  sized.getHTML().slice(0, 200)
);
check('and so does the narrow one beside it', /colwidth="100"/.test(sized.getHTML()));

/* Editing the table must not lose it — this is the attribute's whole job. */
intoTable(sized);
sized.commands.insertContent('x');
check(
  'typing in a cell leaves the widths alone',
  /colwidth="400"/.test(sized.getHTML()),
  sized.getHTML().slice(0, 200)
);

const unsized = makeEditor(TABLE);
check(
  'a table nobody resized carries no widths at all',
  !/colwidth=/.test(unsized.getHTML()),
  unsized.getHTML().slice(0, 200)
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
