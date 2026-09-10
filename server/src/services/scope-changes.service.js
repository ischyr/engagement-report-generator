/**
 * An engagement's scope changes, shaped for a report.
 *
 * A query, so it is handed to `buildReportData()` rather than read inside it — the same
 * arrangement as finding history, effort and the delivery record.
 *
 * Two shapes come out of it, because two different arguments need answering. The `scopeChanges`
 * loop is a table: what was agreed, with whom, on which day — the record. The narrative is the
 * same facts as dated prose, and it is the one that settles a dispute, because "you never tested
 * the payment sandbox" is answered by a sentence a client can read rather than by a row they have
 * to interpret.
 */

import { ScopeChange, SCOPE_CHANGE_LABELS } from '../models/scope-change.model.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** "one addition", "two additions and one removal" — the counts as something readable. */
function countSentence({ added, removed, clarified }) {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const say = (n, one, many) => `${words[n] ?? n} ${n === 1 ? one : many}`;
  const parts = [];
  if (added) parts.push(say(added, 'addition', 'additions'));
  if (removed) parts.push(say(removed, 'removal', 'removals'));
  if (clarified) parts.push(say(clarified, 'clarification', 'clarifications'));
  if (!parts.length) return '';
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${
    added + removed + clarified === 1 ? 'was' : 'were'
  } agreed with the client while testing was under way.`;
}

/**
 * Which day of the engagement a change was agreed on.
 *
 * "Day 3" is how the work is actually remembered and argued about — nobody recalls the 14th, they
 * recall that it was the morning after the kick-off. Empty when the engagement has no start date,
 * or when the change was agreed before testing began, because "day -2" reads as a mistake rather
 * than as a fact.
 */
function dayOf(agreedOn, startedOn) {
  if (!startedOn || !agreedOn) return '';
  const start = Date.parse(`${startedOn}T00:00:00Z`);
  const day = Date.parse(`${agreedOn}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(day)) return '';
  const offset = Math.round((day - start) / 86_400_000);
  return offset >= 0 ? `Day ${offset + 1}` : '';
}

/**
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @param {(value: any) => string} formatDate how this client's reports write dates
 * @param {{startedOn?: string}} [options] the engagement's first day, for "Day 3"
 */
export async function scopeChangesFor(auditId, formatDate = (value) => String(value ?? ''), options = {}) {
  const rows = await ScopeChange.find({ audit: auditId }).sort({ agreedOn: 1, createdAt: 1 });
  const startedOn = options.startedOn ?? '';

  const list = rows.map((row) => ({
    kind: row.kind,
    kindLabel: SCOPE_CHANGE_LABELS[row.kind] ?? row.kind,
    /** Already formatted, like every other date a template prints. */
    date: formatDate(row.agreedOn),
    /** The raw day too, for a template that wants its own pattern. */
    agreedOn: row.agreedOn,
    /** "Day 3", when the engagement has a start date and this was not agreed before it. */
    day: dayOf(row.agreedOn, startedOn),
    summary: row.summary,
    targets: [...(row.targets ?? [])],
    /** "10.0.5.0/24, api.acme.example" — a table cell rather than a loop. */
    targetList: (row.targets ?? []).filter(Boolean).join(', '),
    agreedBy: row.agreedBy?.name ?? '',
    channel: row.channel ?? '',
    note: row.note ?? '',
  }));

  const counts = {
    added: list.filter((row) => row.kind === 'added').length,
    removed: list.filter((row) => row.kind === 'removed').length,
    clarified: list.filter((row) => row.kind === 'clarified').length,
    total: list.length,
  };

  /*
   * The narrative.
   *
   * Assembled from the fields rather than from anybody's prose, so it says exactly what was
   * recorded and nothing more: the day, what kind of change it was, the words whoever recorded it
   * used, what it touched, and who agreed it through which channel. Anything absent is left out
   * rather than written around — a change with no named agreer reads as a change with no named
   * agreer, which is itself worth seeing before the report goes.
   */
  const paragraphs = list.map((row) => {
    const lead = [row.day, row.date].filter(Boolean).join(' — ');
    const detail = [`${row.kindLabel}: ${escapeHtml(row.summary)}`];
    if (row.targetList) detail.push(`(${escapeHtml(row.targetList)})`);

    /* Whoever wrote the summary may or may not have ended it; the sentence has to either way. */
    const said = detail.join(' ').replace(/[.;,]*$/, '');
    const agreed = row.agreedBy
      ? ` Agreed with ${escapeHtml(row.agreedBy)}${row.channel ? ` by ${escapeHtml(row.channel)}` : ''}.`
      : '';
    return `<p><strong>${escapeHtml(lead)}</strong> — ${said}.${agreed}</p>`;
  });

  const sentence = countSentence(counts);

  return {
    scopeChanges: list,
    recorded: list.length > 0,
    /** Counts for a sentence: "two additions and one removal were agreed during testing". */
    counts,
    /** That sentence, written. */
    sentence,
    /** The dated narrative, as editor-shaped HTML for `{{@rich.scopeTimeline}}`. */
    html: list.length ? `${sentence ? `<p>${escapeHtml(sentence)}</p>` : ''}${paragraphs.join('')}` : '',
  };
}

export default scopeChangesFor;
