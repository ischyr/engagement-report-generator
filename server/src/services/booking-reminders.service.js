/**
 * Tells people about the time they promised, before it starts.
 *
 * Bookings and notifications have both existed for a while and had never met: the Schedule knew
 * somebody was on Northwind from Monday and nothing ever said so. The failure this prevents is
 * not a double-booking — the calendar already shows those — it is surprise.
 *
 * Idempotent by design. `reminderSentAt` on the booking is the marker rather than a search
 * through notifications, because the sweep runs on boot, on a timer, and from a scheduled task,
 * and a reminder that arrives three times is indistinguishable from spam.
 */

import { Booking } from '../models/booking.model.js';
import { Notification } from '../models/notification.model.js';
import { Audit } from '../models/audit.model.js';
import { membershipExpired } from '../utils/audit-scope.js';
import { clashingLeave, describeClash } from './leave.service.js';
import { log } from '../utils/logger.js';

/** How far ahead to look. Two days catches "starts on Monday" from a Friday afternoon. */
export const REMINDER_DAYS = 2;

const dayString = (date) => date.toISOString().slice(0, 10);

/** How to word "starting soon" without lying about which day it is. */
function whenLabel(start, today) {
  if (start <= today) return 'today';
  const tomorrow = dayString(new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000));
  if (start === tomorrow) return 'tomorrow';
  return `on ${start}`;
}

/**
 * @param {{ now?: Date, days?: number }} [options] `now` only for tests
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function remindUpcomingBookings({ now = new Date(), days = REMINDER_DAYS } = {}) {
  const today = dayString(now);
  const horizon = dayString(new Date(now.getTime() + days * 86_400_000));

  /*
   * Bookings that start inside the window and have never been reminded about.
   *
   * Compared as `yyyy-mm-dd` strings like every day in this app, so a booking is not "starting
   * tomorrow" in one timezone and "today" in another. A booking already under way is left
   * alone: telling somebody about work they are doing is noise.
   */
  const due = await Booking.find({
    start: { $gte: today, $lte: horizon },
    reminderSentAt: null,
  }).populate({ path: 'audit', select: 'name reference deletedAt creator collaborators reviewers memberUntil' });

  let sent = 0;
  let skipped = 0;

  for (const booking of due) {
    const audit = booking.audit;
    // A booking on a trashed engagement is not work anybody should be reminded to do.
    if (!audit || audit.deletedAt) {
      skipped += 1;
      booking.reminderSentAt = now;
      await booking.save({ validateBeforeSave: false });
      continue;
    }

    /*
     * Nor is a booking on an engagement this person can no longer open — access with an end
     * date exists, and a reminder to do work you have been locked out of is worse than silence.
     */
    if (membershipExpired(audit, { _id: booking.user, role: 'user' }, today)) {
      skipped += 1;
      booking.reminderSentAt = now;
      await booking.save({ validateBeforeSave: false });
      continue;
    }

    const where = audit.reference || audit.name;
    /*
     * If the days are also booked as time off, that is the headline, not a footnote — it is
     * the one thing about a reminder that needs acting on before the day arrives. Said in
     * the same notice rather than a second one, so the bell keeps its meaning.
     */
    const clash = describeClash(await clashingLeave(booking.user, booking.start, booking.end), 'You');

    await Notification.create({
      user: booking.user,
      type: 'booking-soon',
      audit: audit._id,
      auditName: audit.name ?? '',
      target: where,
      message: `You are booked on ${where} ${whenLabel(booking.start, today)}${
        booking.note ? ` — ${booking.note}` : ''
      }${clash ? ` · ${clash}` : ''}`,
      href: '/schedule',
    });

    booking.reminderSentAt = now;
    await booking.save({ validateBeforeSave: false });
    sent += 1;
  }

  return { sent, skipped };
}

/**
 * The same sweep, wrapped for startup and for a timer.
 *
 * Never allowed to take the server down with it: a reminder nobody gets is a nuisance, and a
 * process that will not boot because of one is an outage.
 */
export async function sweepBookingReminders() {
  try {
    const { sent } = await remindUpcomingBookings();
    if (sent > 0) log.info(`Reminded ${sent} person(s) about a booking starting soon.`);
  } catch (error) {
    log.warn(`Booking reminder sweep skipped: ${error.message}`);
  }
}

export default remindUpcomingBookings;
