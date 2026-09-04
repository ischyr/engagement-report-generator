import mongoose from 'mongoose';

/**
 * Somebody's signature on one engagement.
 *
 * Reports end with a page of names, and a name typed by whoever generated the document is not a
 * signature. This is: drawn by the person themselves, on the engagement they worked on, printed
 * into the report as an image.
 *
 * Deliberately *not* the approval record. Sign-off — who reviewed the report and whether their
 * signature is still valid for the text as it stands — is a separate thing on the Overview, with
 * fingerprints behind it. Drawing here says "this is my hand for the document"; it does not
 * approve anything, and conflating the two would put a governance meaning on a drawing.
 *
 * One per person per engagement, enforced by a unique index: signing again replaces your own
 * mark rather than accumulating versions of it.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Roughly 300 kB of base64.
 *
 * A signature drawn at screen resolution is a few kilobytes as a PNG; the ceiling is here so a
 * pasted photograph of a whole page cannot be smuggled in as one, and so the engagement document
 * this is *not* stored in stays small either way.
 */
export const MAX_SIGNATURE_BYTES = 400_000;

const signatureSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /** Whose hand it is. Nobody can create or replace anybody else's. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The drawing, as a PNG data URI.
     *
     * A data URI rather than GridFS because it is small, it is always wanted together with the
     * row, and the report pipeline already turns `<img src="data:image/png…">` into a real
     * embedded image — the same path a pasted screenshot takes.
     */
    image: {
      type: String,
      required: true,
      maxlength: MAX_SIGNATURE_BYTES,
      match: [/^data:image\/png;base64,/, 'A signature must be a PNG'],
    },

    /**
     * The name and title as they should be printed, captured at signing time.
     *
     * Snapshotted for the same reason a delivery's recipients are: a document signed in March
     * must not silently re-title somebody who was promoted in June.
     */
    name: { type: String, default: '', trim: true, maxlength: 160 },
    title: { type: String, default: '', trim: true, maxlength: 120 },
    /** What they are signing as, in the report's words: "Tested by", "Reviewed by". */
    role: { type: String, default: '', trim: true, maxlength: 80 },
    /** An optional line above the signature — an assurance statement, usually. */
    statement: { type: String, default: '', trim: true, maxlength: 500 },

    /** The day it was signed, as every day in this app is stored. */
    signedOn: { type: String, required: true, match: DAY },
    /** Kept because a signature is a claim about a moment, and a day is not a moment. */
    signedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

signatureSchema.index({ audit: 1, user: 1 }, { unique: true });

export const Signature = mongoose.model('Signature', signatureSchema);
export default Signature;
