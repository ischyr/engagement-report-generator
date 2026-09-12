import mongoose from 'mongoose';

export const NOTIFICATION_TYPES = [
  'mention',
  'review-requested',
  'comment-on-your-finding',
  'check-assigned',
  'finding-assigned',
  'new-sign-in',
  'booking-soon',
  'booking-changed',
  'leave-requested',
  'leave-decided',
  'engagement-due',
  'engagement-held',
  'account-awaiting-approval',
  'account-approved',
  /* The only one raised by somebody with no account: a client, through their own link. */
  'client-updated-finding',
  /* They asked us something, which is the half of that conversation nothing carried. */
  'client-asked-question',
];

/** How long an unread notification is kept: long enough to survive a long leave. */
export const UNREAD_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** And how long after being read, which is a different and much shorter question. */
export const READ_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Something one person needs another to see.
 *
 * Stored per recipient rather than derived from the activity log: read state is
 * personal, and "what have I not seen yet" has to be answerable with one indexed
 * query rather than by replaying history.
 */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
    /** Denormalised so a notification still reads sensibly if the audit is gone. */
    auditName: { type: String, default: '' },

    /** Where in the engagement, e.g. a finding id and its title. */
    findingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    target: { type: String, default: '' },

    message: { type: String, default: '' },
    /** Client route to open when clicked. */
    href: { type: String, default: '' },

    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },

    /**
     * When Mongo may drop it.
     *
     * This collection had no end. A notification is an interruption — somebody mentioned you,
     * somebody gave you a finding — and it is useful for days; the row sat in the database for
     * years. There was a button to clear the ones you had read and nothing that happened on its
     * own, so an account three years old carried every "you were mentioned" it had ever received
     * into every query that touched the collection.
     *
     * Two windows rather than one, because read and unread are different states of the same
     * thing. An unread notification is something you have not seen, so it gets six months —
     * comfortably past any instance of somebody coming back from a long leave. A read one is
     * finished with, and goes a month later.
     *
     * Nothing is lost by either. The activity log is the permanent record of what happened on an
     * engagement; this is only the part that says *you* should look.
     */
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + UNREAD_TTL_MS),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

// The bell asks "my unread, newest first" on every poll.
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
