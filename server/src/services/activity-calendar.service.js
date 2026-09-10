/**
 * When an engagement was actually worked on.
 *
 * The activity log answers "what happened" perfectly and "when did this job actually get done"
 * not at all: the answer is spread over three hundred rows in reverse order, and the interesting
 * part — the fortnight in the middle where nothing moved — is invisible because nothing is there
 * to see. A count per day is the same data in the shape that question has.
 *
 * Days are `yyyy-mm-dd` in UTC, like every other day in this app. A boundary an hour either way
 * does not change what a calendar is for, and being consistent with `today()` matters more than
 * being right about somebody's midnight.
 */

import { Activity } from '../models/activity.model.js';
import { User } from '../models/user.model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayString = (date) => date.toISOString().slice(0, 10);

/** Every day in a range, so a calendar has cells for the quiet ones too. */
function eachDay(from, to) {
  const days = [];
  for (let at = new Date(`${from}T00:00:00Z`); dayString(at) <= to; at = new Date(at.getTime() + DAY_MS)) {
    days.push(dayString(at));
  }
  return days;
}

/**
 * The longest run of days with nothing in it, inside the range that has activity.
 *
 * Leading and trailing silence is not a gap — an engagement that started three weeks ago was not
 * "quiet" before it existed — so the search runs between the first and last active day only. This
 * is the number worth putting in a sentence: "nothing happened for 19 days in the middle of it" is
 * a fact about a project, and no list of rows says it.
 */
function longestGap(counts, days) {
  const active = days.filter((day) => counts.get(day));
  if (active.length < 2) return null;

  let best = null;
  let from = null;
  let last = null;
  let run = 0;

  const close = () => {
    if (run > 0 && (!best || run > best.days)) best = { days: run, from, to: last };
    run = 0;
    from = null;
    last = null;
  };

  for (const day of days) {
    // Only between the first and last day something happened: an engagement was not "quiet"
    // before it existed, and it is not quiet now merely because it finished.
    if (day < active[0] || day > active.at(-1)) continue;
    if (counts.get(day)) {
      close();
      continue;
    }
    if (run === 0) from = day;
    last = day;
    run += 1;
  }
  close();
  return best;
}

/**
 * @param {{audit?: any, from?: string, to?: string, days?: number}} options
 * @returns {Promise<object>} counts per day, per person, and the shape of the whole range
 */
export async function activityCalendar({ audit = null, actor = null, from, to, days = 180 } = {}) {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to ?? '')) ? String(to) : dayString(new Date());
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from ?? ''))
    ? String(from)
    : dayString(new Date(new Date(`${end}T00:00:00Z`).getTime() - (Math.min(730, Math.max(7, days)) - 1) * DAY_MS));

  const match = {
    createdAt: { $gte: new Date(`${start}T00:00:00.000Z`), $lte: new Date(`${end}T23:59:59.999Z`) },
  };
  if (audit) match.audit = audit._id ?? audit;
  /*
   * One person's own rhythm, for their dashboard. The whole team's is admin-only — a heatmap of
   * everybody's hours is a management view — but your own is yours, and it is the version that
   * belongs on a front page.
   */
  if (actor) match.actor = actor._id ?? actor;

  /*
   * Aggregated in the database rather than read and counted here.
   *
   * An engagement can carry thousands of log rows and this endpoint is drawn on a page load;
   * fetching them all to produce 180 numbers is the kind of thing that makes a page feel slow
   * for no reason anybody can see.
   */
  const [byDay, byPerson, byAction] = await Promise.all([
    Activity.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          people: { $addToSet: '$actor' },
        },
      },
    ]),
    Activity.aggregate([
      { $match: match },
      { $group: { _id: '$actor', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    Activity.aggregate([
      { $match: match },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]),
  ]);

  const counts = new Map(byDay.map((row) => [row._id, row.count]));
  const contributors = new Map(byDay.map((row) => [row._id, row.people.filter(Boolean).length]));
  const days_ = eachDay(start, end);

  /** Who did it, with names resolved in one lookup rather than one per row. */
  const ids = byPerson.map((row) => row._id).filter(Boolean);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('username firstname lastname') : [];
  const nameOf = new Map(
    users.map((user) => [
      String(user._id),
      [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
    ])
  );

  const total = byDay.reduce((sum, row) => sum + row.count, 0);
  const activeDays = byDay.length;
  const busiest = byDay.reduce((best, row) => (!best || row.count > best.count ? { day: row._id, count: row.count } : best), null);

  return {
    from: start,
    to: end,
    /** One entry per day in the range, including the empty ones — a calendar needs the blanks. */
    days: days_.map((day) => ({ day, count: counts.get(day) ?? 0, people: contributors.get(day) ?? 0 })),
    total,
    activeDays,
    busiest,
    /** Average over the days something happened, not over the calendar: the latter says nothing. */
    perActiveDay: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0,
    quietest: longestGap(counts, days_),
    people: byPerson
      .filter((row) => row._id)
      .map((row) => ({
        id: String(row._id),
        fullname: nameOf.get(String(row._id)) ?? 'Removed account',
        count: row.count,
        lastAt: row.lastAt,
      })),
    /** What the work consisted of — the verbs, most-used first. */
    actions: byAction.map((row) => ({ action: row._id, count: row.count })),
  };
}

export default activityCalendar;
