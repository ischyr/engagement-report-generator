/**
 * What an engagement has cost in hours, shaped for a report.
 *
 * A query across a collection, so it lives here rather than in `buildReportData()`, which
 * is deliberately synchronous — the same reason finding history is passed in. Absent
 * simply means nobody logged any time, and a template that prints effort says so rather
 * than printing a confident zero.
 */

import { TimeEntry, HOURS_PER_DAY } from '../models/time-entry.model.js';

const round = (value) => Math.round(value * 100) / 100;

/**
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @returns {Promise<{hours: number, days: number, recorded: boolean, people: Array,
 *   entries: number, firstDay: string|null, lastDay: string|null}>}
 */
export async function effortFor(auditId) {
  const entries = await TimeEntry.find({ audit: auditId })
    .populate({ path: 'user', select: 'username firstname lastname title' })
    .sort({ day: 1 });

  const perPerson = new Map();
  let total = 0;
  for (const entry of entries) {
    total += entry.hours;
    // `populated()` rather than the path: a deleted account populates to null, and every
    // one of them would otherwise merge into a single "Removed account" row.
    const id = String(entry.populated('user') ?? entry.user?._id ?? entry.user ?? '');
    if (!perPerson.has(id)) {
      const user = entry.user ?? null;
      perPerson.set(id, {
        // A deleted account still logged the hours, and dropping them would make the
        // per-person rows add up to less than the total.
        name:
          [user?.firstname, user?.lastname].filter(Boolean).join(' ') ||
          user?.username ||
          'Removed account',
        title: user?.title ?? '',
        hours: 0,
        days: 0,
      });
    }
    const person = perPerson.get(id);
    person.hours += entry.hours;
    person.days += 1;
  }

  const people = [...perPerson.values()]
    .map((person) => ({
      ...person,
      hours: round(person.hours),
      effortDays: round(person.hours / HOURS_PER_DAY),
    }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

  return {
    hours: round(total),
    /** Person-days, at this app's one definition of a working day. */
    days: round(total / HOURS_PER_DAY),
    hoursPerDay: HOURS_PER_DAY,
    recorded: entries.length > 0,
    entries: entries.length,
    people,
    firstDay: entries.length ? entries[0].day : null,
    lastDay: entries.length ? entries.at(-1).day : null,
  };
}

export default effortFor;
