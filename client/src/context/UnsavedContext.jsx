import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from '../components/ui/Modal.jsx';
import { isSaveShortcut } from '../lib/keys.js';

const UnsavedContext = createContext(null);

/**
 * Knows whether anything on screen has unsaved work, and asks before it is thrown away.
 *
 * Findings, notes, sections and the scope form all tracked a `dirty` flag and none of
 * them did anything with it: switching tabs, pressing back or closing the window
 * discarded a half-written finding without a word. Only the HTML template editor
 * guarded itself, which is how the gap was found.
 *
 * Two halves, because a browser and a single-page app lose work differently:
 *
 * - `beforeunload` covers closing the tab and reloading. The browser shows its own
 *   dialog and will not let us word it.
 * - In-app navigation is ours to intercept, so `guard(action)` runs the action, or asks
 *   first if something is dirty. That is a real dialog with the editor's own wording.
 *
 * `useBlocker` would do the second half for us, but it needs a data router and this app
 * uses `<BrowserRouter>`. Wrapping the handful of places that navigate away from an
 * editor is a smaller change than converting the router, and it puts the question where
 * the answer is known — "discard this finding?" rather than "leave the page?".
 *
 * **And ⌘S, for the same registry.** Whatever knows it has unsaved work also knows how to save it,
 * so a screen that already declares the first gets the second by handing over its `save`. That is
 * why the binding lives here rather than in a hook each editor wires up separately: the set of
 * things ⌘S can save is exactly the set of things that can be dirty, by construction, and it cannot
 * drift when somebody adds a seventh editor.
 *
 * Pressing it saves *everything* currently dirty rather than guessing at one. Two editors are
 * rarely open at once, and when they are, "save my work" is unambiguous in a way that any priority
 * rule would not be.
 */
export function UnsavedProvider({ children }) {
  /** id → { label, saver } for everything currently holding unsaved work. */
  const dirtyRef = useRef(new Map());
  const [pending, setPending] = useState(null);
  const [savingAll, setSavingAll] = useState(false);

  /**
   * `saver` is a ref rather than a function.
   *
   * An editor's `save` is a new closure on every render — it has to be, since it reads the draft —
   * so a copy taken when the component became dirty would be saving a version of the text from
   * whenever that was. The ref is written on every render by the hook below; the map holds the box,
   * not the value.
   */
  const register = useCallback((id, label, saver = null) => {
    dirtyRef.current.set(id, { label, saver });
    return () => dirtyRef.current.delete(id);
  }, []);

  const clear = useCallback((id) => {
    dirtyRef.current.delete(id);
  }, []);

  /**
   * Saves everything that is dirty and knows how.
   *
   * Nothing here reports success: each editor already shows its own saved state and raises its own
   * toast on failure, and a second announcement from the shortcut would be one more thing on screen
   * saying what the button beside it already says.
   */
  const saveAll = useCallback(async () => {
    const savers = [...dirtyRef.current.values()]
      .map((entry) => entry.saver?.current)
      .filter((fn) => typeof fn === 'function');
    if (!savers.length) return false;

    setSavingAll(true);
    try {
      /* Sequential: two editors saving at once against the same engagement is a stale write. */
      for (const save of savers) {
        try {
          await save();
        } catch {
          /* The editor owns its own error reporting; one failure must not stop the others. */
        }
      }
    } finally {
      setSavingAll(false);
    }
    return true;
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!isSaveShortcut(event)) return;
      /*
       * The browser's own Save-page dialog is suppressed only when there is something of ours to
       * save. On a screen with nothing dirty the keystroke is left alone rather than swallowed,
       * because silently doing nothing is worse than doing what the browser was always going to.
       */
      const hasWork = [...dirtyRef.current.values()].some(
        (entry) => typeof entry.saver?.current === 'function'
      );
      if (!hasWork) return;
      event.preventDefault();
      void saveAll();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveAll]);

  useEffect(() => {
    const warn = (event) => {
      if (dirtyRef.current.size === 0) return undefined;
      event.preventDefault();
      // Ignored by every current browser, which shows its own text — but required for
      // the dialog to appear at all.
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const value = useMemo(
    () => ({
      register,
      clear,
      saveAll,
      /** Whether a ⌘S is in flight, for anything that wants to show it. */
      savingAll,
      isDirty: () => dirtyRef.current.size > 0,
      /**
       * Runs `action`, or asks first when something is unsaved.
       *
       * The action is remembered rather than run optimistically, so declining the
       * question leaves everything exactly where it was.
       */
      guard: (action) => {
        const labels = [...dirtyRef.current.values()].map((entry) => entry.label).filter(Boolean);
        if (labels.length === 0) {
          action();
          return;
        }
        setPending({ action, labels });
      },
    }),
    [register, clear, saveAll, savingAll]
  );

  const describe = (labels) => {
    if (labels.length === 1) return `${labels[0]} has unsaved changes.`;
    return `${labels.join(', ')} have unsaved changes.`;
  };

  return (
    <UnsavedContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={Boolean(pending)}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const action = pending?.action;
          // Cleared first: whatever is dirty is about to be unmounted, and leaving it
          // registered would make the next navigation ask about work that is gone.
          dirtyRef.current.clear();
          setPending(null);
          action?.();
        }}
        title="Discard unsaved changes?"
        message={`${describe(pending?.labels ?? [])} Leaving now throws them away.`}
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
      />
    </UnsavedContext.Provider>
  );
}

/**
 * Declares that this component is holding unsaved work, and optionally how to save it.
 *
 * Passing `save` is what puts this editor behind ⌘S. It is optional so that a screen which tracks
 * dirtiness but has no single save — a form with three independent buttons, say — can still declare
 * the work without claiming a keystroke it cannot honour.
 *
 * @param {boolean} dirty
 * @param {string} label how to name it in the question, e.g. 'This finding'
 * @param {() => any} [save] called on ⌘S; may be async, and may throw — the editor reports its own
 *   failures, so nothing here does
 */
export function useUnsavedWork(dirty, label, save) {
  const context = useContext(UnsavedContext);
  const id = useRef(Symbol('unsaved'));
  /* Rewritten every render, so ⌘S always saves the text that is on screen now. */
  const saver = useRef(save);
  saver.current = save;

  useEffect(() => {
    if (!context) return undefined;
    if (!dirty) {
      context.clear(id.current);
      return undefined;
    }
    return context.register(id.current, label, saver);
  }, [context, dirty, label]);

  // Unmounting cannot mean "still dirty": the editor is gone, either saved or already
  // asked about.
  useEffect(() => {
    const key = id.current;
    return () => context?.clear(key);
  }, [context]);
}

/** `guard(fn)` for anything that navigates away from an editor. */
export function useUnsaved() {
  return (
    useContext(UnsavedContext) ?? {
      register: () => () => {},
      clear: () => {},
      saveAll: async () => false,
      savingAll: false,
      isDirty: () => false,
      guard: (action) => action(),
    }
  );
}

export default UnsavedContext;
