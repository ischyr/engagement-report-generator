import mongoose from 'mongoose';

/**
 * A change to what was in scope, and who agreed to it.
 *
 * The engagement's scope holds the *end state*: whatever the hosts are on the day the report
 * is generated. So a host added on day three and another dropped on day four leave no trace,
 * and "you never tested X" has no answer but somebody's memory of a call.
 *
 * This is the answer. Recorded deliberately rather than derived from saves: the fact worth
 * keeping is not that the array changed — the activity log already says that — but *who agreed
 * it and when*, which no diff can know.
 *
 * `agreedBy` is a snapshot for the same reason a delivery's recipients are: a record of a past
 * agreement must not change when a contact is renamed or deleted.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const SCOPE_CHANGE_KINDS = ['added', 'removed', 'clarified'];

export const SCOPE_CHANGE_LABELS = {
  added: 'Added to scope',
  removed: 'Taken out of scope',
  clarified: 'Clarified',
};

const scopeChangeSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    kind: { type: String, enum: SCOPE_CHANGE_KINDS, default: 'added' },
    /** The day it was agreed, which is rarely the day somebody got round to writing it down. */
    agreedOn: { type: String, required: true, match: DAY },

    /**
     * What changed, in the words a report can print.
     *
     * Free text rather than a structured host list: a change is as often "the payment sandbox
     * is out of scope for this window" as it is three IP addresses, and a field that only
     * accepted addresses would push the first kind into a note nobody reads.
     */
    summary: { type: String, required: true, trim: true, maxlength: 500 },
    /** The hosts, URLs or ranges involved, when the change is that specific. */
    targets: [{ type: String, trim: true, maxlength: 200 }],

    /** Who on the client's side agreed it. Kept literally, plus a link when they are a contact. */
    agreedBy: {
      client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
      name: { type: String, default: '', trim: true, maxlength: 160 },
    },
    /** How it was agreed — a call, an email, the kick-off meeting. */
    channel: { type: String, default: '', trim: true, maxlength: 80 },
    note: { type: String, default: '', maxlength: 1000 },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// The engagement's own log, in the order the changes were agreed.
scopeChangeSchema.index({ audit: 1, agreedOn: 1 });

export const ScopeChange = mongoose.model('ScopeChange', scopeChangeSchema);
export default ScopeChange;
