/**
 * Turning "the box now says this" into the smallest edit that gets there.
 *
 * A `<input>` hands you the whole new value and nothing about what changed. A shared document needs
 * the change, not the result: replacing the entire text on every keystroke would delete and
 * reinsert everybody's characters, which throws away the one thing a CRDT is for. Two people typing
 * at either end of a title would each wipe the other's letter, and the loser would be whoever's
 * keystroke landed second.
 *
 * So the common prefix and suffix are found and only the middle is replaced. That is not a general
 * diff and does not try to be: a single edit to a single-line box is one insertion, one deletion,
 * or one replacement of a selected run, and all three are exactly a changed middle. Anything more
 * clever would be more code to be wrong in for a case that does not arise.
 *
 * Pure, and in `lib` rather than beside the hook, because this is the part with consequences and a
 * test should not need a browser to reach it.
 */

/**
 * @param {string} before what the shared text says now
 * @param {string} after what the box says now
 * @returns {{at: number, remove: number, insert: string}|null} null when they already agree
 */
export function textDelta(before, after) {
  const was = String(before ?? '');
  const now = String(after ?? '');
  if (was === now) return null;

  /* How much of the front is untouched. */
  let start = 0;
  const shortest = Math.min(was.length, now.length);
  while (start < shortest && was[start] === now[start]) start += 1;

  /*
   * And the back, without letting the two walks overlap.
   *
   * The bound matters: for "aa" becoming "aaa" the prefix walk consumes both characters, and a
   * suffix walk that ignored it would count them again and produce a negative-length middle.
   */
  let end = 0;
  while (end < shortest - start && was[was.length - 1 - end] === now[now.length - 1 - end]) {
    end += 1;
  }

  return {
    at: start,
    remove: was.length - start - end,
    insert: now.slice(start, now.length - end),
  };
}

export default textDelta;
