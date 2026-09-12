import { Notification, READ_TTL_MS, UNREAD_TTL_MS } from '../models/notification.model.js';
import { log } from '../utils/logger.js';

/**
 * Gives an end to the notifications written before they had one.
 *
 * A TTL index ignores any document whose field is missing, so without this the change would apply
 * to new instances and to nobody else — every notification an established install has accumulated
 * would sit there forever, which is the situation it exists to fix.
 *
 * Dated from when each one was created rather than from now, so the clear-out is immediate for
 * anything already old rather than starting a fresh six months for a notification from 2024. A
 * read one gets the shorter window from when it was read, and falls back to its creation date for
 * the rows that predate `readAt` being kept.
 *
 * Two `updateMany`s with an aggregation pipeline, so the arithmetic happens in the database
 * rather than by loading every row. Matches nothing once an install has been through it.
 */
export async function backfillNotificationExpiry() {
  const unread = await Notification.updateMany(
    { expiresAt: { $exists: false }, read: false },
    [{ $set: { expiresAt: { $add: ['$createdAt', UNREAD_TTL_MS] } } }]
  );
  const read = await Notification.updateMany(
    { expiresAt: { $exists: false }, read: true },
    [{ $set: { expiresAt: { $add: [{ $ifNull: ['$readAt', '$createdAt'] }, READ_TTL_MS] } } }]
  );

  const total = (unread.modifiedCount ?? 0) + (read.modifiedCount ?? 0);
  if (total) log.info(`Notifications: gave ${total} older one(s) an expiry date`);
  return total;
}

export default backfillNotificationExpiry;
