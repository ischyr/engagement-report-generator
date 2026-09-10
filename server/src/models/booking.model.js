import mongoose from 'mongoose';

/**
 * Somebody's time, promised to an engagement.
 *
 * Distinct from the engagement's own `date_start`/`date_end`, which is the window the
 * client bought: a two-week window might hold four days of one tester and three of
 * another, and it is the *people* who are double-booked or free, never the engagement.
 * So a booking is per person per engagement, and an engagement can have several.
 *
 * Dates are stored as `yyyy-mm-dd` strings, exactly like the engagement's own dates.
 * A booking is a *day*, not an instant: stored as a timestamp it would shift a day
 * backwards for anyone reading it from a different timezone, and "I am on Northwind on
 * the 10th" must mean the 10th everywhere. Lexicographic order on that format is
 * chronological order, so range queries and sorting work unchanged.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bookingSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    start: { type: String, required: true, match: DAY },
    /** Inclusive: a single day is start === end, not a zero-length range. */
    end: { type: String, required: true, match: DAY },
    note: { type: String, default: '', maxlength: 300 },

    /**
     * When the "this starts soon" reminder went out, or null.
     *
     * The marker that makes the sweep idempotent. Stored on the booking rather than inferred
     * from the notifications collection because the sweep runs on boot, on a timer and from a
     * scheduled task, and three copies of the same reminder is indistinguishable from spam.
     *
     * Cleared when the dates move, since a booking that has been rescheduled is news again.
     */
    reminderSentAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

bookingSchema.pre('validate', function endAfterStart(next) {
  if (this.start && this.end && this.end < this.start) {
    return next(new Error('A booking cannot end before it starts'));
  }
  return next();
});

// "Who is booked in this window" is the only question the page asks.
bookingSchema.index({ start: 1, end: 1 });
bookingSchema.index({ user: 1, start: 1 });
// The reminder sweep's only query: what starts soon and has not been mentioned yet.
bookingSchema.index({ start: 1, reminderSentAt: 1 });

export const Booking = mongoose.model('Booking', bookingSchema);
export default Booking;
