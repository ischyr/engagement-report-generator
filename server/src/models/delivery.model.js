import mongoose from 'mongoose';

/**
 * A record that a report left the building.
 *
 * The app could already say what a report *contained* and who was *meant* to receive it. It
 * could not say that anything was sent — so "which version does the client actually have",
 * asked six months later in an argument about a finding they say they never saw, had no
 * answer but somebody's memory of an email.
 *
 * Everything here is a snapshot on purpose. Recipients keep the name and address they had at
 * the time even though the contact is also referenced, because a record of a past event must
 * not change when a contact is renamed, moved to another company or deleted. A delivery
 * whose details drift is not a record, it is a guess with a timestamp.
 *
 * The hash is what makes it evidence rather than a note. Given the file and this row,
 * anybody can prove it is the same document — and, more usefully, prove that the one being
 * argued about is *not*.
 */

const CHANNELS = ['email', 'portal', 'share', 'person', 'other'];

export const DELIVERY_CHANNELS = CHANNELS;

/** A recipient as they were when the report went to them. */
const recipientSchema = new mongoose.Schema(
  {
    /** Kept when it came from the engagement's contact list, for a link back. */
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    name: { type: String, default: '', trim: true, maxlength: 160 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
  },
  { _id: false }
);

const deliverySchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    /**
     * The version the client knows it by — "1.0", "1.1 after retest", "draft 2".
     *
     * Free text rather than a number the app increments: versions are negotiated with
     * clients, sometimes skipped and sometimes lettered, and a field that insisted on
     * semantic versioning would be worked around within a week.
     */
    version: { type: String, default: '', trim: true, maxlength: 40 },

    /** When it actually went, which is not when this row was written. */
    sentAt: { type: Date, required: true },
    channel: { type: String, enum: CHANNELS, default: 'email' },

    recipients: { type: [recipientSchema], default: [] },

    filename: { type: String, default: '', trim: true, maxlength: 260 },
    /** Always SHA-256 today; named so a future algorithm cannot be mistaken for it. */
    hashAlgorithm: { type: String, default: 'sha256' },
    /** Lower-case hex. Optional: a delivery worth recording beats one skipped for want of a hash. */
    fileHash: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      match: [/^([a-f0-9]{64})?$/, 'A SHA-256 hash is 64 hexadecimal characters'],
    },
    fileSize: { type: Number, default: null, min: 0 },
    /** docx, xlsx, html, pdf — what was actually handed over, not what the template is. */
    kind: { type: String, default: '', trim: true, maxlength: 20 },

    /**
     * The engagement's content fingerprint at the moment this went out.
     *
     * The same trick a reviewer's signature uses. Without it, "has the report changed since the
     * client got version 1.0" can only be guessed from `updatedAt`, which moves when somebody
     * fixes a typo in a note — so the register would either cry stale constantly or say nothing.
     * With it the answer is exact, and it needs no second copy of the file to be exact about.
     *
     * Empty on rows written before this was kept, which the register reports as unknown rather
     * than as unchanged. An honest gap beats a reassuring guess.
     */
    contentFingerprint: { type: String, default: '' },

    note: { type: String, default: '', maxlength: 1000 },

    /** Who recorded it. Distinct from whoever pressed Generate. */
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// The engagement's own list, newest delivery first.
deliverySchema.index({ audit: 1, sentAt: -1 });
/**
 * Deliberately *not* unique, and deliberately not a TTL.
 *
 * The same file can legitimately go out twice — resent after a bounce, forwarded to a second
 * contact a week later — and each of those is a separate fact. And unlike a session or a
 * borrowed credential, this is the one collection in the app that must never expire on its
 * own: it exists to answer questions asked long after everything else has been cleaned up.
 */
deliverySchema.index({ fileHash: 1 });

export const Delivery = mongoose.model('Delivery', deliverySchema);
export default Delivery;
