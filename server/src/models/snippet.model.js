import mongoose from 'mongoose';

/**
 * A piece of writing worth keeping, that is not a finding.
 *
 * The vulnerability library exists for findings, and everything else got retyped: the paragraph
 * about how the testing was authorised, a client's standing quirk, the payload that works against
 * that one WAF, the wording of a caveat legal asked for last year. Those live in a note on one
 * engagement, and the next engagement starts from memory.
 *
 * Deliberately *not* the vulnerability library. A library entry is a finding with a score and a
 * remediation and a place in the report; a snippet is text that goes wherever you paste it, with
 * no opinion about what it means.
 *
 * Personal by default and shareable on purpose. Half of these are somebody's own shorthand and
 * would be noise in a shared list; the other half are the firm's house wording, and a copy per
 * person is how house wording drifts.
 */
const snippetSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    /** Editor HTML, so it pastes back with its formatting, lists and code blocks intact. */
    body: { type: String, default: '' },

    /**
     * Free-text grouping — "authorisation", "AD", "caveats". A taxonomy would need maintaining
     * and this is a scratchpad with a memory, not a catalogue.
     */
    tags: [{ type: String, trim: true, maxlength: 40 }],

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Visible to everyone, and editable by its owner or an admin. */
    shared: { type: Boolean, default: false },

    /** So a list can put what you actually use at the top without anybody organising it. */
    uses: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// "Mine, and everything shared" — the only question the list asks.
snippetSchema.index({ owner: 1, shared: 1, title: 1 });
snippetSchema.index({ shared: 1, updatedAt: -1 });

export const Snippet = mongoose.model('Snippet', snippetSchema);
export default Snippet;
