import mongoose from 'mongoose';

/**
 * Who changed an instance-wide setting, when, and what it was before.
 *
 * Every engagement keeps a detailed activity log; the settings that govern all of them kept
 * none. So the review quorum could be lowered, mandatory review switched off, the trash
 * retention shortened to a day or the instance rebranded, and afterwards nobody could say who
 * did it or what it had been — which makes the controls themselves worth very little.
 *
 * A diff rather than a snapshot: a copy of the whole document per save would be unreadable and
 * enormous, and the question people ask is "what changed", not "what did everything look like".
 *
 * No expiry. Sessions, borrowed credentials and deleted findings all prune themselves; this is
 * a governance record and exists precisely to answer questions asked long afterwards.
 */

const changeSchema = new mongoose.Schema(
  {
    /** Dotted, as stored: `reviews.public.minReviewers`. */
    path: { type: String, required: true },
    /**
     * The values, as text.
     *
     * Text because a setting can be a boolean, a number, a colour or a data URI, and a mixed
     * type would have to be re-interpreted by every reader. Bulky values are summarised rather
     * than stored — see `describeValue()` — since a 300 kB logo recorded twice per change would
     * make the log larger than the thing it describes.
     */
    from: { type: String, default: '' },
    to: { type: String, default: '' },
  },
  { _id: false }
);

const settingsChangeSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** `update` for a save, `reset` for restoring the defaults. */
    action: { type: String, enum: ['update', 'reset'], default: 'update' },
    changes: { type: [changeSchema], default: [] },
    /** Where it came from, for a log somebody reads six months later. */
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

// The only question it is asked: what happened here, most recent first.
settingsChangeSchema.index({ createdAt: -1 });

export const SettingsChange = mongoose.model('SettingsChange', settingsChangeSchema);
export default SettingsChange;
