/**
 * What is still pointing at a thing somebody wants to delete.
 *
 * One place, because a client and a contact can each be deleted from two doors — the Sales
 * section and Clients & Data — and two rules would mean one door quietly allowing what the
 * other refuses. Until this existed the Data page took the looser view of the two: a
 * `findOneAndDelete` with no check at all, which left engagements pointing at a company that
 * no longer exists and a report cover page with a blank client name on it.
 *
 * Refusing and naming the blockers, rather than cascading. A cascade here would delete an
 * engagement because somebody tidied up a duplicate client, and the engagement is the valuable
 * thing in this app. Naming them means the person can decide: the ones that matter get kept,
 * the mistyped record gets its contact removed first and then goes.
 */

import { Audit } from '../models/audit.model.js';
import { Client } from '../models/client.model.js';
import { Company } from '../models/company.model.js';
import { Intake } from '../models/intake.model.js';
import { Proposal } from '../models/proposal.model.js';
import { badRequest } from '../utils/http-error.js';

/** `{ what, count }` for each thing standing in the way, or an empty list. */
export async function companyBlockers(companyId) {
  const [engagements, proposals, contacts, questionnaires] = await Promise.all([
    // Trashed engagements count: they can be restored, and a restore onto a missing client
    // is a broken engagement rather than a recovered one.
    Audit.countDocuments({ company: companyId }),
    Proposal.countDocuments({ company: companyId }),
    Client.countDocuments({ company: companyId }),
    Intake.countDocuments({ company: companyId }),
  ]);

  return [
    { one: 'engagement', many: 'engagements', count: engagements },
    { one: 'proposal', many: 'proposals', count: proposals },
    { one: 'contact', many: 'contacts', count: contacts },
    { one: 'questionnaire', many: 'questionnaires', count: questionnaires },
  ].filter((row) => row.count > 0);
}

export async function contactBlockers(contactId) {
  const [primary, recipient, proposals] = await Promise.all([
    Audit.countDocuments({ client: contactId }),
    // Named on the distribution list or in a recipient role, which is what a report's
    // "prepared for" line reads from.
    Audit.countDocuments({
      $or: [{ recipients: contactId }, { 'recipientRoles.client': contactId }],
    }),
    Proposal.countDocuments({ contacts: contactId }),
    /*
     * A recorded delivery is deliberately *not* here.
     *
     * It was, and that was a dead end: a delivery is never removed — it is the evidence that a
     * report went to somebody on a date — so a contact who had ever received one could never be
     * deleted, under an instruction ("remove them from those first") that could only be followed
     * by destroying a compliance record.
     *
     * And it was unnecessary. A delivery stores the recipient's name and address as a snapshot
     * precisely so that the record survives the contact being renamed, moved or deleted — the
     * model says so in its own header. The reference alongside it is a convenience link, and a
     * link that stops resolving costs nothing here.
     */
  ]);

  return [
    { one: 'engagement', many: 'engagements', count: primary },
    { one: 'distribution list', many: 'distribution lists', count: recipient },
    { one: 'proposal', many: 'proposals', count: proposals },
  ].filter((row) => row.count > 0);
}

/**
 * "2 engagements and 1 proposal" — for a refusal somebody can act on.
 *
 * Both plural forms carried on each row rather than derived, because deriving them means
 * guessing, and the guess gets "distribution lists" right and "recorded deliverys" wrong.
 */
export function describeBlockers(blockers) {
  const parts = blockers.map((row) => `${row.count} ${row.count === 1 ? row.one : row.many}`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Throws unless nothing points at it.
 *
 * Used as the `beforeDelete` hook on both doors. The message says what is in the way rather
 * than only that something is: "in use" sends somebody hunting, and they will usually give up
 * and edit the database.
 */
/** Total across the blockers, so the verb agrees with the count and not with the last noun. */
const blockerTotal = (blockers) => blockers.reduce((sum, row) => sum + row.count, 0);

export async function assertCompanyUnused(companyId) {
  const blockers = await companyBlockers(companyId);
  if (blockers.length) {
    // "1 contact still refers" / "2 contacts still refer". The first version said "refer" either
    // way, which is the sort of thing nobody notices until it is in front of a customer.
    const verb = blockerTotal(blockers) === 1 ? 'refers' : 'refer';
    throw badRequest(
      `${describeBlockers(blockers)} still ${verb} to this client. Remove or reassign those first.`
    );
  }
}

export async function assertContactUnused(contactId) {
  const blockers = await contactBlockers(contactId);
  if (blockers.length) {
    const verb = blockerTotal(blockers) === 1 ? 'names' : 'name';
    throw badRequest(
      `${describeBlockers(blockers)} still ${verb} this contact. Remove them from those first.`
    );
  }
}

/** Whether a company exists at all, for a friendlier 404 than the model name. */
export const companyExists = (companyId) => Company.exists({ _id: companyId });

export default assertCompanyUnused;
