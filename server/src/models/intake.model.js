import mongoose from 'mongoose';

/**
 * A questionnaire sent to a client before an engagement starts.
 *
 * The scope, the contacts, the dates and the constraints all arrive by email, get read once, and
 * are retyped into the app by whoever sets the engagement up. Two things go wrong with that: the
 * retyping loses detail, and when the scope is disputed six months later the only record of what
 * the client actually said is a mail thread in one person's inbox.
 *
 * This is the same one-time-link mechanism the password invitations use, pointed at a client
 * instead of a colleague: only a hash of the token is stored, it expires, and it can be closed.
 * What comes back is kept verbatim — the engagement is *created from* the answers rather than
 * replacing them, so the record of what was said survives everything done afterwards.
 */

const DAY = /^(\d{4}-\d{2}-\d{2})?$/;

export const INTAKE_STATUSES = ['open', 'submitted', 'used', 'cancelled'];

/**
 * What the form asks.
 *
 * A fixed set rather than a form builder. These are the questions every engagement needs
 * answered, they map onto fields the app already has, and a questionnaire whose shape varies by
 * client is one nothing downstream can read. Anything else goes in `extra`.
 */
const answersSchema = new mongoose.Schema(
  {
    /** Who filled it in — not necessarily anybody already on record as a contact. */
    contactName: { type: String, default: '', trim: true, maxlength: 160 },
    contactEmail: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
    contactPhone: { type: String, default: '', trim: true, maxlength: 60 },

    /** What they want tested, in their words. Becomes the engagement's name and type. */
    engagementName: { type: String, default: '', trim: true, maxlength: 200 },
    kind: { type: String, default: '', trim: true, maxlength: 120 },

    /** When they want it done. Days, like every other day in this app. */
    windowStart: { type: String, default: '', match: DAY },
    windowEnd: { type: String, default: '', match: DAY },

    /** One asset per line — hostnames, addresses, URLs, ranges. Parsed on the way in. */
    assets: { type: String, default: '', maxlength: 20000 },

    /**
     * What we must not do, and when we must not do it.
     *
     * The two most consequential answers on the form, and the two that are currently agreed in a
     * phone call nobody wrote down.
     */
    constraints: { type: String, default: '', maxlength: 4000 },
    testingWindowNote: { type: String, default: '', maxlength: 500 },

    /** Who to ring when something breaks, including out of hours. */
    escalationName: { type: String, default: '', trim: true, maxlength: 160 },
    escalationPhone: { type: String, default: '', trim: true, maxlength: 60 },

    extra: { type: String, default: '', maxlength: 4000 },
  },
  { _id: false }
);

const intakeSchema = new mongoose.Schema(
  {
    /** SHA-256 of the link, exactly like an account token. Nothing needs to read it back. */
    tokenHash: { type: String, required: true, unique: true, index: true },

    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    /** What to call it before there is an engagement — shown on the public page. */
    label: { type: String, default: '', trim: true, maxlength: 200 },

    status: { type: String, enum: INTAKE_STATUSES, default: 'open', index: true },
    answers: { type: answersSchema, default: () => ({}) },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /**
     * When the link stops working.
     *
     * Not a TTL index, unlike an account token: the *answers* are the point and have to outlive
     * the link that collected them. Expiry closes the door, it does not delete the record.
     */
    expiresAt: { type: Date, required: true },

    submittedAt: { type: Date, default: null },
    /** Kept for the same reason a delivery keeps its recipients: a record of a past event. */
    submittedFrom: { type: String, default: '', maxlength: 80 },

    /** The engagement built from these answers, once somebody has built it. */
    createdAudit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
  },
  { timestamps: true }
);

intakeSchema.index({ company: 1, createdAt: -1 });

export const Intake = mongoose.model('Intake', intakeSchema);
export default Intake;
