/**
 * Keyboard bindings, as plain predicates over an event.
 *
 * Separated from the components that listen so the rules can be asserted without a browser, and so
 * that "what does ⌘S mean here" has one answer rather than one per screen.
 */

/** Mac writes ⌘S; everywhere else writes Ctrl+S. Both are shown as they are typed locally. */
export const onApple = () =>
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');

/** "⌘S" or "Ctrl+S", for a tooltip that tells the truth on the machine reading it. */
export const saveShortcutLabel = () => (onApple() ? '⌘S' : 'Ctrl+S');

/**
 * Whether this keystroke means "save".
 *
 * Deliberately narrow. `Shift` is excluded because ⇧⌘S is "save as" in most editors and pressing it
 * here should not quietly do something else; `Alt` because it is how several keyboard layouts type
 * an ordinary character. A repeat from a held key is ignored — the save is a network write, and
 * holding the key down should not queue forty of them.
 *
 * @param {KeyboardEvent} event
 */
export function isSaveShortcut(event) {
  if (!event || event.repeat || event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  /* One modifier or the other, not neither and not both. */
  if (Boolean(event.metaKey) === Boolean(event.ctrlKey)) return false;
  return String(event.key ?? '').toLowerCase() === 's';
}

/**
 * Whether the keystroke is somebody typing rather than somebody navigating.
 *
 * The whole difference between a list shortcut and a bug. `j` is a letter for most of the time
 * anybody spends in this app, so a binding on it has to be certain that the focus is not in a
 * field — including a rich-text editor, which is a contenteditable div rather than an input, and
 * including one inside a dialog that happens to be over the list.
 */
export function isTyping(target) {
  const node = target;
  if (!node || typeof node.closest !== 'function') return false;
  if (node.isContentEditable) return true;
  return Boolean(node.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'));
}

/**
 * What a keystroke means to a list, or null if it means nothing.
 *
 * Vim's `j`/`k` and the arrows both, because both camps exist and the cost of supporting the
 * second one is two lines. Modifiers disqualify everything: ⌘K is the search palette, and a list
 * that swallowed it would be a list somebody has to click out of first.
 */
export function listKey(event) {
  if (!event || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return null;
  if (isTyping(event.target)) return null;
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
    case 'o':
      return 'open';
    case 'e':
      return 'edit';
    case 'Escape':
      return 'clear';
    default:
      return null;
  }
}

export default { isSaveShortcut, saveShortcutLabel, onApple, listKey, isTyping };
