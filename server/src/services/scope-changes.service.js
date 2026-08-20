/**
 * An engagement's scope changes, shaped for a report.
 *
 * A query, so it is handed to `buildReportData()` rather than read inside it — the same
 * arrangement as finding history, effort and the delivery record.
 */

import { ScopeChange, SCOPE_CHANGE_LABELS } from '../models/scope-change.model.js';

/**
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @param {(value: any) => string} formatDate how this client's reports write dates
 */
export async function scopeChangesFor(auditId, formatDate = (value) => String(value ?? '')) {
  const rows = await ScopeChange.find({ audit: auditId }).sort({ agreedOn: 1, createdAt: 1 });

  const list = rows.map((row) => ({
    kind: row.kind,
    kindLabel: SCOPE_CHANGE_LABELS[row.kind] ?? row.kind,
    /** Already formatted, like every other date a template prints. */
    date: formatDate(row.agreedOn),
    /** The raw day too, for a template that wants its own pattern. */
    agreedOn: row.agreedOn,
    summary: row.summary,
    targets: [...(row.targets ?? [])],
    /** "10.0.5.0/24, api.acme.example" — a table cell rather than a loop. */
    targetList: (row.targets ?? []).filter(Boolean).join(', '),
    agreedBy: row.agreedBy?.name ?? '',
    channel: row.channel ?? '',
    note: row.note ?? '',
  }));

  return {
    scopeChanges: list,
    recorded: list.length > 0,
    /** Counts for a sentence: "two additions and one removal were agreed during testing". */
    counts: {
      added: list.filter((row) => row.kind === 'added').length,
      removed: list.filter((row) => row.kind === 'removed').length,
      clarified: list.filter((row) => row.kind === 'clarified').length,
      total: list.length,
    },
  };
}

export default scopeChangesFor;
