import mongoose from 'mongoose';

/**
 * A finding somebody deleted, kept until it is genuinely not wanted.
 *
 * An engagement gets a trash it can be restored from; a finding — often an hour of
 * writing with screenshots attached — used to vanish on a confirm dialog. This is the
 * same idea one level down.
 *
 * Its own collection rather than an array on the audit, deliberately. A deleted
 * finding must be invisible to *everything*: report data, counts, insights, preflight,
 * the recurrence check, the content fingerprint. Filtering it out in each of those is a
 * list nobody can be sure they finished, and a deleted finding reaching a client's
 * report would be worse than the problem being fixed. Living outside the audit makes
 * that structural rather than careful.
 *
 * The finding itself is stored as-is, unvalidated: it was valid when written, nothing
 * queries inside it here, and keeping it verbatim — comments, custom fields, its own
 * `_id` — is what makes restoring lossless.
 */
const deletedFindingSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /** Kept alongside so a listing needs no lookup into the blob. */
    title: { type: String, default: '' },
    findingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    finding: { type: mongoose.Schema.Types.Mixed, required: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Mongo removes the row itself once the window has passed. */
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

deletedFindingSchema.index({ audit: 1, createdAt: -1 });

export const DeletedFinding = mongoose.model('DeletedFinding', deletedFindingSchema);
export default DeletedFinding;
