/**
 * The two things any caller must do before writing to an engagement.
 *
 * Extracted from `audits.routes.js` when `/api/v1` arrived and needed the same two answers. Both
 * are the kind of rule that must have exactly one implementation:
 *
 *   - `assertEditable` is the freeze. An approved engagement is a delivered engagement, and a
 *     second copy of this check would eventually be a route that lets a script edit a report
 *     somebody has already signed.
 *   - `nextIdentifier` is the number the report prints as VULN-03. Its subtlety is written up
 *     below, and reimplementing it is how you get two findings numbered VULN-04 in one document.
 */
import { DeletedFinding } from '../models/deleted-finding.model.js';
import { forbidden } from '../utils/http-error.js';

/**
 * The next free finding number for an engagement.
 *
 * Numbers held by restorable findings are not free either. Deleting the highest-numbered finding
 * used to release its number to the next one written, and restoring it then brought the original
 * back carrying the same identifier — two findings printed as VULN-04 in one report, and a
 * delivery record hashing a document with a duplicate reference in it. The trash is part of the
 * engagement until it expires, so its numbers stay reserved for as long as they can come back.
 */
export async function nextIdentifier(audit) {
  const used = (audit.findings ?? [])
    .map((finding) => finding.identifier)
    .filter((value) => Number.isFinite(value));

  const trashed = await DeletedFinding.find({ audit: audit._id })
    .select('finding.identifier')
    .lean();
  for (const row of trashed) {
    const value = row.finding?.identifier;
    if (Number.isFinite(value)) used.push(value);
  }

  return (used.length ? Math.max(...used) : 0) + 1;
}

/** APPROVED engagements are frozen; only an admin can reopen them. */
export function assertEditable(audit, user) {
  if (audit.state === 'APPROVED' && user.role !== 'admin') {
    throw forbidden('This engagement is approved and locked. Ask an admin to reopen it.');
  }
  if (user.role === 'readonly') throw forbidden('Your account is read-only');
}
