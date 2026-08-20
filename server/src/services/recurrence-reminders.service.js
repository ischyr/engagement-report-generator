/**
 * Tells somebody that work which comes round again is coming round again.
 *
 * The annual retest, the quarterly scan: the same engagement in the same shape, created by hand,
 * remembered by one person — who eventually leaves, or is on holiday in the week it was due. The
 * failure is not that it is hard to create; it is that nobody notices it should exist.
 *
 * It nudges and stops there. An engagement appearing in the list on its own, part-filled and with
 * a team booked onto it, is a surprise nobody asked for. A notification with one button that
 * builds it from last time saves the same effort without the app making commitments on somebody's
 * behalf.
 *
 * Idempotent, the same way booking reminders are: `repeat.remindedFor` records the due date a
 * reminder has already gone out for, because the sweep runs on boot, on a timer and from a
 * scheduled task, and a reminder that arrives three times is spam.
 */

import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { membershipExpired } from '../utils/audit-scope.js';
import { log } from '../utils/logger.js';

/** How far ahead to warn. Long enough to book people and agree a window with the client. */
export const RECURRENCE_LEAD_DAYS = 30;

const dayString = (date) => date.toISOString().slice(0, 10);

/** `nextDue` advanced by the interval, as a day string. */
export function advanceDue(from, months) {
  const base = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(base.getTime()) || !months) return '';
  const target = new Date(base);
  target.setUTCMonth(target.getUTCMonth() + Number(months));
  /*
   * Month arithmetic overflows: the 31st plus one month is the 1st or 2nd of the month after.
   * Clamped back to the end of the intended month, so an engagement due on the 31st of January
   * next comes due on the 28th of February rather than the 3rd of March.
   */
  if (target.getUTCDate() !== base.getUTCDate()) target.setUTCDate(0);
  return dayString(target);
}

/** How to word it without lying about which day it is. */
function whenLabel(due, today) {
  if (due <= today) return 'is due now';
  const days = Math.round(
    (new Date(`${due}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000
  );
  if (days === 1) return 'is due tomorrow';
  if (days <= 14) return `is due in ${days} days`;
  return `is due on ${due}`;
}

/**
 * @param {{ now?: Date, days?: number }} [options] `now` only for tests
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function remindRecurringEngagements({
  now = new Date(),
  days = RECURRENCE_LEAD_DAYS,
} = {}) {
  const today = dayString(now);
  const horizon = dayString(new Date(now.getTime() + days * 86_400_000));

  const due = await Audit.find({
    deletedAt: null,
    'repeat.months': { $gt: 0 },
    'repeat.nextDue': { $gt: '', $lte: horizon },
  }).select('name reference repeat creator collaborators reviewers memberUntil');

  let sent = 0;
  let skipped = 0;

  for (const audit of due) {
    // Already told somebody about this one. The marker is the due date rather than a boolean, so
    // advancing the schedule naturally re-arms it for the next occurrence.
    if (audit.repeat.remindedFor === audit.repeat.nextDue) {
      skipped += 1;
      continue;
    }

    /*
     * The people who would actually run it: whoever created it and whoever worked on it.
     * Reviewers are left out — being asked to review something is not the same as being told to
     * schedule it, and this is a scheduling nudge.
     */
    const candidates = [audit.creator, ...(audit.collaborators ?? [])]
      .map((person) => person?._id ?? person)
      .filter(Boolean);

    const recipients = [...new Set(candidates.map(String))].filter(
      // Somebody whose access to the engagement has run out cannot open it, so a notification
      // pointing at it would be a link to a 403.
      (id) => !membershipExpired(audit, { _id: id, role: 'user' })
    );

    if (!recipients.length) {
      skipped += 1;
      continue;
    }

    const label = audit.reference ? `${audit.name} (${audit.reference})` : audit.name;
    await Notification.insertMany(
      recipients.map((id) => ({
        user: id,
        type: 'engagement-due',
        audit: audit._id,
        auditName: audit.name,
        message: `The next ${label} ${whenLabel(audit.repeat.nextDue, today)}`,
        href: `/engagements/${audit._id}?tab=overview`,
      })),
      { ordered: false }
    );

    audit.repeat.remindedFor = audit.repeat.nextDue;
    await audit.save();
    sent += recipients.length;
  }

  return { sent, skipped };
}

/** Wrapped so a failing sweep never takes the process with it. */
export async function sweepRecurringEngagements() {
  try {
    const { sent } = await remindRecurringEngagements();
    if (sent > 0) log.info(`Told ${sent} person(s) about an engagement due to come round again.`);
  } catch (error) {
    log.warn(`Recurring engagement sweep skipped: ${error.message}`);
  }
}

export default remindRecurringEngagements;
