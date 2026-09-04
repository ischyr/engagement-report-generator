/**
 * Turning leave rows into the numbers other things need.
 *
 * Two questions, asked from three places, which is why they live here rather than in a
 * route: "who is away on this day" (the calendar, and booking somebody over their own
 * holiday) and "how many days was this person actually available" (utilisation, which was
 * measured against plain weekdays and therefore wrong for anybody who takes holiday).
 */

import { Leave, dayWeight, ALLOWANCE_TYPES } from '../models/leave.model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayString = (date) => date.toISOString().slice(0, 10);

/** The key public-holiday rows are grouped under: they belong to everybody, not to a user. */
export const EVERYONE = '*';

/** Whether a `yyyy-mm-dd` is a Saturday or Sunday, without going near a local timezone. */
export function isWeekend(day) {
  const at = new Date(`${day}T00:00:00Z`).getUTCDay();
  return at === 0 || at === 6;
}

/** Every day a range covers, clipped to a window. Strings in, strings out. */
export function daysIn(start, end, from, to) {
  const first = from && start < from ? from : start;
  const last = to && end > to ? to : end;
  const days = [];
  if (first > last) return days;
  for (let at = new Date(`${first}T00:00:00Z`); dayString(at) <= last; at = new Date(at.getTime() + DAY_MS)) {
    days.push(dayString(at));
  }
  return days;
}

/** Weekdays in a window — the denominator before anybody's leave is taken off it. */
export function weekdaysBetween(from, to) {
  return daysIn(from, to, from, to).filter((day) => !isWeekend(day)).length;
}

/**
 * Approved leave in a window, as day → weight per person.
 *
 * A map of days rather than a count, because the same day can be claimed twice — a person's
 * own holiday landing on a public holiday, or a half day recorded on both sides of a change
 * of mind — and adding those up would take more days off somebody's availability than exist.
 * Whichever claim is larger wins the day.
 *
 * Weekends are dropped here rather than by the caller: leave booked across a weekend is
 * normal (a fortnight is ten working days and fourteen dates), and counting Saturday would
 * make a holiday cost more than the week contains.
 */
export function leaveDayMap(leaves, from, to) {
  const byUser = new Map();
  for (const leave of leaves) {
    if (leave.status !== 'approved') continue;
    const key = leave.user ? String(leave.user?._id ?? leave.user) : EVERYONE;
    if (!byUser.has(key)) byUser.set(key, new Map());
    const days = byUser.get(key);
    const weight = dayWeight(leave);
    for (const day of daysIn(leave.start, leave.end, from, to)) {
      if (isWeekend(day)) continue;
      days.set(day, Math.max(days.get(day) ?? 0, weight));
    }
  }
  return byUser;
}

/**
 * Working days this person actually had, given the leave in the window.
 *
 * Public holidays come off everybody, and a person's own leave on a public holiday costs
 * them nothing extra — the day was already gone. That is the whole reason both live in one
 * collection and are resolved together here.
 */
export function availableDaysFor(userId, from, to, dayMap) {
  const everyone = dayMap.get(EVERYONE) ?? new Map();
  const mine = dayMap.get(String(userId)) ?? new Map();
  let available = 0;
  let off = 0;
  for (const day of daysIn(from, to, from, to)) {
    if (isWeekend(day)) continue;
    const taken = Math.min(1, Math.max(everyone.get(day) ?? 0, mine.get(day) ?? 0));
    off += taken;
    available += 1 - taken;
  }
  return { available: Math.round(available * 2) / 2, off: Math.round(off * 2) / 2 };
}

/**
 * Leave that collides with a proposed booking.
 *
 * Requested as well as approved: somebody who has *asked* for a fortnight off is not a
 * person to quietly book, and the answer is more useful before the decision than after.
 * Never refused, only reported — the same rule the schedule already applies to overlapping
 * bookings, because a scheduler that refuses to record reality gets worked around.
 */
export async function clashingLeave(userId, start, end) {
  const rows = await Leave.find({
    status: { $in: ['requested', 'approved'] },
    $or: [{ user: userId }, { user: null }],
    start: { $lte: end },
    end: { $gte: start },
  }).select('user start end type portion status');

  return rows.map((row) => ({
    _id: row._id,
    type: row.type,
    status: row.status,
    start: row.start,
    end: row.end,
    portion: row.portion,
    /** Weekdays of this leave that the booking actually covers. */
    days: daysIn(row.start, row.end, start, end).filter((day) => !isWeekend(day)).length,
    everyone: !row.user,
  }));
}

/**
 * One sentence about a clash, or null — worded for a toast and for a notification.
 *
 * Built here so the two cannot describe the same clash differently.
 */
export function describeClash(clashes, who = 'They') {
  const real = (clashes ?? []).filter((clash) => clash.days > 0);
  if (real.length === 0) return null;

  const holidays = real.filter((clash) => clash.everyone);
  const personal = real.filter((clash) => !clash.everyone);

  const parts = [];
  for (const clash of personal) {
    const label = clash.type === 'public-holiday' ? 'a public holiday' : clash.type;
    parts.push(
      `${clash.days} day${clash.days === 1 ? '' : 's'} of ${label}${
        clash.status === 'requested' ? ' (requested, not yet approved)' : ''
      }`
    );
  }
  if (holidays.length) {
    const days = holidays.reduce((sum, clash) => sum + clash.days, 0);
    parts.push(`${days} public holiday${days === 1 ? '' : 's'}`);
  }
  /*
   * The verb agrees with the subject, which is `who` — not with how many clashes there are.
   * It used to agree with the clash count, so the default subject produced "They already has",
   * and a name with two clashes produced "Priya already have".
   */
  const plural = /^(they|we|you)$/i.test(who.trim());
  return `${who} already ${plural ? 'have' : 'has'} ${parts.join(' and ')} in that range.`;
}

/**
 * How much of the year's allowance somebody has used.
 *
 * Only the types that draw it down, and only what has been approved or is still pending —
 * a declined request is not a day off. Pending is reported separately rather than folded in,
 * because "you have five days left" that silently assumes an unapproved request would be a
 * promise the app cannot keep.
 */
export async function allowanceUsage(userId, year, allowanceDays) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = await Leave.find({
    user: userId,
    type: { $in: ALLOWANCE_TYPES },
    status: { $in: ['requested', 'approved'] },
    start: { $lte: to },
    end: { $gte: from },
  }).select('start end status portion type');

  let taken = 0;
  let pending = 0;
  for (const row of rows) {
    const days = daysIn(row.start, row.end, from, to).filter((day) => !isWeekend(day)).length;
    const cost = row.portion === 'full' ? days : days * 0.5;
    if (row.status === 'approved') taken += cost;
    else pending += cost;
  }

  const allowance = Number.isFinite(allowanceDays) ? allowanceDays : null;
  return {
    year,
    allowance,
    taken: Math.round(taken * 2) / 2,
    pending: Math.round(pending * 2) / 2,
    /** Null when no allowance is configured: "unknown" and "none left" are different answers. */
    remaining: allowance === null ? null : Math.round((allowance - taken) * 2) / 2,
  };
}

export default leaveDayMap;
