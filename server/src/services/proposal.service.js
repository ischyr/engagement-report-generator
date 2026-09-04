/**
 * The rules a proposal moves by.
 *
 * Kept out of the route because two audiences drive the same record from two different pages,
 * and a rule written twice is a rule that will eventually disagree with itself.
 */

import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { Template } from '../models/template.model.js';
import { priceOf, priceProblem } from './pricing.service.js';
import {
  LOSS_REASONS,
  Proposal,
  PROPOSAL_OPEN_STATUSES,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TRANSITIONS,
  WIN_REASONS,
} from '../models/proposal.model.js';
import { WORKING_ROLES, SIGNING_ROLES } from '../models/user.model.js';
import { storeDocument } from './documents.service.js';
import { openTemplate, ooxmlOptionsFor, renderDocx, safeDocName } from './docx-render.service.js';
import { provenanceFor, outputHash } from './provenance.service.js';
import { RenderRecord } from '../models/render-record.model.js';
import { buildProposalData } from './proposal-data.service.js';
import { badRequest, forbidden } from '../utils/http-error.js';

/** What a caller counts as, for the transition table. Admins are both. */
export function audienceOf(user) {
  const roles = user?.roles ?? [];
  if (roles.includes('admin')) return 'both';
  /*
   * Sales *and* a working role means both, which is the point of an account holding more than
   * one: a small firm where the same person sells the work and helps deliver it is normal, and
   * making them choose would mean two accounts and two passwords.
   */
  if (roles.includes('sales')) {
    return roles.some((role) => WORKING_ROLES.includes(role)) ? 'both' : 'sales';
  }
  return 'work';
}

/**
 * Whether this person may sign a client's paperwork off.
 *
 * A manager, or an admin. Deliberately narrower than "somebody who does the work": deciding a
 * contract is fit to leave the building is an authority rather than a skill, and it is the one
 * step in this flow with a signature at the end of it. A consultant still writes the estimate
 * and the evaluation — how long a job takes is their judgement, not a manager's.
 */
export const canSignOff = (user) => (user?.roles ?? []).some((role) => SIGNING_ROLES.includes(role));

const allows = (audience, needed) => audience === 'both' || audience === needed;

/**
 * Whether this person can make this move, and if not, why not in words they can act on.
 *
 * Returns a reason rather than throwing, so the API can hand the *whole* set of available
 * moves to the client and the page can offer exactly those buttons. A UI that offers a
 * button the server will refuse is how people learn to distrust the app.
 */
export function transitionProblem(proposal, to, user, price = null) {
  const from = proposal.status;
  if (from === to) return 'It is already there.';

  const allowed = PROPOSAL_TRANSITIONS[from] ?? [];
  const move = allowed.find((entry) => entry.to === to);
  if (!move) {
    return `A proposal that is "${PROPOSAL_STATUS_LABELS[from] ?? from}" cannot go straight to "${
      PROPOSAL_STATUS_LABELS[to] ?? to
    }".`;
  }
  if (!allows(audienceOf(user), move.by)) {
    return move.by === 'sales'
      ? 'Only the sales side moves a proposal to there.'
      : 'That step belongs to whoever would do the work.';
  }

  /*
   * The two gates that make the flow mean anything.
   *
   * Without the first, a proposal could be sent quoting a figure nobody who would do the work
   * has ever seen — which is the exact failure the evaluation step exists to prevent. Without
   * the second, the document review would be a step you could walk past.
   */
  if (to === 'documents-review' && !proposal.effortAgreed()) {
    return 'The effort has not been agreed yet, so there is nothing firm to put in the paperwork.';
  }
  if ((to === 'evaluated' && from === 'documents-review') && !canSignOff(user)) {
    // Sending the paperwork back is the same judgement as signing it off, so it takes the same
    // authority. Without this the gate would be one button wide.
    return 'Sending the paperwork back is a manager’s decision.';
  }
  if (to === 'sent') {
    /*
     * The price gate, alongside the paperwork gate and for the same reason.
     *
     * `price` is passed in rather than computed here because this function is synchronous and the
     * rate card lives in the database — and passing it keeps one definition of the rule in
     * pricing.service.js instead of a second copy phrased slightly differently. A caller that has
     * no price simply does not get this check, which is why `moveProposal` always computes one.
     */
    const priceIssue = price ? priceProblem(price) : null;
    if (priceIssue) return priceIssue;

    const generated = (proposal.documents ?? []).filter((doc) => doc.generated);
    if (!generated.length) return 'Generate the paperwork before sending it.';
    const unapproved = generated.filter((doc) => !doc.approvedAt);
    if (unapproved.length) {
      return `${unapproved.length} generated document${
        unapproved.length === 1 ? ' has' : 's have'
      } not been signed off yet.`;
    }
  }
  return null;
}

/**
 * Every move this person could make from here, for the buttons a page should show.
 *
 * Moves that belong to the *other* audience are left out entirely — a salesperson has no use
 * for a greyed-out "agree the effort". Moves that are theirs but blocked are included *with*
 * the reason, because "why can I not send this yet" is the question the page has to answer.
 */
export function availableTransitions(proposal, user, price = null) {
  const audience = audienceOf(user);
  return (PROPOSAL_TRANSITIONS[proposal.status] ?? [])
    .filter((entry) => allows(audience, entry.by))
    .map((entry) => ({
      to: entry.to,
      label: PROPOSAL_STATUS_LABELS[entry.to] ?? entry.to,
      /** Null when it can be pressed; a sentence when it cannot. */
      problem: transitionProblem(proposal, entry.to, user, price),
    }));
}

/** Applies a move, recording who and why. Throws if it is not allowed. */
export async function moveProposal(proposal, to, user, note = '', outcome = null) {
  /*
   * The price is computed here, not taken from the caller.
   *
   * Every route that moves a proposal would otherwise have to remember to pass one, and the one
   * that forgot would be a way to send an unapproved price to a client. The client may or may not
   * be populated depending on how the proposal was loaded, so it is fetched when it is not.
   */
  const company =
    proposal.company && proposal.company.billing !== undefined
      ? proposal.company
      : proposal.company
        ? await Company.findById(proposal.company._id ?? proposal.company).select('billing')
        : null;
  const price = priceOf(proposal, company, await Settings.getSettings());

  const problem = transitionProblem(proposal, to, user, price);
  if (problem) throw badRequest(problem);

  /*
   * A loss has to say why.
   *
   * Asked for here rather than left optional, because a reason nobody is required to give is a
   * field that is empty in nine cases out of ten and therefore worth nothing. The moment of the
   * move is also the only moment when whoever is clicking already knows the answer — a week later
   * it is a guess, and a month later nobody remembers there was a conversation.
   */
  const closing = to === 'declined' || to === 'accepted';
  if (to === 'declined' && !outcome?.reason) {
    throw badRequest('Say why it was lost — the reason is what makes the pipeline worth reading');
  }
  if (closing && outcome?.reason) {
    const allowed = to === 'declined' ? LOSS_REASONS : WIN_REASONS;
    if (!allowed.includes(outcome.reason)) {
      throw badRequest(`"${outcome.reason}" is not a reason a ${to} proposal can have`);
    }
  }

  const from = proposal.status;
  proposal.status = to;
  proposal.history.push({ from, to, by: user._id, at: new Date(), note });

  if (closing && outcome?.reason) {
    proposal.outcome = {
      reason: outcome.reason,
      competitor: outcome.reason === 'competitor' ? (outcome.competitor ?? '').trim() : '',
      note: (note ?? '').trim(),
      at: new Date(),
      by: user._id,
    };
  }
  /*
   * Reopening clears it. A proposal that was lost on price in March and won in June must not carry
   * March's reason into the win column — which is exactly what a field nobody clears would do.
   *
   * Only a move back into the live pipeline counts as reopening. `converted` is where a win goes
   * next, not a fresh start: clearing there wiped the reason off every proposal that became a job,
   * which is to say off every win worth counting. The suite caught it as an empty win column.
   */
  if (PROPOSAL_OPEN_STATUSES.includes(to) && proposal.outcome?.reason) {
    proposal.outcome = { reason: '', competitor: '', note: '', at: null, by: null };
    proposal.declineReason = '';
  }
  if (to === 'declined' && note) proposal.declineReason = note;

  await proposal.save();
  return proposal;
}

/**
 * The next reference in this year's sequence.
 *
 * Highest existing plus one rather than a count, because a deleted proposal would otherwise
 * hand its number to the next one — and two contracts with the same reference is the kind of
 * thing that gets noticed by a lawyer rather than by us.
 */
export async function nextReference(now = new Date()) {
  const year = now.getUTCFullYear();
  const prefix = `PRO-${year}-`;
  const latest = await Proposal.find({ reference: new RegExp(`^${prefix}\\d+$`) })
    .select('reference')
    .sort({ reference: -1 })
    .limit(1);
  const last = latest[0] ? Number(latest[0].reference.slice(prefix.length)) : 0;
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(3, '0')}`;
}

/** Populate paths every read of a proposal wants, so no page has to ask twice. */
export const PROPOSAL_POPULATE = [
  { path: 'company', select: 'name shortName address website logo billing' },
  { path: 'contacts', select: 'firstname lastname email phone cell title' },
  { path: 'owner', select: 'username firstname lastname email phone title' },
  { path: 'estimate.by', select: 'username firstname lastname' },
  { path: 'evaluation.by', select: 'username firstname lastname' },
  { path: 'documents.addedBy', select: 'username firstname lastname' },
  { path: 'documents.approvedBy', select: 'username firstname lastname' },
  { path: 'documents.rejectedBy', select: 'username firstname lastname' },
  { path: 'history.by', select: 'username firstname lastname' },
  { path: 'comments.author', select: 'username firstname lastname' },
  // `deletedAt` too: "the engagement exists" and "the engagement is in the trash" are
  // different answers, and the delete guard needs the second one.
  { path: 'audit', select: 'name reference deletedAt' },
];

/**
 * The pipeline, counted.
 *
 * One aggregation rather than a count per status: the sales dashboard wants all of them and
 * the difference is eight round trips.
 */
export async function pipelineSummary() {
  const rows = await Proposal.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 }, days: { $sum: { $ifNull: ['$estimate.days', 0] } } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const open = PROPOSAL_OPEN_STATUSES.reduce((total, status) => total + (byStatus[status] ?? 0), 0);
  return {
    byStatus,
    open,
    accepted: byStatus.accepted ?? 0,
    declined: byStatus.declined ?? 0,
    converted: byStatus.converted ?? 0,
    /** Days sitting in accepted-but-not-yet-a-job, which is what capacity has to absorb. */
    daysInquired: rows
      .filter((row) => row._id === 'accepted')
      .reduce((total, row) => total + row.days, 0),
  };
}

/**
 * What the people who would do the work are being asked for.
 *
 * Two queues, because they are two different jobs: one needs a number, the other needs
 * somebody to read a contract. Anything else is not theirs to act on.
 */
export async function workQueue() {
  const [evaluating, reviewing] = await Promise.all([
    Proposal.find({ status: 'evaluating' }).populate(PROPOSAL_POPULATE).sort({ updatedAt: 1 }),
    Proposal.find({ status: 'documents-review' }).populate(PROPOSAL_POPULATE).sort({ updatedAt: 1 }),
  ]);
  return { evaluating, reviewing };
}

/**
 * Renders one piece of paperwork and stores it against the proposal.
 *
 * Through the same renderer as the engagement report — see docx-render.service.js — so the tag
 * language, the filters and the treatment of unknown tags are not merely similar but the same
 * code. Regenerating replaces the previous file of that type rather than adding a second: two
 * NDAs on one proposal is a question nobody wants to have to answer, and the approval that was
 * given to the old one must not survive the change.
 */
export async function generateProposalDocument({ proposal, template, user }) {
  if (template.purpose !== 'proposal') {
    throw badRequest(`"${template.name}" is a report template, not proposal paperwork.`);
  }
  const settings = await Settings.getSettings();
  const pub = settings.report?.public ?? {};
  const priv = settings.report?.private ?? {};

  const startedAt = Date.now();
  const { zip, parts, numbering, buffer: templateBuffer } = await openTemplate(template);
  const ooxmlOptions = ooxmlOptionsFor({ parts, numbering, pub, priv });
  const data = buildProposalData(proposal, settings, ooxmlOptions, {
    user,
    templateName: template.name ?? '',
    docType: template.docType || 'other',
  });

  /*
   * The same stamp a report gets, for the same reason and more so: a contract is the document most
   * likely to be argued about a year later, and "which version of the NDA template made this" is
   * not a question anybody can answer from the bytes otherwise.
   */
  const provenance = provenanceFor({
    template,
    templateBuffer,
    user,
    subject: [proposal.reference, proposal.title].filter(Boolean).join(' · '),
    settings,
  });

  const buffer = renderDocx({
    zip,
    parts,
    data,
    dateFormat: pub.dateFormat,
    updateFields: priv.updateFieldsOnOpen !== false,
    provenance,
  });

  const docType = template.docType || 'other';
  const filename = `${safeDocName(docType.toUpperCase(), 'DOC')} - ${safeDocName(
    proposal.company?.name ?? proposal.title,
    'client'
  )}${proposal.reference ? ` - ${safeDocName(proposal.reference, '')}` : ''}.docx`;

  const stored = await storeDocument({
    buffer,
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    proposalId: proposal._id,
    uploadedBy: user._id,
  });

  // Replace rather than accumulate. The old approval goes with the old bytes.
  const previous = (proposal.documents ?? []).filter(
    (doc) => doc.generated && doc.docType === docType
  );
  proposal.documents = (proposal.documents ?? []).filter(
    (doc) => !(doc.generated && doc.docType === docType)
  );
  proposal.documents.push({
    docType,
    label: template.name ?? '',
    filename: stored.filename,
    file: stored.file,
    bytes: stored.bytes,
    sha256: stored.sha256,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    generated: true,
    template: template._id,
    addedBy: user._id,
    addedAt: new Date(),
  });
  await proposal.save();

  /*
   * The record, written after the document is safely stored.
   *
   * Failing to record how a document was made must not fail making it — a person waiting on an NDA
   * cares about the NDA — so this is deliberately last and deliberately not in a transaction with
   * anything. The document itself carries the same render id, so even a lost record leaves the file
   * self-describing.
   */
  await RenderRecord.create({
    ...provenance,
    kind: 'proposal-document',
    proposal: proposal._id,
    filename,
    size: buffer.length,
    outputHash: outputHash(buffer),
    ms: Date.now() - startedAt,
    counts: { images: parts.imageCount ?? 0 },
  }).catch(() => null);

  return { document: proposal.documents.at(-1), replaced: previous.map((doc) => doc.file) };
}

export default moveProposal;
