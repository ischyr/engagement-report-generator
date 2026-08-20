/**
 * Sends the "your booking starts soon" reminders.
 *
 *   npm run remind:bookings
 *
 * The server already does this on boot and once a day while it is up. This exists for the
 * instance left running for a fortnight, or one started fresh each morning by a scheduled task —
 * the sweep is idempotent, so running it from both costs nothing.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { remindUpcomingBookings, REMINDER_DAYS } from '../services/booking-reminders.service.js';
import { log } from '../utils/logger.js';

await connectDatabase();

const { sent, skipped } = await remindUpcomingBookings();
log.info(
  `Looked ${REMINDER_DAYS} day(s) ahead: reminded ${sent}, skipped ${skipped} (trashed engagement, or access that has ended).`
);

await disconnectDatabase();
