/**
 * Who is free, and who is free *and* able — the join nothing in this app made.
 *
 * Three facts existed separately: what people can do (Skills), what they have promised
 * (bookings), and when they are away (leave). Staffing an engagement still meant opening two
 * pages and doing the overlap in your head, which is exactly the kind of arithmetic that ends
 * with somebody booked into their own holiday.
 *
 * One deliberate decision runs through the whole file. **Availability is counted over every
 * booking in the instance, not only the ones the reader may see.** Bookings are scoped to
 * engagements you are on, and a scheduler that says somebody is free because you cannot see
 * the job they are on is worse than no scheduler at all. What *is* scoped is the label: a
 * booking on an engagement you cannot open shows as "another engagement", which tells you the
 * day is taken without telling you whose client it is.
 */

import { Booking } from '../models/booking.model.js';
import { Leave } from '../models/leave.model.js';
import { User, WORKING_ROLES } from '../models/user.model.js';
import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { leaveDayMap, daysIn, isWeekend, weekdaysBetween, EVERYONE } from './leave.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayString = (date) => date.toISOString().slice(0, 10);

/** Four steps, in order, so "deepest first" means the same thing here as on the Skills page. */
const LEVEL_RANK = { learning: 1, working: 2, strong: 3, expert: 4 };
const isDeep = (level) => level === 'strong' || level === 'expert';

const nameOf = (person) =>
  [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username || 'Somebody';

/** Today, as the day strings everything in this app compares. */
export const today = () => dayString(new Date());

/** `from` defaults to today and the window is capped, so one request cannot scan a decade. */
export function resolveWindow(from, to, { defaultDays = 84, maxDays = 366 } = {}) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from ?? '')) ? String(from) : today();
  let end = /^\d{4}-\d{2}-\d{2}$/.test(String(to ?? ''))
    ? String(to)
    : dayString(new Date(new Date(`${start}T00:00:00Z`).getTime() + defaultDays * DAY_MS));
  if (end < start) end = start;

  const span = Math.round(
    (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / DAY_MS
  );
  if (span > maxDays) {
    end = dayString(new Date(new Date(`${start}T00:00:00Z`).getTime() + maxDays * DAY_MS));
  }
  return { from: start, to: end };
}

/**
 * Everything needed to say who is free in a window, read once.
 *
 * Kept as one function because both callers need the same three collections and the same
 * resolution of "which days does this person actually have" — two copies would answer the
 * same question differently the first time one of them was changed.
 */
async function readWindow({ from, to, viewer }) {
  const [people, bookings, leave, visibleAudits] = await Promise.all([
    User.find({ enabled: true, approvedAt: { $ne: null }, roles: { $in: WORKING_ROLES } }).sort({
      username: 1,
    }),
    // Every booking, deliberately — see the note at the top of this file.
    Booking.find({ end: { $gte: from }, start: { $lte: to } }).select('user audit start end note'),
    Leave.find({ status: 'approved', end: { $gte: from }, start: { $lte: to } }).select(
      'user start end type portion status'
    ),
    Audit.find(visibleAuditFilter(viewer)).select('name reference'),
  ]);

  const labels = new Map(
    visibleAudits.map((audit) => [String(audit._id), audit.reference || audit.name])
  );
  const dayMap = leaveDayMap(leave, from, to);

  return { people, bookings, leave, labels, dayMap };
}

/**
 * One person's days in a window, as sets rather than counts.
 *
 * Sets because the interesting number is the *union*: somebody booked on a day they are also
 * on holiday has one day gone, not two, and adding the two figures would report more days
 * than the week contains — which is how a capacity number stops being believed.
 */
function daysFor({ person, from, to, bookings, dayMap }) {
  const mine = dayMap.get(String(person._id)) ?? new Map();
  const everyone = dayMap.get(EVERYONE) ?? new Map();

  const booked = new Set();
  for (const booking of bookings) {
    if (String(booking.user) !== String(person._id)) continue;
    for (const day of daysIn(booking.start, booking.end, from, to)) {
      if (!isWeekend(day)) booked.add(day);
    }
  }

  let weekdays = 0;
  let off = 0;
  let free = 0;
  let clash = 0;
  const freeDays = [];
  for (const day of daysIn(from, to, from, to)) {
    if (isWeekend(day)) continue;
    weekdays += 1;
    const away = Math.min(1, Math.max(everyone.get(day) ?? 0, mine.get(day) ?? 0));
    const isBooked = booked.has(day);
    if (away) off += away;
    if (away && isBooked) clash += 1;
    if (!isBooked && away < 1) {
      // A half day off is half a day free, and a day with nothing on it is a whole one.
      free += 1 - away;
      freeDays.push(day);
    }
  }

  const round = (value) => Math.round(value * 2) / 2;
  return {
    weekdays,
    daysOff: round(off),
    bookedDays: booked.size,
    freeDays: round(free),
    clashDays: clash,
    /** The actual dates, so a caller can offer "book them for these days". */
    free: freeDays,
    /**
     * Their longest unbroken stretch.
     *
     * Not the first and last free day: somebody free on Monday and Friday of the same week is
     * not free for five days, and offering to book that range would put them on an engagement
     * on days they are already committed to another.
     */
    freeRun: longestRun(freeDays),
  };
}

/**
 * The longest run of consecutive *working* days in a sorted list of days.
 *
 * A weekend does not break a run — Friday to Monday is four calendar days and two working
 * ones, and treating the weekend as an interruption would make every stretch a week long at
 * most, which is not how work is booked.
 */
function longestRun(days) {
  let best = null;
  let start = null;
  let previous = null;
  let length = 0;

  const nextWorkingDay = (day) => {
    let at = new Date(`${day}T00:00:00Z`).getTime() + DAY_MS;
    while (isWeekend(dayString(new Date(at)))) at += DAY_MS;
    return dayString(new Date(at));
  };

  for (const day of days) {
    if (previous !== null && day === nextWorkingDay(previous)) {
      length += 1;
    } else {
      start = day;
      length = 1;
    }
    previous = day;
    if (!best || length > best.days) best = { start, end: day, days: length };
  }
  return best;
}

/** A booking as it may be shown: dates always, the client's name only if you may see it. */
const bookingLabel = (booking, labels) => ({
  start: booking.start,
  end: booking.end,
  label: labels.get(String(booking.audit)) ?? 'another engagement',
  /** So the page can say plainly that it is withholding a name rather than inventing one. */
  visible: labels.has(String(booking.audit)),
});

/**
 * Who could take this work, in this window.
 *
 * Ranked by whether they could actually do it before how free they are: a fortnight of
 * availability from somebody who has never done Active Directory is not an answer to "who can
 * run this Active Directory job", and sorting by free days alone would put them first.
 */
export async function candidatesFor({ from, to, skill, viewer, minLevel = null }) {
  // Four weeks by default: "who can take this next month" is the question, not next year.
  const window = resolveWindow(from, to, { defaultDays: 28 });
  const { people, bookings, leave, labels, dayMap } = await readWindow({ ...window, viewer });

  const wanted = String(skill ?? '').trim().toLowerCase();

  const candidates = [];
  for (const person of people) {
    const held = (person.profile?.skills ?? []).find(
      (entry) => entry.name.trim().toLowerCase() === wanted
    );
    if (wanted && !held) continue;
    if (minLevel && held && LEVEL_RANK[held.level] < LEVEL_RANK[minLevel]) continue;

    const days = daysFor({ person, from: window.from, to: window.to, bookings, dayMap });
    candidates.push({
      id: person._id.toString(),
      username: person.username,
      fullname: nameOf(person),
      title: person.title ?? '',
      headline: person.profile?.headline ?? '',
      level: held?.level ?? null,
      deep: held ? isDeep(held.level) : false,
      ...days,
      bookings: bookings
        .filter((booking) => String(booking.user) === String(person._id))
        .map((booking) => bookingLabel(booking, labels)),
      /** Type and dates only. Why somebody is away is not a staffing input. */
      leave: leave
        .filter((row) => !row.user || String(row.user) === String(person._id))
        .map((row) => ({
          start: row.start,
          end: row.end,
          type: row.type,
          portion: row.portion,
          everyone: !row.user,
        })),
    });
  }

  candidates.sort(
    (a, b) =>
      (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0) ||
      b.freeDays - a.freeDays ||
      a.fullname.localeCompare(b.fullname)
  );

  return {
    window: { ...window, weekdays: weekdaysBetween(window.from, window.to) },
    skill: skill ?? '',
    candidates,
  };
}

/**
 * Available days per person per week, forwards.
 *
 * The Team page answers "how busy has this person been" — a window that looks backwards, by
 * design. Nothing answered "can we take a two-week job in March", which is the question that
 * decides whether work is accepted, and the only page that could have was a month calendar
 * somebody had to count by eye.
 *
 * Weeks start on Monday, like the calendar, because a working week that starts on Sunday is
 * not the week anybody plans in.
 */
export async function capacityFor({ from, to, viewer }) {
  const window = resolveWindow(from, to, { defaultDays: 84, maxDays: 366 });
  const { people, bookings, dayMap, labels } = await readWindow({ ...window, viewer });

  // Snap the start back to its Monday, so the first column is a whole week like the rest.
  const startAt = new Date(`${window.from}T00:00:00Z`);
  const monday = new Date(startAt.getTime() - ((startAt.getUTCDay() + 6) % 7) * DAY_MS);

  const weeks = [];
  for (let at = monday; dayString(at) <= window.to; at = new Date(at.getTime() + 7 * DAY_MS)) {
    const start = dayString(at);
    const end = dayString(new Date(at.getTime() + 6 * DAY_MS));
    weeks.push({ start, end, weekdays: weekdaysBetween(start, end) });
  }

  const rows = [];
  for (const person of people) {
    const perWeek = weeks.map((week) =>
      daysFor({ person, from: week.start, to: week.end, bookings, dayMap })
    );
    const total = perWeek.reduce(
      (sum, week) => ({
        weekdays: sum.weekdays + week.weekdays,
        daysOff: sum.daysOff + week.daysOff,
        bookedDays: sum.bookedDays + week.bookedDays,
        freeDays: sum.freeDays + week.freeDays,
        clashDays: sum.clashDays + week.clashDays,
      }),
      { weekdays: 0, daysOff: 0, bookedDays: 0, freeDays: 0, clashDays: 0 }
    );

    rows.push({
      id: person._id.toString(),
      username: person.username,
      fullname: nameOf(person),
      title: person.title ?? '',
      /** Strongest skills, so a row is a person rather than a name. */
      skills: (person.profile?.skills ?? [])
        .filter((skill) => isDeep(skill.level))
        .map((skill) => skill.name)
        .slice(0, 4),
      weeks: perWeek.map(({ free, ...rest }) => rest),
      total,
    });
  }

  /*
   * Busiest first, because the reader is looking for slack: a page that opens with the four
   * people who have nothing booked buries the fact that everybody else is full.
   */
  rows.sort(
    (a, b) =>
      b.total.bookedDays - a.total.bookedDays ||
      a.total.freeDays - b.total.freeDays ||
      a.fullname.localeCompare(b.fullname)
  );

  const totals = weeks.map((week, index) => {
    const column = rows.map((row) => row.weeks[index]);
    const available = column.reduce((sum, cell) => sum + (cell.weekdays - cell.daysOff), 0);
    const booked = column.reduce((sum, cell) => sum + cell.bookedDays, 0);
    return {
      ...week,
      /** Person-days the team actually has that week, after leave. */
      available: Math.round(available * 2) / 2,
      booked,
      free: Math.round(Math.max(0, available - booked) * 2) / 2,
      /** Share of what they had, which is the number a "can we take it" answer rests on. */
      load: available ? Math.round((booked / available) * 100) : 0,
      daysOff: Math.round(column.reduce((sum, cell) => sum + cell.daysOff, 0) * 2) / 2,
    };
  });

  return {
    window,
    weeks: totals,
    people: rows,
    /** How much of the calendar the reader is allowed to see the detail of. */
    visibleEngagements: labels.size,
  };
}

export default capacityFor;
