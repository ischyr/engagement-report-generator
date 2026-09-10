/**
 * Telling the author what their `@handle` actually did.
 *
 * A misspelled handle reaches nobody, and looks exactly like one that worked — so
 * every place that accepts a mention says who was notified and which names matched
 * no account, while the author is still looking at the text.
 *
 * Comments answer with `mentioned`/`unknownMentions` at the top level; notes,
 * sections and checks answer with `_mentions`, prefixed because it is not part of
 * the document being saved. Both shapes land here.
 */
export function announceMentions(toast, result) {
  const notified = result?._mentions?.notified ?? result?.mentioned ?? [];
  const unknown = result?._mentions?.unknown ?? result?.unknownMentions ?? [];

  const list = (names) => names.map((name) => `@${name}`).join(', ');

  if (notified.length) {
    toast.success(`Notified ${list(notified)}`, 'They will see it in their notifications.');
  }
  if (unknown.length) {
    toast.warning(`No account matches ${list(unknown)}`, 'That mention did not notify anyone.');
  }
  return { notified, unknown };
}

export default announceMentions;
