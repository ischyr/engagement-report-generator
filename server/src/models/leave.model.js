import mongoose from 'mongoose';

/**
 * Days somebody is not available: holiday, sickness, training, or a public holiday.
 *
 * The Schedule could only ever say what people had *promised*, never what they could not
 * promise. That gap is not cosmetic: with no record of leave, somebody gets booked into
 * their own fortnight in August, and the utilisation figure on the Team page counts those
 * days as capacity they had — a percentage measured against a denominator everyone knows
 * is wrong.
 *
 * Stored as `yyyy-mm-dd` strings, exactly like bookings and time entries, and for the same
 * reason: a day off is a *day*, not an instant. Held as a timestamp, somebody's holiday
 * would shift by one whenever the reader's timezone disagreed with the author's.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why somebody is away.
 *
 * `public-holiday` is the odd one out and is stored as leave on purpose: it occupies days,
 * comes out of the same denominator, and draws on the same calendar, so a second collection
 * would only mean two things to keep in step. It is the one type with no owner — see `user`.
 */
export const LEAVE_TYPES = ['holiday', 'sick', 'training', 'unpaid', 'public-holiday', 'other'];

/** Types that draw down somebody's annual allowance. Sickness and training do not. */
export const ALLOWANCE_TYPES = ['holiday', 'unpaid'];

/**
 * Where a request stands.
 *
 * `cancelled` rather than a delete for anything already decided: "my leave was approved and
 * then it vanished" is not a state a shared calendar should be able to reach silently, and
 * an approval is a decision somebody made — worth keeping even once it no longer applies.
 */
export const LEAVE_STATUSES = ['requested', 'approved', 'declined', 'cancelled'];

/** Half days, because "I am off on Friday afternoon" is a real thing people do. */
export const LEAVE_PORTIONS = ['full', 'am', 'pm'];

const leaveSchema = new mongoose.Schema(
  {
    /**
     * Whose days these are — `null` means everybody's.
     *
     * A public holiday applies to the whole firm, and writing one row per person would
     * mean a new joiner silently has no Christmas. `null` is the whole-firm case, and
     * every query that reads leave has to allow for it.
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    start: { type: String, required: true, match: DAY },
    /** Inclusive, like a booking: one day off is start === end. */
    end: { type: String, required: true, match: DAY },

    type: { type: String, enum: LEAVE_TYPES, default: 'holiday' },
    /** Only meaningful on a single day; a half-day range is a full day with extra steps. */
    portion: { type: String, enum: LEAVE_PORTIONS, default: 'full' },

    /**
     * The reason, in the person's own words.
     *
     * Read back only to its owner and to admins. That everybody is away is what a shared
     * calendar is *for*; why they are away is between them and whoever approves it, and
     * "hospital appointment" is not something to print on a team page.
     */
    note: { type: String, default: '', maxlength: 300 },

    status: { type: String, enum: LEAVE_STATUSES, default: 'requested', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    /** Why it was declined, which is the only kind of decision that needs explaining. */
    decisionNote: { type: String, default: '', maxlength: 300 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

leaveSchema.pre('validate', function coherent(next) {
  if (this.start && this.end && this.end < this.start) {
    return next(new Error('Leave cannot end before it starts'));
  }
  // A half day over a range is either a mistake or a misunderstanding; both are worth
  // refusing here rather than storing something no reader can interpret.
  if (this.portion !== 'full' && this.start !== this.end) {
    return next(new Error('A half day has to be a single day'));
  }
  if (this.type === 'public-holiday' && this.user) {
    return next(new Error('A public holiday belongs to everybody, so it has no owner'));
  }
  return next();
});

// "Who is away in this window" — the calendar's only question.
leaveSchema.index({ start: 1, end: 1 });
// "How much has this person taken", per person per year.
leaveSchema.index({ user: 1, status: 1, start: 1 });

/** What one day of this leave costs: a half day is half a day, everywhere it is counted. */
export function dayWeight(leave) {
  return leave?.portion === 'full' || !leave?.portion ? 1 : 0.5;
}

export const Leave = mongoose.model('Leave', leaveSchema);
export default Leave;
