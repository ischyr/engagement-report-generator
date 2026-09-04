/**
 * Checks what counts as "save" and what does not.
 *
 *   npm run test:keys
 *
 * A keyboard binding is a small thing that is easy to get subtly wrong in a way nobody notices
 * until it fires on the wrong keystroke — ⇧⌘S meaning "save as" in every other editor, a held key
 * queueing forty network writes, an IME committing a character mid-composition. Each of those is a
 * line in `isSaveShortcut`, so each is a line here.
 */
import { createServer } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});

const { isSaveShortcut, saveShortcutLabel, listKey, isTyping } = await vite.ssrLoadModule(
  '/src/lib/keys.js'
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

/** A keydown, with everything off unless it is named. */
const key = (over = {}) => ({
  key: 's',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...over,
});

console.log('What saves:');
check('⌘S saves', isSaveShortcut(key({ metaKey: true })));
check('Ctrl+S saves', isSaveShortcut(key({ ctrlKey: true })));
check('and a capital S, from caps lock, still saves', isSaveShortcut(key({ metaKey: true, key: 'S' })));

console.log('\nWhat does not:');
check('a bare S is a letter somebody is typing', !isSaveShortcut(key()));
check(
  '⇧⌘S is "save as" everywhere else, so it is left alone',
  !isSaveShortcut(key({ metaKey: true, shiftKey: true }))
);
check('Alt is how some layouts type a character', !isSaveShortcut(key({ ctrlKey: true, altKey: true })));
check(
  'both modifiers at once is somebody else’s binding',
  !isSaveShortcut(key({ metaKey: true, ctrlKey: true }))
);
check(
  'a held key does not queue a second write',
  !isSaveShortcut(key({ metaKey: true, repeat: true })),
  'a repeat was treated as a fresh press'
);
check(
  'a keystroke mid-composition belongs to the IME',
  !isSaveShortcut(key({ metaKey: true, isComposing: true }))
);
check('another letter is not save', !isSaveShortcut(key({ metaKey: true, key: 'd' })));
check('and neither is nothing at all', !isSaveShortcut(null) && !isSaveShortcut(undefined));

console.log('\nWhat it is called:');
check(
  'the hint reads as the keyboard in front of you',
  ['⌘S', 'Ctrl+S'].includes(saveShortcutLabel()),
  saveShortcutLabel()
);

console.log('\nWalking a list:');

/** A keydown on something that is not a field, unless one is described. */
const listEvent = (over = {}) => ({
  key: 'j',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  target: { closest: () => null, isContentEditable: false },
  ...over,
});

check('j and the down arrow both move on', listKey(listEvent()) === 'next' && listKey(listEvent({ key: 'ArrowDown' })) === 'next');
check('k and the up arrow both move back', listKey(listEvent({ key: 'k' })) === 'previous' && listKey(listEvent({ key: 'ArrowUp' })) === 'previous');
check('Enter and o open', listKey(listEvent({ key: 'Enter' })) === 'open' && listKey(listEvent({ key: 'o' })) === 'open');
check('e opens it to be written', listKey(listEvent({ key: 'e' })) === 'edit');
check('Escape puts the cursor away', listKey(listEvent({ key: 'Escape' })) === 'clear');
check('anything else means nothing', listKey(listEvent({ key: 'x' })) === null);

/*
 * The whole difference between a list shortcut and a bug: `j` is a letter for most of the
 * time anybody spends in this app.
 */
const inField = { closest: (sel) => (/input|textarea|contenteditable|dialog/.test(sel) ? {} : null), isContentEditable: false };
check('a keystroke in a field is left to the field', listKey(listEvent({ target: inField })) === null);
check('and so is one in a rich-text editor', listKey(listEvent({ target: { closest: () => null, isContentEditable: true } })) === null);
check('and one inside a dialog over the list', isTyping(inField) === true);
check('⌘K stays the search palette', listKey(listEvent({ key: 'k', metaKey: true })) === null);
check('a composed character is the IME’s', listKey(listEvent({ isComposing: true })) === null);

await vite.close();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
