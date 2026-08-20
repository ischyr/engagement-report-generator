/**
 * What one person needs to see when they open the app.
 *
 * The dashboard used to be instance-wide totals and a list of recent engagements — true, and not
 * about the reader. The Inbox answers "what have people asked of me"; nothing answered the other
 * half, which is *what am I in the middle of*: where I am booked, which checks are mine, which of
 * my findings have no evidence yet, and which days I was booked for but never logged.
 *
 * Assembled here rather than in the browser because it is six queries against data the client
 * deliberately does not receive — the engagements list omits findings, and it should stay that way.
 */

import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { TimeEntry } from '../models/time-entry.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { findingSeverity } from './cvss.js';
import { attentionRank, attentionReasons, engagementHealth } from './engagement-health.service.js';
import { isWeekend } from './leave.service.js';
import { activityCalendar } from './activity-calendar.service.js';
import { deliveryRegister } from './delivery-register.service.js';
import { kitHealthFor } from './kit.service.js';

/** How far forward "coming up" looks. Two weeks is the horizon people actually plan in. */
const AHEAD_DAYS = 14;
/** And how far back to look for days somebody was booked and never logged. */
const BEHIND_DAYS = 14;

const dayString = (date) => date.toISOString().slice(0, 10);
const shift = (day, count) =>
  dayString(new Date(new Date(`${day}T00:00:00Z`).getTime() + count * 86_400_000));

const auditRef = (audit) => ({
  _id: audit._id,
  name: audit.name,
  reference: audit.reference ?? '',
  state: audit.state,
  onHold: Boolean(audit.onHold),
});

/**
 * Everything on one screen, for one person.
 *
 * @param {object} user the reader — everything below is scoped to them, not to the instance
 * @param {{ now?: Date }} [options] `now` only for tests
 */
export async function dashboardFor(user, { now = new Date() } = {}) {
  const today = dayString(now);
  const horizon = shift(today, AHEAD_DAYS);
  const since = shift(today, -BEHIND_DAYS);

  /*
   * One read of the engagements this person can see, reused for everything below.
   *
   * Findings and checks are projected down to the three fields that are actually counted —
   * the same discipline the engagements list applies, and for the same reason: the alternative
   * is megabytes of HTML crossing the wire to produce a number.
   */
  const audits = await Audit.find(visibleAuditFilter(user))
    .select(
      'name reference state date_end updatedAt createdAt onHold holds company repeat ' +
        'findings._id findings.title findings.cvssv3 findings.severityOverride ' +
        'findings.evidenceCount findings.createdBy findings.remediationStatus ' +
        'testChecks._id testChecks.title testChecks.category testChecks.done ' +
        'testChecks.blocked testChecks.assignedTo tags'
    )
    .populate({ path: 'company', select: 'name' })
    .sort({ updatedAt: -1 })
    .lean();

  const mineId = String(user._id);

  /* ------------------------------------------------------------------ my work */
  const myChecks = [];
  const myFindingsWithoutEvidence = [];

  for (const audit of audits) {
    // An approved engagement is finished; listing its loose ends as work is noise.
    if (audit.state === 'APPROVED') continue;

    for (const check of audit.testChecks ?? []) {
      // A blocked check is not work you can do today; it is waiting on somebody else.
      if (check.done || check.blocked) continue;
      if (String(check.assignedTo ?? '') !== mineId) continue;
      myChecks.push({
        _id: check._id,
        title: check.title,
        category: check.category ?? '',
        audit: auditRef(audit),
      });
    }

    for (const finding of audit.findings ?? []) {
      if (finding.evidenceCount > 0) continue;
      if (String(finding.createdBy ?? '') !== mineId) continue;
      const rated = findingSeverity(finding);
      myFindingsWithoutEvidence.push({
        _id: finding._id,
        title: finding.title,
        severity: rated.severity,
        score: rated.score,
        audit: auditRef(audit),
      });
    }
  }

  // Worst first: a critical with no screenshot is a different problem from an informational one.
  myFindingsWithoutEvidence.sort((a, b) => b.score - a.score);

  /* ------------------------------------------------------------ where I am booked */
  const visible = new Map(audits.map((audit) => [String(audit._id), audit]));

  const bookings = await Booking.find({
    user: user._id,
    end: { $gte: since },
    start: { $lte: horizon },
  })
    .select('audit start end')
    .sort({ start: 1 })
    .lean();

  const mine = bookings.filter((booking) => visible.has(String(booking.audit)));

  const upcoming = mine
    .filter((booking) => booking.end >= today)
    .map((booking) => ({
      start: booking.start,
      end: booking.end,
      /** True for the one you are on right now, which is the only one you can act on today. */
      current: booking.start <= today && booking.end >= today,
      audit: auditRef(visible.get(String(booking.audit))),
    }));

  /* ------------------------------------------------- days booked and never logged */
  const logged = new Set(
    (
      await TimeEntry.find({ user: user._id, day: { $gte: since, $lte: today } })
        .select('day')
        .lean()
    ).map((entry) => entry.day)
  );

  /*
   * Working days in the past fortnight that were booked and have no hours against them.
   *
   * Weekends are skipped, and so is today — a day you are still working is not a day you failed
   * to log. The effort figure the report prints is built from these entries, so the gap is worth
   * a nudge rather than a silent zero.
   */
  const unloggedDays = [];
  for (const booking of mine) {
    for (let day = booking.start; day <= booking.end; day = shift(day, 1)) {
      if (day < since || day >= today) continue;
      if (isWeekend(day) || logged.has(day) || unloggedDays.includes(day)) continue;
      unloggedDays.push(day);
    }
  }
  unloggedDays.sort();

  /* ------------------------------------------------------------ needs attention */
  /*
   * Kit facts for every engagement in one query, rather than one per engagement. Where a physical
   * thing has got to is a real reason to look at a job, and it is the only one that needs a read
   * outside the projection above.
   */
  const kitByAudit = await kitHealthFor(
    audits.map((audit) => audit._id),
    { now }
  );

  const attention = audits
    .filter((audit) => audit.state !== 'APPROVED')
    .map((audit) => {
      const health = engagementHealth(audit, {
        now,
        kit: kitByAudit.get(String(audit._id)) ?? null,
      });
      const reasons = attentionReasons(audit, health);
      return { audit: auditRef(audit), company: audit.company?.name ?? '', health, reasons };
    })
    .filter((row) => row.reasons.length)
    .sort((a, b) => attentionRank(b.reasons) - attentionRank(a.reasons))
    .slice(0, 8);

  /* --------------------------------------------------------------- coming round */
  const due = audits
    .filter((audit) => audit.repeat?.months && audit.repeat?.nextDue)
    .filter((audit) => audit.repeat.nextDue <= shift(today, 60))
    .map((audit) => ({
      audit: auditRef(audit),
      company: audit.company?.name ?? '',
      nextDue: audit.repeat.nextDue,
      overdue: audit.repeat.nextDue < today,
    }))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .slice(0, 5);

  /* -------------------------------------------------- your rhythm, and what went out */
  /*
   * Two reads that are nothing to do with the loops above, so they go in parallel.
   *
   * The heatmap is *yours*: the whole team's is admin-only, because a calendar of everybody's
   * hours is a management view — but your own is the version that belongs on a front page. The
   * register call is scoped by the same rule every list uses, so the deliveries shown are the
   * ones from engagements this person can see.
   */
  const [activity, register] = await Promise.all([
    activityCalendar({ actor: user, days: 120 }),
    deliveryRegister(user, { limit: 5 }),
  ]);

  /* ------------------------------------------------------------------- the totals */
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  let findingCount = 0;
  let openSerious = 0;
  for (const audit of audits) {
    for (const finding of audit.findings ?? []) {
      const { severity } = findingSeverity(finding);
      const key = severity === 'None' ? 'none' : severity.toLowerCase();
      if (key in severityCounts) severityCounts[key] += 1;
      findingCount += 1;
      if ((severity === 'Critical' || severity === 'High') && finding.remediationStatus !== 'fixed') {
        openSerious += 1;
      }
    }
  }

  return {
    totals: {
      engagements: audits.length,
      open: audits.filter((audit) => audit.state !== 'APPROVED').length,
      onHold: audits.filter((audit) => audit.onHold).length,
      findings: findingCount,
      severityCounts,
      /** Critical and High that nobody has fixed — the one number worth a colour. */
      openSerious,
    },
    mine: {
      bookings: upcoming,
      checks: myChecks.slice(0, 8),
      checksTotal: myChecks.length,
      findings: myFindingsWithoutEvidence.slice(0, 6),
      findingsTotal: myFindingsWithoutEvidence.length,
      unloggedDays,
      /** So the page can say "nothing needs you" rather than showing four empty lists. */
      clear:
        upcoming.length === 0 &&
        myChecks.length === 0 &&
        myFindingsWithoutEvidence.length === 0 &&
        unloggedDays.length === 0,
    },
    attention,
    due,
    /** Only the days, for the heatmap — the rest of the calendar payload is an admin page's. */
    activity: { days: activity.days ?? [], total: activity.total ?? 0 },
    deliveries: register.deliveries ?? [],
  };
}

export default dashboardFor;
