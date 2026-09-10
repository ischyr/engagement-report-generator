/**
 * Does a TipTap editor actually bind to a shared document?
 *
 *   npm run test:collab-editor --workspace client
 *
 * `npm run test:collab-socket` proves the server: two sockets in a room converge. This proves the
 * other half, which is the half that was quietly broken — that the *editor* is bound to the shared
 * document at all. Between the two there is nowhere left for a silent failure to hide: either the
 * text crosses the wire, or it reaches the document, or it does not.
 *
 * No server and no socket here. The two documents are joined directly, so what is under test is
 * the extension wiring and nothing else.
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

const Y = await import('yjs');
const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

/** Two documents, joined the way the server joins them: every update applied to the other. */
function join(a, b) {
  a.on('update', (update, origin) => {
    if (origin === 'remote') return;
    Y.applyUpdate(b, update, 'remote');
  });
  b.on('update', (update, origin) => {
    if (origin === 'remote') return;
    Y.applyUpdate(a, update, 'remote');
  });
}

/** An editor built the way `RichTextEditor` builds one when it is collaborating. */
function makeEditor(doc) {
  const element = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      /* History off, exactly as the real one does when a document is shared. */
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: doc }),
    ],
    /* No `content`: a shared document seeds itself. This is the real component's rule. */
  });
}

console.log('An editor bound to a shared document:');

const docA = new Y.Doc();
const docB = new Y.Doc();
join(docA, docB);

const editorA = makeEditor(docA);
const editorB = makeEditor(docB);

check(
  'both editors start empty',
  editorA.getHTML() === '<p></p>' && editorB.getHTML() === '<p></p>',
  `${editorA.getHTML()} | ${editorB.getHTML()}`
);

/* The seed: one client puts the stored HTML in. */
editorA.commands.setContent('<p>The host negotiates TLS 1.0.</p>', false);
check(
  'what one editor is seeded with reaches the other',
  editorB.getHTML().includes('negotiates TLS 1.0'),
  editorB.getHTML()
);

/* And ordinary typing. */
editorB.commands.insertContentAt(editorB.state.doc.content.size - 1, ' Confirmed.');
check(
  'and what one types reaches the other',
  editorA.getHTML().includes('Confirmed.'),
  editorA.getHTML()
);
check(
  'with both ending on the same document',
  editorA.getHTML() === editorB.getHTML(),
  `${editorA.getHTML()} | ${editorB.getHTML()}`
);

/*
 * The shape the real editor keeps. A shared document that loses the app's own nodes would be a
 * different kind of disaster: figures are how evidence reaches the report.
 */
editorA.commands.setContent('', false);
editorA.commands.setContent('<p>Before</p><p>After</p>', false);
check(
  'paragraph structure survives the round trip',
  editorB.getHTML() === '<p>Before</p><p>After</p>',
  editorB.getHTML()
);

/* -------------------------------------------------------------------------- */
/* The name on somebody else's caret                                          */
/* -------------------------------------------------------------------------- */

/*
 * `CollaborationCursor` writes its own `user` into awareness when it is created, so a name set on
 * the provider beforehand is overwritten by its default of `{ name: null }` — and a caret with no
 * name renders as "User: 2343865819", the client id, at whoever is reading. The name has to be
 * given to the extension itself, and this is the check that says so.
 */
console.log('\nThe label on a remote caret:');

const { default: CollaborationCursor } = await import('@tiptap/extension-collaboration-cursor');
const { Awareness } = await import('y-protocols/awareness');

/** The smallest thing `CollaborationCursor` will accept: something with an `awareness`. */
const fakeProvider = (doc) => ({ awareness: new Awareness(doc) });

const namedDoc = new Y.Doc();
const namedProvider = fakeProvider(namedDoc);
const namedElement = dom.window.document.createElement('div');
dom.window.document.body.appendChild(namedElement);

const named = new Editor({
  element: namedElement,
  extensions: [
    StarterKit.configure({ history: false }),
    Collaboration.configure({ document: namedDoc }),
    CollaborationCursor.configure({
      provider: namedProvider,
      user: { name: 'Mario Rossi', color: '#8b5cf6' },
    }),
  ],
});

const localState = namedProvider.awareness.getLocalState();
check(
  'the account name is what the extension puts into awareness',
  localState?.user?.name === 'Mario Rossi',
  JSON.stringify(localState)
);
check(
  'and the colour with it, so the caret is not black',
  localState?.user?.color === '#8b5cf6',
  JSON.stringify(localState?.user)
);
check(
  'nothing is left for y-prosemirror to fall back to a client id for',
  localState?.user?.name !== null && localState?.user?.name !== undefined,
  JSON.stringify(localState?.user)
);

named.destroy();

/* -------------------------------------------------------------------------- */
/* A single-line box, which has no document of its own                        */
/* -------------------------------------------------------------------------- */

/*
 * A title or a command is a plain `<input>`: it hands over the whole new value and nothing about
 * what changed. `textDelta` works out the changed middle so a keystroke is one insertion rather
 * than a wholesale replacement — because replacing the text deletes and reinserts every character,
 * which is exactly what a CRDT is there to avoid. Two people typing at either end of a title would
 * each wipe the other's letter.
 */
console.log('\nWorking out what changed in a plain box:');

const { textDelta } = await import('../src/lib/text-delta.js');

const cases = [
  ['nothing changed', 'nmap -sV', 'nmap -sV', null],
  ['a character typed at the end', 'nmap', 'nmap ', { at: 4, remove: 0, insert: ' ' }],
  ['a character typed at the front', 'map', 'nmap', { at: 0, remove: 0, insert: 'n' }],
  ['typing in the middle', 'nmap acme', 'nmap -sV acme', { at: 5, remove: 0, insert: '-sV ' }],
  ['a backspace', 'nmap ', 'nmap', { at: 4, remove: 1, insert: '' }],
  ['a selection replaced', 'nmap -sV acme', 'nmap -sC acme', { at: 7, remove: 1, insert: 'C' }],
  ['everything cleared', 'nmap', '', { at: 0, remove: 4, insert: '' }],
  ['filled from empty', '', 'nmap', { at: 0, remove: 0, insert: 'nmap' }],
  /* The one a prefix walk and a suffix walk will double-count if they are allowed to overlap. */
  ['a repeated character', 'aa', 'aaa', { at: 2, remove: 0, insert: 'a' }],
  ['a repeated character removed', 'aaa', 'aa', { at: 2, remove: 1, insert: '' }],
];

for (const [label, before, after, expected] of cases) {
  const got = textDelta(before, after);
  check(
    label,
    JSON.stringify(got) === JSON.stringify(expected),
    `${JSON.stringify(got)} for ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
  );
}

/* And the property that matters more than any single case: applying it reproduces the box. */
const apply = (before, delta) => {
  if (!delta) return before;
  return before.slice(0, delta.at) + delta.insert + before.slice(delta.at + delta.remove);
};

const pairs = [
  ['portal.example', 'portal.northwind.example'],
  ['/documents/{id}/download', '/documents/{id}/downloadasdasd'],
  ['Reflected Cross Site Scripting', 'Reflected XSS'],
  ['', 'a'],
  ['abc', 'abc'],
  ['aaaa', 'aa'],
  ['one two three', 'one three'],
];
check(
  'applying the delta always reproduces exactly what the box says',
  pairs.every(([before, after]) => apply(before, textDelta(before, after)) === after),
  JSON.stringify(
    pairs.filter(([before, after]) => apply(before, textDelta(before, after)) !== after)
  )
);

/* Bound to a real Y.Text, two boxes converge the way two editors do. */
const titleA = new Y.Doc();
const titleB = new Y.Doc();
join(titleA, titleB);
const sharedA = titleA.getText('text');
const sharedB = titleB.getText('text');

sharedA.insert(0, 'Reflected Cross Site Scripting');
check(
  'a title seeded on one side arrives on the other',
  sharedB.toString() === 'Reflected Cross Site Scripting',
  sharedB.toString()
);

/* Each side edits a different end, in one transaction each, as the component does. */
const editA = textDelta(sharedA.toString(), 'Reflected Cross-Site Scripting');
titleA.transact(() => {
  if (editA.remove) sharedA.delete(editA.at, editA.remove);
  if (editA.insert) sharedA.insert(editA.at, editA.insert);
});
const editB = textDelta(sharedB.toString(), `${sharedB.toString()} (XSS)`);
titleB.transact(() => {
  if (editB.remove) sharedB.delete(editB.at, editB.remove);
  if (editB.insert) sharedB.insert(editB.at, editB.insert);
});

check(
  'two people editing either end of a title keep both edits',
  sharedA.toString() === sharedB.toString() &&
    sharedA.toString().includes('Cross-Site') &&
    sharedA.toString().includes('(XSS)'),
  `${sharedA.toString()} | ${sharedB.toString()}`
);

editorA.destroy();
editorB.destroy();

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
