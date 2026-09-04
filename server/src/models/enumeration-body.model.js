import mongoose from 'mongoose';

/**
 * The text of one enumeration step: the tool output, the run it replaced, and the write-up.
 *
 * Its own collection, and it has to be. A step may hold 200KB of output and another 200KB of the
 * previous run, and the write-up is not capped at all — call it 400KB a step against MongoDB's 16MB
 * ceiling on a single document. Forty-one steps of full sweeps and an engagement stops saving, which
 * is not a slow page: it is the operator's last paste refusing to persist, in the middle of an
 * operation, with no warning that a limit was being approached.
 *
 * This is the third time this codebase has made the move. Evidence went to GridFS; phishing targets
 * went to their own collection, whose model says it would otherwise be *"back at the 16MB ceiling
 * the evidence move was made to escape"*. Enumeration output was then put straight into the audit
 * document. The pattern is the same and so is the fix.
 *
 * There is a second reason beyond the ceiling: every save of a finding, a section or a scope host
 * rewrote the whole engagement, output and all. A step's body changes on its own schedule and now
 * costs its own write.
 *
 * What stays on the step in the audit document is the *shape* — title, tool, command, where it sits
 * in the tree — plus the handful of small facts the tree draws from (`outputLines`, `tableRows`,
 * `outputPreview`). Those are maintained here, by `saveEnumerationBody`, which is the only thing
 * that writes output. One writer is what keeps a denormalised count from becoming a lie.
 */
const enumerationBodySchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /**
     * The step this belongs to.
     *
     * A subdocument id inside `audit.enumeration`, so there is nothing to `ref`. Deliberately not a
     * real reference: the tree's shape is the audit document's business, and this collection holds
     * only what would not fit there.
     */
    step: { type: mongoose.Schema.Types.ObjectId, required: true },

    /** Raw stdout, as pasted. Bounded, generously: a subdomain sweep runs to thousands of lines. */
    output: { type: String, default: '', maxlength: 200000 },
    /**
     * What the output said last time. One snapshot, not a history — the only question anybody asks
     * of a re-run is what is different now.
     */
    previousOutput: { type: String, default: '', maxlength: 200000 },
    previousOutputAt: { type: Date, default: null },
    /** When the output last changed, which is not the same as when the step was edited. */
    outputAt: { type: Date, default: null },

    /** The write-up: screenshots, an HTTP request and response, the prose around them. */
    content: { type: String, default: '' },
  },
  { timestamps: true }
);

/*
 * One body per step, enforced rather than assumed. Everything here upserts on this pair, and a
 * duplicate would mean a step whose output depended on which document was read first.
 */
enumerationBodySchema.index({ audit: 1, step: 1 }, { unique: true });

export const EnumerationBody = mongoose.model('EnumerationBody', enumerationBodySchema);
export default EnumerationBody;
