import mongoose from 'mongoose';

/**
 * The last few minutes of deletions, kept so they can be put back.
 *
 * A finding already had this — `DeletedFinding` keeps the removed record verbatim so a restore is
 * lossless, and the tab offers an Undo. Nothing else did. Deleting an enumeration step took its
 * command, its output and its write-up permanently on a mis-click, and the same was true of a
 * credential, a test check, a section and everything else that lives inside an engagement.
 *
 * This is the same idea generalised, and deliberately *not* the same thing as the trash:
 *
 *   trash      an engagement, kept for weeks, listed on a page, restored on purpose
 *   recycled   one row inside an engagement, kept for minutes, offered in the toast that
 *              announced the delete, and forgotten
 *
 * That difference is why this is not a second trash with a browsing UI. An undo is a correction to
 * something you just did, and a record you have to go and find is not an undo — it is filing. The
 * window is short on purpose: long enough to notice the mistake, short enough that this collection
 * never becomes a place where deleted things live.
 */
const recycledSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /** Which restorer puts it back. See `RESTORERS` in `recycle.service.js`. */
    kind: { type: String, required: true, trim: true, maxlength: 40 },
    /** What to call it in "X was deleted", so the toast can be specific. */
    label: { type: String, default: '', trim: true, maxlength: 200 },

    /**
     * The removed record itself, verbatim.
     *
     * `Mixed`, because the whole point is that this collection does not know or care what shape a
     * credential or an enumeration step is — it hands the bytes back to the restorer that put them
     * here. Anything that validated on the way in will validate on the way back.
     */
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    /** Where it sat, so a restore puts it back in its place rather than at the end. */
    index: { type: Number, default: null },
    /** For a row that lives inside another row — a note on an enumeration step. */
    parent: { type: String, default: '' },
    /** Anything the restorer needs beyond the record: a step's body, an artefact's file id. */
    extra: { type: mongoose.Schema.Types.Mixed, default: null },

    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /**
     * When Mongo may drop it.
     *
     * A TTL index rather than a sweep, because this is the one kind of housekeeping that must not
     * depend on anybody remembering to run something — and because an undo window that quietly
     * became a month would turn a convenience into a copy of deleted client data.
     */
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export const Recycled = mongoose.model('Recycled', recycledSchema);
export default Recycled;
