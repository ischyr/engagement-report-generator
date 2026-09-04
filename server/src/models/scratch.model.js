import mongoose from 'mongoose';

/**
 * One person's own notes, belonging to no engagement.
 *
 * The Notes tab is per-engagement and rightly so: it is the record of what was tried on *that*
 * target, and it goes with the engagement when the engagement goes. But a tester's working memory
 * is not shaped like that. The payload that worked, a client's odd SSO behaviour worth remembering
 * next year, a half-formed idea at four in the afternoon — none of it belongs to the job in front
 * of you, and until now the only place to put it was somebody's own text file outside the app,
 * where it is neither searchable nor backed up nor encrypted with everything else.
 *
 * Private, without exception. There is no sharing flag and no admin view: a scratchpad somebody
 * else might read is a scratchpad nobody writes honestly in, and the moment a note is worth
 * showing anybody it can be moved into an engagement, where it is on the record and behaves like
 * every other note.
 */
const scratchSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, default: '', trim: true, maxlength: 200 },
    /** Editor HTML, the same as an engagement note — so moving one across needs no conversion. */
    content: { type: String, default: '', maxlength: 200_000 },
    /**
     * Free-text labels, because a scratchpad's categories are personal and change.
     *
     * Not a taxonomy and not shared: an enum here would be somebody deciding in advance what
     * another person is allowed to find useful.
     */
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
    pinned: { type: Boolean, default: false },
    /** Where it came from, when it was written up somewhere and kept. */
    fromAudit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
  },
  { timestamps: true }
);

/* The list is always "mine, pinned first, newest first" — one index answers it. */
scratchSchema.index({ user: 1, pinned: -1, updatedAt: -1 });

export const Scratch = mongoose.model('Scratch', scratchSchema);
export default Scratch;
