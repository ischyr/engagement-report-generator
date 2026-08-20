import mongoose from 'mongoose';

/**
 * A methodology: the list of things you set out to test.
 *
 * These used to live in a source file, which meant a team could not add their own
 * without editing the code and redeploying — the one limitation nobody could work
 * around. They are data now, and the built-in ones are seeded rather than special:
 * the same routes edit all of them.
 */
const checklistCheckSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    /** What "verified" means for this one, if the title is not self-evident. */
    description: { type: String, default: '', maxlength: 2000 },
    /** Free-text grouping, e.g. "Authentication". Empty falls under Ungrouped. */
    category: { type: String, default: '', trim: true, maxlength: 120 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const checklistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: '', maxlength: 1000 },

    /**
     * Stable handle for the ones that ship with the app, so seeding is idempotent
     * and an older client posting `preset: 'web'` still resolves. User-created
     * checklists have none and are addressed by id.
     */
    slug: { type: String, default: null, trim: true, lowercase: true, maxlength: 60 },
    /** True for the shipped methodologies — a label in the UI, not a lock. */
    builtin: { type: Boolean, default: false },

    checks: [checklistCheckSchema],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * When the name or description last changed.
     *
     * Separate from `updatedAt`, which moves whenever any check is touched — the
     * same reason an engagement has `detailsUpdatedAt`. Without it, somebody adding
     * a check would make a concurrent rename report a conflict about a field nobody
     * else edited.
     */
    detailsUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Seeding looks checklists up by slug; a partial index keeps user-created ones
// (which have no slug) from colliding with each other on null.
checklistSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } }
);
checklistSchema.index({ name: 1 });

export const Checklist = mongoose.model('Checklist', checklistSchema);
export default Checklist;
