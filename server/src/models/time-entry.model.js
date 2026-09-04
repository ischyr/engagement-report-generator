import mongoose from 'mongoose';

/**
 * Hours somebody actually spent on an engagement, a day at a time.
 *
 * The other half of a booking. A booking is a *promise* — the days a person expects to be
 * occupied — and this is what the work turned out to take. They are kept apart on purpose:
 * a plan that quietly rewrote itself to match reality would destroy the only figure worth
 * having, which is the difference between the two. That difference is what lets the next
 * job of the same shape be quoted honestly.
 *
 * Days, not timestamps, exactly like a booking: "six hours on the 12th" has to mean the
 * 12th to whoever reads it, from wherever they read it. There is no start and end time
 * because nobody in this trade works one unbroken block, and a field demanding one would
 * be filled in with fiction.
 *
 * One row per person per engagement per day, enforced by a unique index. Logging a day you
 * have already logged *corrects* it rather than adding to it — "I did six hours" entered
 * twice means six hours, not twelve, and a timesheet that silently doubles is worse than
 * no timesheet.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a working day is worth, for turning hours into the days people actually talk in.
 *
 * Hours are what gets logged, because that is what a person knows at the end of an
 * afternoon. Days are what gets quoted. One constant, used by every view and by the
 * report, so no two places can disagree about what "four days" meant.
 */
export const HOURS_PER_DAY = 8;

const timeEntrySchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    day: { type: String, required: true, match: DAY },
    /**
     * Quarter-hour resolution and a hard ceiling of a full day. The floor is a quarter
     * rather than zero because an entry of nothing is a deletion, and the routes treat it
     * as one instead of storing a row that means "no".
     */
    hours: { type: Number, required: true, min: 0.25, max: 24 },
    note: { type: String, default: '', maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One entry per person per engagement per day. The upsert in the routes depends on it.
timeEntrySchema.index({ audit: 1, user: 1, day: 1 }, { unique: true });
// "What did I log this month", and "what did this engagement cost".
timeEntrySchema.index({ user: 1, day: 1 });

export const TimeEntry = mongoose.model('TimeEntry', timeEntrySchema);
export default TimeEntry;
