import mongoose from 'mongoose';

/**
 * Who did what in the Sales section.
 *
 * Its own collection rather than entries in `Activity`, because that one is keyed to an
 * engagement — `audit` is required, every index starts with it, and every read is "the history
 * of this job". A proposal is not a job, and making the field optional would leave every one of
 * those queries needing to remember that some rows are not about an engagement at all.
 *
 * Admin-only, on purpose and unlike the engagement log. An engagement's history is written for
 * the people doing the work: it answers "who changed this finding" for the person looking at the
 * finding. This answers a different question, and a managerial one — who is moving deals, whose
 * estimates get revised and by how much, what got deleted last Tuesday. That is not a thing
 * colleagues should be reading about each other, and it is exactly what somebody running the
 * firm needs when a client asks why their proposal took three weeks.
 *
 * A flat log rather than per-record histories: the proposal keeps its own status trail because a
 * proposal page needs it without a second query, and this is the cross-cutting view. The
 * duplication is deliberate and small.
 */

export const SALES_ACTIONS = {
  CLIENT_ADDED: 'client.added',
  CLIENT_UPDATED: 'client.updated',
  CLIENT_DELETED: 'client.deleted',

  CONTACT_ADDED: 'contact.added',
  CONTACT_UPDATED: 'contact.updated',
  CONTACT_DELETED: 'contact.deleted',

  PROPOSAL_RAISED: 'proposal.raised',
  PROPOSAL_UPDATED: 'proposal.updated',
  PROPOSAL_DELETED: 'proposal.deleted',
  PROPOSAL_MOVED: 'proposal.moved',
  PROPOSAL_CONVERTED: 'proposal.converted',

  ESTIMATE_SET: 'estimate.set',
  EVALUATION_WRITTEN: 'evaluation.written',
  KICKOFF_RECORDED: 'kickoff.recorded',

  DOCUMENT_GENERATED: 'document.generated',
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_APPROVED: 'document.approved',
  DOCUMENT_REJECTED: 'document.rejected',
  DOCUMENT_REMOVED: 'document.removed',

  /** Somebody's quarterly target was set or changed. Logged because it is a promise about a period. */
  TARGET_SET: 'target.set',

  /*
   * Money. Logged more carefully than anything else here: a discount is the one thing on a proposal
   * that somebody will be asked about a year later, and "who agreed to 40% off" needs an answer
   * that is not somebody's memory.
   */
  PRICE_SET: 'price.set',
  PRICE_APPROVED: 'price.approved',
  PRICE_REJECTED: 'price.rejected',
  BILLING_UPDATED: 'billing.updated',
};

/** Which half of the flow an entry belongs to, for a page that wants to filter. */
export const SALES_ACTION_AREA = {
  'client.added': 'clients',
  'client.updated': 'clients',
  'client.deleted': 'clients',
  'contact.added': 'clients',
  'contact.updated': 'clients',
  'contact.deleted': 'clients',
  'proposal.raised': 'proposals',
  'proposal.updated': 'proposals',
  'proposal.deleted': 'proposals',
  'proposal.moved': 'proposals',
  'proposal.converted': 'proposals',
  'estimate.set': 'effort',
  'evaluation.written': 'effort',
  'kickoff.recorded': 'proposals',
  'document.generated': 'documents',
  'document.uploaded': 'documents',
  'document.approved': 'documents',
  'document.rejected': 'documents',
  'document.removed': 'documents',
  'target.set': 'proposals',
  'price.set': 'effort',
  'price.approved': 'effort',
  'price.rejected': 'effort',
  'billing.updated': 'proposals',
};

const salesActivitySchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** What the actor was when they did it: an admin acting as sales is worth telling apart. */
    actorRole: { type: String, default: '' },

    action: { type: String, required: true },
    /** A short human sentence, built when the entry is written. */
    summary: { type: String, default: '' },

    /**
     * What it happened to, as a reference *and* as text.
     *
     * Both, because the reference is what makes a row clickable and the text is what keeps it
     * readable after the thing is deleted — and half of what this log records is deletions. A
     * row that reads "removed" with nothing left to name would be the least useful entry here.
     */
    proposal: { type: mongoose.Schema.Types.ObjectId, ref: 'Proposal', default: null },
    proposalRef: { type: String, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
    target: { type: String, default: '' },

    /** Anything else worth keeping, e.g. { from: 'sent', to: 'accepted' } or the two day figures. */
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// The only read there is: newest first, sometimes narrowed to one proposal.
salesActivitySchema.index({ createdAt: -1 });
salesActivitySchema.index({ proposal: 1, createdAt: -1 });

export const SalesActivity = mongoose.model('SalesActivity', salesActivitySchema);
export default SalesActivity;
