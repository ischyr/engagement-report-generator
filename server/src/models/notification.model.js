import mongoose from 'mongoose';

export const NOTIFICATION_TYPES = [
  'mention',
  'review-requested',
  'comment-on-your-finding',
  'check-assigned',
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
];

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
  },
  { timestamps: true }
);

// The bell asks "my unread, newest first" on every poll.
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
