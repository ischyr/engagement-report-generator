/**
 * Chasing a client about what is still outstanding, on a link that asked to do it.
 *
 * The app already chases its own people — a booking that starts on Monday gets a reminder on
 * Friday. It has never chased anybody outside the firm, and the gap it leaves is the one every
 * retest starts in: a report went out in March, the client meant to get to it, and the first
 * anybody looks is the week before the retest in June.
 *
 * ## This is the only thing here that mails a stranger unprompted
 *
 * Which is why every rule below fails closed, and why none of them is a default:
 *
 *   - **Somebody asked for it**, on this link, when it was made. `reminder.everyDays` is zero
 *     unless a person set it.
 *   - **There is an address**, because the link was sent from here. A link somebody pasted into
 *     their own mail has nobody recorded and is never chased — the app does not know who has it.
 *   - **There is something to chase.** Everything claimed fixed means nothing is sent, and that
 *     is a stop rather than a pause.
 *   - **The client could act on it.** A withdrawn link, an expired one, a read-only one, a
 *     progress link, or a report that has since been signed off: all of them mean a reminder
 *     would be asking somebody to do something they cannot do.
 *   - **A cap.** `REMINDER_LIMIT` and then it stops for good. A fortnightly chase over a six-month
 *     link is thirteen emails, which is not a reminder — and whoever ignored the fifth was not
 *     going to answer the ninth.
 *
 * ## Idempotent, because it runs from three places
 *
 * On boot, on a daily timer, and from whatever scheduled task somebody points at it. `lastAt` on
 * the link is the marker rather than a search through sent mail, for the same reason the booking
 * sweep uses `reminderSentAt`: a chase that arrives three times is indistinguishable from spam,
 * and to the recipient it is worse, because they did not ask for any of it.
 */

import { Audit } from '../models/audit.model.js';
import { Settings } from '../models/settings.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { log } from '../utils/logger.js';
import env from '../config/env.js';
import { mailConfig, sendMail } from './mail/index.js';
import { remediationReminderEmail } from './mail/templates.js';

/**
 * How many chases one link may ever send.
 *
 * Five. Enough to cover a quarter at a fortnightly cadence, few enough that the last one still
 * reads as a reminder rather than as pressure.
 */
export const REMINDER_LIMIT = 5;

/** What is still waiting on the client, from the same fields the client's own page reads. */
export function outstandingOf(audit) {
  const findings = audit?.findings ?? [];
  const open = findings.filter((finding) => (finding.clientClaim?.status || '') !== 'fixed');
  return { total: findings.length, open: open.length, fixed: findings.length - open.length };
}

/**
 * Whether this link is due a chase, and why not when it is not.
 *
 * Separated from the sending so the reasons can be asserted one at a time — every one of them is
 * a decision to mail somebody outside the firm, and "it did not send" is not a good enough answer
 * to be able to give about any of them.
 *
 * @returns {{due: boolean, why: string, outstanding: number}}
 */
export function reminderDue(link, audit, now = new Date()) {
  const no = (why) => ({ due: false, why, outstanding: 0 });

  if (!link.reminder?.everyDays) return no('nobody asked for reminders on this link');
  if (link.revokedAt) return no('the link was withdrawn');
  if (!link.expiresAt || link.expiresAt.getTime() <= now.getTime()) return no('the link has expired');
  if (link.kind !== 'findings') return no('a progress link has nothing to chase');
  if (!link.allowUpdates) return no('a read-only link cannot be acted on');
  if (!(link.sentTo ?? []).length) return no('nobody was sent this link from here');
  if ((link.reminder.sent ?? 0) >= REMINDER_LIMIT) return no('it has been chased enough');

  if (!audit || audit.deletedAt) return no('the engagement is gone');
  if (audit.state === 'APPROVED') return no('the report is closed, so there is nothing to do');

  const { open } = outstandingOf(audit);
  if (!open) return no('everything has been claimed fixed');

  /*
   * The clock starts at the send, not at the link's creation: a link made on Monday and sent on
   * Thursday should be chased a fortnight after Thursday. Whoever was written to last is the
   * honest starting point.
   */
  const since =
    link.reminder.lastAt ??
    (link.sentTo ?? []).map((entry) => entry.at).sort((a, b) => new Date(b) - new Date(a))[0];
  if (!since) return no('nobody was sent this link from here');

  const days = (now.getTime() - new Date(since).getTime()) / 86_400_000;
  if (days < link.reminder.everyDays) return no('it is not due yet');

  return { due: true, why: '', outstanding: open };
}

/**
 * @param {{ now?: Date }} [options] `now` only for tests
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function remindOutstandingFindings({ now = new Date() } = {}) {
  const links = await ShareLink.find({
    'reminder.everyDays': { $gt: 0 },
    revokedAt: null,
    expiresAt: { $gt: now },
  }).populate({ path: 'audit', select: 'name state deletedAt company findings' });

  if (!links.length) return { sent: 0, skipped: 0 };

  const settings = await Settings.getSettings();
  const config = await mailConfig(settings);
  if (!config.enabled) {
    /* Not an error. An instance with no mail server simply does not chase anybody. */
    return { sent: 0, skipped: links.length };
  }

  let sent = 0;
  let skipped = 0;

  for (const link of links) {
    const verdict = reminderDue(link, link.audit, now);
    if (!verdict.due) {
      skipped += 1;
      continue;
    }

    /*
     * The token is not here and cannot be — only its hash is kept. So the reminder points at the
     * page rather than carrying a fresh way in, and the reader uses the link they already have.
     * Which is also the right answer for a chase: a second URL for the same thing invites somebody
     * to wonder which of them is real.
     */
    const body = remediationReminderEmail({
      appName: settings.branding?.appName || 'Engy • Report Generation',
      engagement: link.audit.name,
      clientName: link.audit.company?.name ?? '',
      outstanding: verdict.outstanding,
      expiresAt: link.expiresAt,
      remaining: REMINDER_LIMIT - (link.reminder.sent ?? 0) - 1,
      appUrl: (env.appUrl ?? '').replace(/\/$/, ''),
    });

    const to = (link.sentTo ?? []).map((person) => ({ name: person.name ?? '', email: person.email }));
    try {
      const result = await sendMail(
        { to, subject: body.subject, text: body.text, html: body.html },
        { settings, config }
      );
      if (!result.sent) {
        skipped += 1;
        continue;
      }
    } catch (error) {
      log.warn(`Remediation reminder failed for ${link._id}: ${error.message}`);
      skipped += 1;
      continue;
    }

    /*
     * Marked before anybody could ask again. A crash between sending and recording would chase the
     * same client tomorrow, which is the one failure this sweep must not have.
     */
    link.reminder.lastAt = now;
    link.reminder.sent = (link.reminder.sent ?? 0) + 1;
    await link.save();
    sent += 1;
  }

  if (sent) log.info(`Reminded ${sent} client${sent === 1 ? '' : 's'} about outstanding findings`);
  return { sent, skipped };
}

export default remindOutstandingFindings;
