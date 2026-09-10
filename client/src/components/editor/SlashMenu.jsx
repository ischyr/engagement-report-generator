import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Typing `/` offers what can go here.
 *
 * The toolbar has grown past the point where it can be read: a row of eighteen small glyphs is
 * something you learn, not something you scan, and the two most useful things in it now — a request
 * and response pair, a screenshot — are indistinguishable from the alignment buttons at a glance.
 * A keyboard path fixes both ends of that: it is faster for the people who already know, and it is
 * self-describing for everybody else, because the list says what each thing is in words.
 *
 * Deliberately hand-rolled rather than TipTap's suggestion plugin, which is not installed. The whole
 * mechanism is: notice a slash where a command could start, track what is typed after it, and
 * replace exactly that text with whatever the chosen command inserts.
 */

/**
 * A slash that opens the menu: at the start of a block, or after a space.
 *
 * What it must not match is the slash people type all day — `/etc/passwd`, `http://host/path`,
 * `and/or`. Those all have a non-space character in front, which is the whole rule. Requiring an
 * otherwise empty block was the first attempt and too strict: writing a sentence and then wanting a
 * code block is the common case, and it left the menu unreachable without pressing Enter first.
 */
const TRIGGER = /(?:^|\s)\/([a-z]*)$/i;

export default function SlashMenu({ editor, commands }) {
  const [state, setState] = useState(null);
  const [active, setActive] = useState(0);
  const stateRef = useRef(null);
  stateRef.current = state;
  const menuRef = useRef(null);
  const [placement, setPlacement] = useState(null);

  const matches = useMemo(() => {
    if (!state) return [];
    const needle = state.query.toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (command) =>
        command.id.startsWith(needle) ||
        command.label.toLowerCase().includes(needle) ||
        (command.keywords ?? []).some((word) => word.startsWith(needle))
    );
  }, [state, commands]);

  const close = useCallback(() => {
    setState(null);
    setActive(0);
    setPlacement(null);
  }, []);

  /** Removes the `/query` the user typed, then lets the command insert whatever it inserts. */
  const run = useCallback(
    (command) => {
      const current = stateRef.current;
      close();
      if (!editor || !current) return;
      editor
        .chain()
        .focus()
        .deleteRange({ from: current.from, to: current.to })
        .run();
      command.run(editor);
    },
    [editor, close]
  );

  useEffect(() => {
    if (!editor) return undefined;

    const check = () => {
      const { state: view } = editor;
      const { $from, empty } = view.selection;
      // Only a plain caret in a text block; a selection or a code block is not a menu.
      if (!empty || $from.parent.type.name !== 'paragraph') {
        if (stateRef.current) close();
        return;
      }
      // Only what is behind the caret: a slash typed in front of existing text is not a command.
      const before = $from.parent.textBetween(0, $from.parentOffset, '\n', ' ');
      const hit = TRIGGER.exec(before);
      if (!hit) {
        if (stateRef.current) close();
        return;
      }
      /*
       * The range to remove when a command runs: the slash and whatever was typed after it, and
       * nothing else. `hit[0]` can include the space that preceded the slash, hence the +1 — deleting
       * that space would join two words together every time somebody used the menu mid-sentence.
       */
      const consumed = hit[0].length - (hit[0].startsWith('/') ? 0 : 1);
      const to = $from.pos;
      const from = to - consumed;
      // The caret's box, in viewport coordinates. Which side of it the menu goes on is decided
      // after it renders, when its height is known.
      const coords = editor.view.coordsAtPos(from);
      setState({
        query: hit[1] ?? '',
        from,
        to,
        caretTop: coords.top,
        caretBottom: coords.bottom,
        left: coords.left,
      });
      setActive(0);
    };

    editor.on('selectionUpdate', check);
    editor.on('update', check);
    return () => {
      editor.off('selectionUpdate', check);
      editor.off('update', check);
    };
  }, [editor, close]);

  // Keys are taken on the document, because the caret is inside the editor while the menu is up.
  useEffect(() => {
    if (!state) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!matches.length) return;
        setActive((current) => {
          const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
          return (next + matches.length) % matches.length;
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!matches.length) return;
        event.preventDefault();
        run(matches[active]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state, matches, active, run, close]);

  /*
   * Which side of the caret it sits on, decided from its own measured height.
   *
   * Anchored below and left-aligned, it went off the bottom of the window the first time it was
   * opened from the last paragraph of a field — which is exactly where a tester is writing. So:
   * below if there is room, above if there is not, and never past the right edge.
   */
  useLayoutEffect(() => {
    if (!state) return;
    const element = menuRef.current;
    if (!element) return;
    const { offsetHeight: height, offsetWidth: width } = element;
    const margin = 6;
    const below = state.caretBottom + margin;
    const fitsBelow = below + height <= window.innerHeight - margin;
    setPlacement({
      top: fitsBelow ? below : Math.max(margin, state.caretTop - height - margin),
      left: Math.max(margin, Math.min(state.left, window.innerWidth - width - margin)),
    });
  }, [state, matches.length]);

  if (!state || matches.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Insert"
      /* Off-screen until measured, so the first paint is never in the wrong place. */
      style={placement ? { top: placement.top, left: placement.left } : { top: -9999, left: -9999 }}
      className="fixed z-50 w-72 overflow-hidden rounded-xl border border-line bg-overlay/95 shadow-2xl backdrop-blur"
    >
      <ul className="max-h-72 overflow-y-auto p-1">
        {matches.map((command, index) => {
          const Icon = command.icon;
          return (
            <li key={command.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                // The caret must stay in the document, or the insert lands nowhere.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(command)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                  index === active ? 'bg-brand-500/15' : 'hover:bg-white/5'
                }`}
              >
                {Icon ? <Icon size={15} className="mt-0.5 shrink-0 text-brand-300" /> : null}
                <span className="min-w-0">
                  <span className="block text-sm text-fg">{command.label}</span>
                  <span className="block truncate text-xs text-fg-subtle">{command.hint}</span>
                </span>
                <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-fg-subtle">
                  /{command.id}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
