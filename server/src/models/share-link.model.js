import mongoose from 'mongoose';

/**
 * A link that lets a client see their own findings without an account.
 *
 * The app has always ended at the moment the report is sent. What happens next — the client fixing
 * things, and telling somebody they have — happens in email, and comes back as a spreadsheet
 * attached to a message three months later, if it comes back at all. This is the other end of that:
 * a URL the client can open, showing what is still outstanding and letting them say what they have
 * done, so the retest has a starting list that somebody did not have to assemble by hand.
 *
 * It is the only thing in this app that shows client data to somebody with no account, so the
 * rules it is built on are worth stating plainly:
 *
 *   - **The token is a bearer credential.** 32 random bytes, stored only as a SHA-256 hash — the
 *     same treatment an invitation link gets. A copy of this collection tells you that links exist
 *     and nothing about how to use one.
 *   - **It expires, and it can be revoked.** Both are checked on every request; neither is a TTL
 *     index, because the row is also the record that the link was made, and that outlives the link.
 *   - **It is scoped to one engagement**, and to a deliberately small part of one. What it may show
 *     is decided in `share.service.js`, not here, and the list of what it must never show is
 *     written out beside it.
 *   - **Every use is on the engagement's activity log.** A client marking something fixed is a
 *     change to the record, and a change nobody can attribute is worse than no change.
 */
const shareLinkSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /** SHA-256 of the token that went out. Never the token itself. */
    tokenHash: { type: String, required: true, unique: true, index: true },

    /** Who it was made for, in the sender's words — "Dana at Northwind". Shown to the team only. */
    label: { type: String, default: '', trim: true, maxlength: 160 },

    /**
     * Whether the client may change anything, or only read.
     *
     * Off is a real use: a link sent to somebody's auditor, or to a stakeholder who should see the
     * position and has no business changing it.
     */
    allowUpdates: { type: Boolean, default: true },

    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * How often it has been opened, and when last.
     *
     * Deliberately not who or from where. The address a client reads their report from is their
     * information, not ours, and a log of it would be a thing we would then have to protect.
     */
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ShareLink = mongoose.model('ShareLink', shareLinkSchema);
export default ShareLink;
