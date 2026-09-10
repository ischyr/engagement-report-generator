/**
 * Notes against lines of tool output.
 *
 * The problem this file exists for: a note is anchored to line 187, and then the sweep is run again
 * and pasted over. Line 187 is now a different host. A note that quietly moves to point at something
 * else is worse than no note at all — it puts a sentence somebody wrote about one host underneath
 * another one, in a document that goes to a client.
 *
 * So a note carries both the number and the text of the line it was made against, and reading it
 * back is a reconciliation rather than a lookup:
 *
 *   - the line is still there, at the same number  → `ok`
 *   - the text is there at a different number      → `moved`, and the new number is used
 *   - the text is gone                             → `stale`, and it is said out loud
 *
 * Stale notes are kept, not dropped. "This host no longer appears in the sweep" is frequently the
 * most interesting thing on the page during a retest, and deleting the note would destroy exactly
 * that signal.
 */

const linesOf = (output) =>
  String(output ?? '')
    .replace(/\s+$/, '')
    .split(/\r?\n/);

/** How a line is compared: trailing whitespace is noise, and re-runs differ by it constantly. */
const norm = (value) => String(value ?? '').trimEnd();

/**
 * Resolves a step's notes against the output as it stands now.
 *
 * @param {string} output the current output
 * @param {Array}  notes  the stored notes
 * @returns {Array} notes with `line` resolved, sorted by where they now sit, each carrying
 *   `moved`/`stale` so the reader can be told rather than guessing
 */
export function resolveOutputNotes(output, notes) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return [];

  const lines = linesOf(output).map(norm);
  /*
   * First occurrence of each line, built once.
   *
   * A sweep of four thousand hosts times a dozen notes is twelve full scans done naively, and this
   * runs on every read of the step. First occurrence rather than all of them: duplicate lines in
   * tool output are near-always genuinely the same fact repeated.
   */
  const byText = new Map();
  lines.forEach((text, index) => {
    if (text && !byText.has(text)) byText.set(text, index + 1);
  });

  return list
    .map((note) => {
      const raw = typeof note.toObject === 'function' ? note.toObject() : note;
      const snippet = norm(raw.snippet);
      const at = Number(raw.line) || 0;
      const here = norm(lines[at - 1]);

      /*
       * `wasMoved` is the stored flag, and it is ORed with what this read finds.
       *
       * The stored one is the usual source now: notes are re-anchored when the output is written, so
       * a read afterwards sees a note that agrees with its line and would otherwise report nothing.
       * The live comparison still matters for output that changed by some other route — a migration,
       * a restored backup — where the flag was never set.
       */
      const wasMoved = Boolean(raw.moved);

      /* Nothing to reconcile against: a note made before snippets, or on empty output. */
      if (!snippet) {
        return {
          ...raw,
          line: at,
          snippet: here,
          moved: wasMoved,
          stale: at < 1 || at > lines.length,
        };
      }
      if (here === snippet) return { ...raw, line: at, snippet, moved: wasMoved, stale: false };

      const found = byText.get(snippet);
      if (found) return { ...raw, line: found, snippet, moved: true, stale: false };
      return { ...raw, line: at, snippet, moved: wasMoved, stale: true };
    })
    /* Reading order, so the notes list runs down the output the way the eye does. */
    .sort((a, b) => a.line - b.line || String(a._id ?? '').localeCompare(String(b._id ?? '')));
}

/** The text of a line, for storing beside a new note. 1-based, to match what the pane shows. */
export function lineAt(output, line) {
  return norm(linesOf(output)[Number(line) - 1] ?? '');
}

/** How many lines the output has — the ceiling a new note has to sit under. */
export function lineCount(output) {
  const text = String(output ?? '').replace(/\s+$/, '');
  return text ? linesOf(text).length : 0;
}

export default resolveOutputNotes;
