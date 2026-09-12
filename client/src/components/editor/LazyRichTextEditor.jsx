import { Suspense, lazy } from 'react';

import { cn } from '../../lib/utils.js';

/**
 * The rich text editor, fetched when something actually renders one.
 *
 * `RichTextEditor.jsx` pulls in TipTap and ProseMirror, which is **144 kB gzipped** — the second
 * largest asset the application has, after the entry chunk. Every tab that writes prose imported it
 * directly, and one of those is `FindingsTab`, which `EngagementEditorPage` imports statically. So
 * the whole editor arrived with the engagement page: opening a job to look at its scope, its hours
 * or its delivery register downloaded ProseMirror first.
 *
 * `test:chunks` already holds the editor out of the *entry* chunk and always did — signing in has
 * never paid for it. This is the next door along, and nothing was watching it.
 *
 * A `lazy()` created once at module scope, so the import is requested the first time one of these
 * is rendered and never again. Opening the Findings tab still costs nothing; the list renders no
 * editors. Opening a finding is what pays, which is the person who was going to write something.
 *
 * Deliberately not the other design — static HTML swapped for an editor on focus. That one saves
 * the *mount*, which is a different cost with different risks (a caret that lands in the wrong
 * place, a paste into a div). This saves the *download*, changes no behaviour at all, and the two
 * are independent if the mount ever turns out to be worth chasing.
 */

const Editor = lazy(() =>
  import('./RichTextEditor.jsx').then((module) => ({ default: module.RichTextEditor }))
);

/**
 * What stands there for the few hundred milliseconds of the first load.
 *
 * Sized from the same `minHeight` the editor will take, so the form does not jump when it arrives —
 * a field that grows by 180px under the cursor is worse than one that took a moment to appear. The
 * border and radius match the real thing for the same reason.
 */
function Placeholder({ minHeight = 180, className }) {
  return (
    <div
      style={{ minHeight }}
      aria-busy="true"
      className={cn(
        'flex items-end rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5',
        className
      )}
    >
      <span className="text-xs text-fg-subtle">Loading the editor…</span>
    </div>
  );
}

/**
 * Drop-in for the real one: every prop is forwarded untouched.
 *
 * Same name as what it replaces, so the call sites changed their import path and nothing else.
 */
export function RichTextEditor(props) {
  return (
    <Suspense fallback={<Placeholder minHeight={props.minHeight} className={props.className} />}>
      <Editor {...props} />
    </Suspense>
  );
}

export default RichTextEditor;
