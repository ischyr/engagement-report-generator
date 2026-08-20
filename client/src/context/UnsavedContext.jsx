import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from '../components/ui/Modal.jsx';

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
 */
export function UnsavedProvider({ children }) {
  /** id → label of everything currently holding unsaved work. */
  const dirtyRef = useRef(new Map());
  const [pending, setPending] = useState(null);

  const register = useCallback((id, label) => {
    dirtyRef.current.set(id, label);
    return () => dirtyRef.current.delete(id);
  }, []);

  const clear = useCallback((id) => {
    dirtyRef.current.delete(id);
  }, []);

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
      isDirty: () => dirtyRef.current.size > 0,
      /**
       * Runs `action`, or asks first when something is unsaved.
       *
       * The action is remembered rather than run optimistically, so declining the
       * question leaves everything exactly where it was.
       */
      guard: (action) => {
        const labels = [...dirtyRef.current.values()].filter(Boolean);
        if (labels.length === 0) {
          action();
          return;
        }
        setPending({ action, labels });
      },
    }),
    [register, clear]
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
 * Declares that this component is holding unsaved work.
 *
 * @param {boolean} dirty
 * @param {string} label how to name it in the question, e.g. 'This finding'
 */
export function useUnsavedWork(dirty, label) {
  const context = useContext(UnsavedContext);
  const id = useRef(Symbol('unsaved'));

  useEffect(() => {
    if (!context) return undefined;
    if (!dirty) {
      context.clear(id.current);
      return undefined;
    }
    return context.register(id.current, label);
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
      isDirty: () => false,
      guard: (action) => action(),
    }
  );
}

export default UnsavedContext;
