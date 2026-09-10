import mongoose from 'mongoose';

/**
 * What somebody is aiming at this quarter.
 *
 * Counted in wins rather than in money, because money is not modelled yet: there is no rate card, so
 * a proposal has days and no price, and a target expressed in currency would be a number nobody could
 * compute progress against. Wins are honest and available today, and the shape here has room for a
 * value target to arrive later without a migration.
 *
 * One row per person per quarter, rather than a field on the user: a target is a fact about a period,
 * last quarter's is worth keeping, and "what did we ask of people in Q1" is a question somebody will
 * ask in Q3. A field would have been overwritten four times a year.
 */
const salesTargetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Four digits, so a quarter is unambiguous across years. */
    year: { type: Number, required: true, min: 2000, max: 2200 },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    /** How many proposals they are expected to win. */
    wins: { type: Number, default: 0, min: 0, max: 999 },
    /** Room for the figure a rate card will make possible. Unused until then. */
    value: { type: Number, default: null, min: 0 },
    note: { type: String, default: '', maxlength: 300 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/** One target per person per quarter — setting it again edits the same row. */
salesTargetSchema.index({ user: 1, year: 1, quarter: 1 }, { unique: true });

export const SalesTarget = mongoose.model('SalesTarget', salesTargetSchema);

/** The quarter a date falls in, as the pair every route here passes around. */
export function quarterOf(date = new Date()) {
  const at = new Date(date);
  return { year: at.getFullYear(), quarter: Math.floor(at.getMonth() / 3) + 1 };
}

/** The half-open range a quarter covers, for counting what closed inside it. */
export function quarterRange(year, quarter) {
  const from = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const to = new Date(Date.UTC(quarter === 4 ? year + 1 : year, quarter === 4 ? 0 : quarter * 3, 1));
  return { from, to };
}

export default SalesTarget;
