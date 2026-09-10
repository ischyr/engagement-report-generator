/**
 * Whether the people you are about to ask for a review are actually around.
 *
 * Three things already existed and had never been introduced to each other: an engagement has
 * reviewers, the schedule knows who is on leave, and moving to review sends a notification. So
 * you could hand a report to your only reviewer on the Friday afternoon their fortnight off
 * begins, and the only feedback was silence — a week of a finished engagement sitting still,
 * discovered by somebody asking why sign-off had not happened.
 *
 * This answers the question before the request rather than after: who is available in the next
 * few working days, who is not, when they are back, and whether anybody's access to this
 * engagement runs out before they could even open it.
 *
 * It never refuses. The same rule the schedule applies to overlapping bookings: a tool that
 * declines to record reality gets worked around, and a lead who knows their reviewer is away and
 * wants to queue the request anyway is not making a mistake.
 */

import { Leave } from '../models/leave.model.js';
import { Booking } from '../models/booking.model.js';
import { User } from '../models/user.model.js';
import {
  EVERYONE,
  availableDaysFor,
  clashingLeave,
  describeClash,
  daysIn,
  isWeekend,
  leaveDayMap,
  weekdaysBetween,
} from './leave.service.js';
import { membershipExpired, today } from '../utils/audit-scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayString = (date) => date.toISOString().slice(0, 10);
const addDays = (day, count) => dayString(new Date(new Date(`${day}T00:00:00Z`).getTime() + count * DAY_MS));

/**
 * How far ahead "can they look at this" means.
 *
 * A working week. Long enough that a day of leave or a public holiday does not read as a crisis,
 * short enough to be about *this* request: a reviewer who is free in three weeks is not available
 * for a report that is finished now.
 */
export const REVIEW_HORIZON_DAYS = 5;

/** How far past the window to look for the day somebody comes back. */
const RETURN_LOOKAHEAD_DAYS = 60;

/**
 * The next `days` working days, starting from the next working day.
 *
 * Weekends are skipped at both ends rather than counted and then discounted: asking on a Friday
 * evening should produce Monday-to-Friday, not a window that has already spent two of its five
 * days on a weekend nobody was going to work anyway.
 */
export function reviewWindow(from = today(), days = REVIEW_HORIZON_DAYS) {
  let start = from;
  while (isWeekend(start)) start = addDays(start, 1);

  let end = start;
  let counted = 1;
  while (counted < days) {
    end = addDays(end, 1);
    if (!isWeekend(end)) counted += 1;
  }
  return { from: start, to: end };
}

/** The first working day in a range on which this person owes nothing to a holiday. */
function firstFreeDay(userId, from, to, dayMap) {
  const everyone = dayMap.get(EVERYONE) ?? new Map();
  const mine = dayMap.get(String(userId)) ?? new Map();
  for (const day of daysIn(from, to, from, to)) {
    if (isWeekend(day)) continue;
    // A half day still counts as a day they are at work, which is enough to read a report.
    if (Math.max(everyone.get(day) ?? 0, mine.get(day) ?? 0) < 1) return day;
  }
  return null;
}

/**
 * Reviewer by reviewer: can they look at this, and if not, when.
 *
 * The reviewers are read here rather than taken from the caller's populate: expiry depends on a
 * reviewer's `role`, which most of the routes that load an engagement do not select, and a
 * service that silently reports every admin as expired because a field was missing is worse than
 * one that costs an extra query.
 *
 * @param {object} audit a loaded engagement — `reviewers` may be ids or documents
 * @param {string} [from] first day to consider, defaulting to the next working day
 * @param {string} [asOf] the day to judge access expiry against
 */
export async function reviewReadiness({ audit, from, asOf = today() }) {
  const window = reviewWindow(from ?? asOf);
  const workingDays = weekdaysBetween(window.from, window.to);

  const reviewerIds = (audit.reviewers ?? [])
    .map((person) => person?._id ?? person)
    .filter(Boolean);
  const reviewers = reviewerIds.length
    ? await User.find({ _id: { $in: reviewerIds } }).select('username firstname lastname roles')
    : [];

  if (reviewers.length === 0) {
    return {
      ...window,
      workingDays,
      reviewers: [],
      counts: { total: 0, available: 0, partly: 0, away: 0, expired: 0 },
      /** No reviewers at all is a different problem, and saying so is more use than a warning. */
      noReviewers: true,
      stalled: false,
      summary: 'Nobody is set as a reviewer on this engagement, so a review request reaches no one.',
    };
  }

  const ids = reviewers.map((person) => person._id);
  const lookaheadTo = addDays(window.to, RETURN_LOOKAHEAD_DAYS);

  const [leaves, bookings] = await Promise.all([
    /*
     * Out past the window, so "back on the 19th" can be answered rather than left as
     * "away for all of it" — which tells a lead nothing they can plan around.
     */
    Leave.find({
      $or: [{ user: { $in: ids } }, { user: null }],
      start: { $lte: lookaheadTo },
      end: { $gte: window.from },
    }).select('user start end type portion status'),
    /* Context only. Being booked does not stop you reading a report; see below. */
    Booking.find({
      user: { $in: ids },
      start: { $lte: window.to },
      end: { $gte: window.from },
    }).select('user start end'),
  ]);

  /*
   * Two views of the same leave, on purpose.
   *
   * The arithmetic uses approved leave only — an unapproved request is not yet a fact, and
   * counting it would understate somebody's availability on the strength of a form. The
   * sentence comes from `describeClash`, which deliberately includes requested leave and says
   * so in words, because "asked for a fortnight off" is exactly what a lead should see before
   * handing them a deadline.
   */
  const dayMap = leaveDayMap(leaves, window.from, window.to);
  const returnMap = leaveDayMap(leaves, window.from, lookaheadTo);

  const bookedDaysFor = (id) => {
    const days = new Set();
    for (const booking of bookings) {
      if (String(booking.user) !== String(id)) continue;
      for (const day of daysIn(booking.start, booking.end, window.from, window.to)) {
        if (!isWeekend(day)) days.add(day);
      }
    }
    return days.size;
  };

  const rows = await Promise.all(
    reviewers.map(async (person) => {
      const id = person._id;
      const { available, off } = availableDaysFor(id, window.from, window.to, dayMap);
      const clashes = await clashingLeave(id, window.from, window.to);

      /*
       * Access that runs out mid-window is its own trap, and a quieter one than leave: the
       * request arrives, the reviewer means to get to it on Thursday, and by Thursday the
       * engagement has vanished from their list.
       */
      const entry = (audit.memberUntil ?? []).find(
        (row) => String(row.user?._id ?? row.user ?? '') === String(id)
      );
      const until = entry?.until ?? null;
      const isAdmin = person.role === 'admin';
      const expiresInWindow = Boolean(
        until && !isAdmin && until >= window.from && until < window.to
      );

      return {
        _id: id,
        username: person.username ?? '',
        firstname: person.firstname ?? '',
        lastname: person.lastname ?? '',
        availableDays: available,
        awayDays: off,
        workingDays,
        /** No working day left at all in the window. */
        away: available === 0,
        /** Around, but with less of the week than it looks. */
        partly: available > 0 && off > 0,
        // Their name rather than a pronoun: nobody's pronouns are recorded here, the sentence
        // is read on its own in a tooltip, and "Priya Nair already has" needs no antecedent.
        clash: describeClash(clashes, personName(person)),
        /** The day they could actually pick it up, looked for past the window. */
        backOn: available === 0 ? firstFreeDay(id, window.from, lookaheadTo, returnMap) : null,
        accessExpired: membershipExpired(audit, { _id: id, role: person.role }, asOf),
        accessExpiresOn: expiresInWindow ? until : null,
        /** Reported, never counted against them. */
        bookedDays: bookedDaysFor(id),
      };
    })
  );

  const blocked = (row) => row.away || row.accessExpired;
  const counts = {
    total: rows.length,
    available: rows.filter((row) => !blocked(row) && !row.partly).length,
    partly: rows.filter((row) => !blocked(row) && row.partly).length,
    away: rows.filter((row) => row.away && !row.accessExpired).length,
    expired: rows.filter((row) => row.accessExpired).length,
  };

  /** Every reviewer unreachable is the case this whole service exists for. */
  const stalled = rows.every(blocked);

  return {
    ...window,
    workingDays,
    reviewers: rows,
    counts,
    noReviewers: false,
    stalled,
    summary: summarise(rows, counts, stalled),
    /** The first day anybody who is away could pick it up — a day, for the caller to format. */
    soonestBackOn:
      rows
        .filter((row) => row.backOn)
        .map((row) => row.backOn)
        .sort()[0] ?? null,
    /** True when there is anything at all worth interrupting somebody about. */
    worthSaying: stalled || counts.away > 0 || counts.expired > 0 || rows.some((r) => r.accessExpiresOn),
  };
}

const nameOf = (row) =>
  [row.firstname, row.lastname].filter(Boolean).join(' ') || row.username || 'A reviewer';

/** The same rule for a user document, before it has been shaped into a row. */
const personName = (person) =>
  [person.firstname, person.lastname].filter(Boolean).join(' ') || person.username || 'They';

/**
 * One sentence, worded for a dialog and for a toast, so the two cannot disagree.
 *
 * Deliberately free of dates. A `yyyy-mm-dd` dropped into English prose reads as machine output
 * next to a UI that writes "24 Aug 2026" everywhere else, and this server has no idea which
 * format the reader wants. The days come back as their own fields — `backOn` per person,
 * `soonestBackOn` for the set — and whoever renders the sentence formats them.
 */
function summarise(rows, counts, stalled) {
  if (stalled) {
    return counts.total === 1
      ? `${nameOf(rows[0])} cannot look at this in the next working week.`
      : `None of the ${counts.total} reviewers can look at this in the next working week.`;
  }
  const expired = rows.filter((row) => row.accessExpired);
  const away = rows.filter((row) => row.away && !row.accessExpired);
  const expiring = rows.filter((row) => row.accessExpiresOn);

  const parts = [];
  if (away.length) {
    parts.push(
      `${away.map(nameOf).join(' and ')} ${
        away.length === 1 ? 'is' : 'are'
      } away for all of it`
    );
  }
  if (expired.length) {
    parts.push(
      `${expired.map(nameOf).join(' and ')} no longer ${
        expired.length === 1 ? 'has' : 'have'
      } access to this engagement`
    );
  }
  if (expiring.length) {
    parts.push(
      `${expiring.map(nameOf).join(' and ')} ${
        expiring.length === 1 ? 'loses' : 'lose'
      } access to it partway through`
    );
  }
  if (!parts.length) return null;

  const rest = counts.available + counts.partly;
  return `${parts.join('; ')}. ${
    rest === 1 ? 'One other reviewer is' : `${rest} other reviewers are`
  } around.`;
}

export default reviewReadiness;
