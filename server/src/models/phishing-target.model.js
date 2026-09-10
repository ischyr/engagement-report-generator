import mongoose from 'mongoose';

/**
 * One person a phishing campaign was sent to, and what happened.
 *
 * Its own collection, unlike scope hosts. A campaign is routinely a few thousand recipients, and
 * an engagement document that carried them would be back at the 16 MB ceiling the evidence move
 * was made to escape — with the added problem that every save of a finding would rewrite the
 * entire mailing list.
 *
 * The outcome is deliberately several fields rather than one status. A phishing test's report
 * turns on distinctions a single value cannot hold: opening a mail is not clicking a link, and
 * clicking a link is not handing over a password. Firms and tools disagree about which of those
 * "phished" means, so `phished` is recorded as its own answer — the one the report leads on —
 * and the finer-grained events are kept when the tooling provides them.
 *
 * `reported` is the one people forget to ask for and the only good news on the list: somebody who
 * spotted it and told their security team is the outcome the client is paying to increase.
 */

export const PHISHING_OUTCOMES = ['no-response', 'opened', 'clicked', 'phished', 'reported'];

const phishingTargetSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    /** The address it went to. The identity of a target, and how an import matches one. */
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    name: { type: String, default: '', trim: true, maxlength: 160 },
    /** Whose problem this is, when the report breaks results down. */
    department: { type: String, default: '', trim: true, maxlength: 120 },
    title: { type: String, default: '', trim: true, maxlength: 120 },
    /**
     * Which send this was part of.
     *
     * Campaigns go out in waves — a pilot, then the rest; or a different pretext per group — and
     * "the second wave did far worse" is a finding rather than a curiosity.
     */
    wave: { type: String, default: '', trim: true, maxlength: 80 },

    /* ------------------------------- what happened ------------------------------ */
    sent: { type: Boolean, default: false },
    opened: { type: Boolean, default: false },
    clicked: { type: Boolean, default: false },
    /** The headline: they did the thing the pretext asked for. */
    phished: { type: Boolean, default: false },
    /** They spotted it and told somebody. The number worth reporting proudly. */
    reported: { type: Boolean, default: false },

    /*
     * When each of those happened, where the import knew.
     *
     * The same argument the detection log makes: "clicked within four minutes" and "clicked the
     * following afternoon" are the difference between a campaign that worked and one that was
     * forwarded around the office, and only a timestamp can tell them apart.
     */
    sentAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    phishedAt: { type: Date, default: null },
    reportedAt: { type: Date, default: null },

    note: { type: String, default: '', trim: true, maxlength: 500 },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/**
 * One row per address per engagement.
 *
 * Enforced rather than hoped for: a results import that ran twice must correct the same people
 * rather than double the mailing list, and the unique index is what makes that a fact instead of
 * a property of the import code.
 */
phishingTargetSchema.index({ audit: 1, email: 1 }, { unique: true });
phishingTargetSchema.index({ audit: 1, phished: 1 });

/**
 * The furthest a target got, as one word.
 *
 * Derived rather than stored, because it is a view of the booleans and storing it would give two
 * fields the chance to disagree. Ordered by how bad it is: reporting it beats ignoring it, and
 * being phished is worse than clicking.
 */
export function outcomeOf(target) {
  if (target.phished) return 'phished';
  if (target.reported) return 'reported';
  if (target.clicked) return 'clicked';
  if (target.opened) return 'opened';
  return 'no-response';
}

export const PhishingTarget = mongoose.model('PhishingTarget', phishingTargetSchema);
export default PhishingTarget;
