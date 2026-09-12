import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';

import { isTyping, saveShortcutLabel } from '../../lib/keys.js';
import { Modal } from '../ui/Modal.jsx';

/**
 * What the keyboard does, on `?`.
 *
 * The app is full of bindings and told nobody about any of them. ⌘S saves whatever editor is
 * dirty, `Ctrl+K` opens the search, `j`/`k` walk the findings list, `e` opens one straight into
 * the editor, shift-click takes a run of them — and the only way to find that out was to read
 * `lib/keys.js`. Which means the keyboard work was, for most people, decoration.
 *
 * `?` because it is what every application with shortcuts uses, and because it costs nothing: it
 * needs shift on every layout, so it cannot be typed by accident while navigating.
 *
 * **The list is written out rather than derived**, and that is a deliberate limit. `listKey` could
 * be read for its cases, but a keystroke's *meaning* is not in the predicate — "e opens it and
 * puts the cursor in the first field" is a sentence about the findings tab, not about
 * `case 'e': return 'edit'`. A generated sheet would be accurate and useless. The cost is that
 * this file has to be edited when a binding is, and `test:keys` asserts the two agree.
 */

/** Written as the machine reading it types them: ⌘ on a Mac, Ctrl everywhere else. */
const GROUPS = () => [
  {
    title: 'Anywhere',
    keys: [
      [['Ctrl', 'K'], 'Search everything — engagements, findings, notes, clients'],
      [[saveShortcutLabel()], 'Save whatever is open and unsaved'],
      [['?'], 'This list'],
      [['Esc'], 'Close a dialog, or put the list cursor away'],
    ],
  },
  {
    title: 'Walking a list',
    subtitle: 'On the findings list. Not while the cursor is in a field.',
    keys: [
      [['j'], 'Down one'],
      [['k'], 'Up one'],
      [['↓'], 'Down one, for the other camp'],
      [['↑'], 'Up one'],
      [['Enter'], 'Open the one under the cursor'],
      [['o'], 'Open it — the same thing, nearer the other keys'],
      [['e'], 'Open it to write'],
    ],
  },
  {
    title: 'Choosing several',
    keys: [
      [['Click'], 'Tick one finding'],
      [['Shift', 'Click'], 'Tick everything between this one and the last'],
    ],
  },
  {
    title: 'While writing',
    keys: [
      [['/'], 'At the start of a line: headings, lists, code, a table'],
      [[saveShortcutLabel()], 'Save without reaching for the button'],
    ],
  },
];

/** One key, drawn as a key. */
function Key({ children }) {
  return (
    <kbd className="rounded border border-line-soft bg-canvas/70 px-1.5 py-0.5 font-mono text-[0.6875rem] text-fg shadow-[0_1px_0_0_var(--color-line-soft)]">
      {children}
    </kbd>
  );
}

export default function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      /*
       * Not while somebody is typing — including inside a dialog, which `isTyping` covers, so
       * asking a question mark of a note does not open this over the note.
       */
      if (isTyping(event.target)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const groups = GROUPS();

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      description="Press ? anywhere to bring this back."
      size="lg"
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title} className="flex flex-col gap-2">
            <header>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Keyboard size={13} className="text-fg-subtle" />
                {group.title}
              </h3>
              {group.subtitle ? (
                <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">{group.subtitle}</p>
              ) : null}
            </header>
            <ul className="flex flex-col gap-1.5">
              {group.keys.map(([keys, what]) => (
                <li key={keys.join('+')} className="flex items-baseline gap-2.5 text-xs">
                  <span className="flex shrink-0 items-center gap-1">
                    {keys.map((key, index) => (
                      <span key={key} className="flex items-center gap-1">
                        {index > 0 ? <span className="text-fg-subtle">+</span> : null}
                        <Key>{key}</Key>
                      </span>
                    ))}
                  </span>
                  <span className="text-fg-muted">{what}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
