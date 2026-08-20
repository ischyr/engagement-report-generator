/**
 * What the work actually took.
 *
 * Sits beside `/schedule` and reads the same way: across engagements, because "how much of
 * my week went where" cannot be answered one engagement at a time. Scoped identically —
 * you see hours on engagements you are on.
 *
 * Deliberately *not* written to the engagement's activity log. A booking is an occasional
 * event worth recording; hours are daily, and logging them would turn the engagement's
 * history into a timesheet nobody reads. The entries themselves are the record.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { TimeEntry, HOURS_PER_DAY } from '../models/time-entry.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, 'Use a yyyy-mm-dd date');

const idOf = (value) => String(value?._id ?? value ?? '');

/**
 * The id of whoever an entry belongs to, even when that account is gone.
 *
 * `populate()` sets the path to null when it finds nothing, taking the id with it — so a
 * deleted colleague's hours grouped under an empty key and appeared as a *second* person,
 * separate from their own bookings. `populated()` keeps the original reference, which is
 * the only thing that survives the account.
 */
const userIdOf = (doc) => String(doc.populated?.('user') ?? doc.user?._id ?? doc.user ?? '');

/** Quarter-hour steps, so the form and the model agree about what is storable. */
const hours = z
  .number()
  .min(0, 'Hours cannot be negative')
  .max(24, 'There are 24 hours in a day')
  .refine((value) => Math.round(value * 4) === value * 4, 'Use quarter-hour steps');

const entrySchema = z.object({
  audit: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Pick an engagement'),
  /** Omitted means yourself, which is almost always the case. */
  user: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  day,
  hours,
  note: z.string().trim().max(300).optional().default(''),
});

const POPULATE = [
  { path: 'user', select: 'username firstname lastname' },
  {
    path: 'audit',
    select: 'name reference state company',
    populate: { path: 'company', select: 'name shortName' },
  },
];

const summary = (entry) => ({
  _id: entry._id,
  day: entry.day,
  hours: entry.hours,
  note: entry.note,
  user: entry.user,
  /** Survives the account: `user` is null once somebody is deleted. */
  userId: userIdOf(entry),
  audit: entry.audit,
  updatedAt: entry.updatedAt,
});

/**
 * Loads the engagement and checks the entry is allowed to exist.
 *
 * The same two rules as a booking, for the same reasons: the person has to be *on* the
 * engagement, and filling in somebody else's hours is the creator's call or an admin's.
 * Time is a claim about another person's week even after the fact.
 */
async function assertLoggable(req, auditId, userId) {
  const audit = await Audit.findOne({ _id: auditId, ...visibleAuditFilter(req.user) });
  if (!audit) throw notFound('Engagement not found, or you are not on it');

  const team = [
    idOf(audit.creator),
    ...(audit.collaborators ?? []).map(idOf),
    ...(audit.reviewers ?? []).map(idOf),
  ];
  if (!team.includes(String(userId))) {
    throw badRequest('That person is not on this engagement, so time cannot be logged for them.');
  }

  const isSelf = String(userId) === String(req.user._id);
  const mayLogForOthers = req.user.role === 'admin' || idOf(audit.creator) === String(req.user._id);
  if (!isSelf && !mayLogForOthers) {
    throw forbidden(
      'Only the person themselves, the engagement creator or an admin can log someone else’s hours.'
    );
  }
  return audit;
}

/**
 * Hours in a window, plus what was booked over the same window.
 *
 * Both halves in one response because the page's whole job is the comparison: fetching
 * them separately guarantees that at some point one of them is a month out of date.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const from = DAY.test(String(req.query.from ?? '')) ? String(req.query.from) : null;
    const to = DAY.test(String(req.query.to ?? '')) ? String(req.query.to) : null;

    const audits = await Audit.find(visibleAuditFilter(req.user)).select(
      'name reference state date_start date_end company creator collaborators reviewers'
    );
    const ids = audits.map((audit) => audit._id);

    const filter = { audit: { $in: ids } };
    if (from) filter.day = { ...(filter.day ?? {}), $gte: from };
    if (to) filter.day = { ...(filter.day ?? {}), $lte: to };
    if (String(req.query.user ?? '') === 'me') filter.user = req.user._id;

    const entries = await TimeEntry.find(filter).populate(POPULATE).sort({ day: 1 });

    res.json({
      entries: entries.map(summary),
      hoursPerDay: HOURS_PER_DAY,
      totals: {
        hours: Math.round(entries.reduce((sum, entry) => sum + entry.hours, 0) * 4) / 4,
        entries: entries.length,
        /** Distinct days that carry any time at all, across everybody in the window. */
        days: new Set(entries.map((entry) => `${userIdOf(entry)}:${entry.day}`)).size,
      },
      /** For the picker, and so the page can name an engagement with no hours yet. */
      engagements: audits.map((audit) => ({
        _id: audit._id,
        name: audit.name,
        reference: audit.reference,
        state: audit.state,
        company: audit.company?.name ?? '',
        date_start: audit.date_start,
        date_end: audit.date_end,
        team: [
          idOf(audit.creator),
          ...(audit.collaborators ?? []).map(idOf),
          ...(audit.reviewers ?? []).map(idOf),
        ].filter((id, index, all) => id && all.indexOf(id) === index),
      })),
    });
  })
);

/**
 * Log a day, or correct one.
 *
 * An upsert rather than a create, because the unique index says a person has one entry per
 * engagement per day: typing today's hours again means you are fixing the number, and a
 * 409 there would be the app arguing with somebody who knows better. Zero hours deletes —
 * the natural way to undo a mistyped entry is to set it to nothing.
 */
router.post(
  '/',
  validate(entrySchema),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const userId = req.body.user ?? String(req.user._id);
    const audit = await assertLoggable(req, req.body.audit, userId);

    const key = { audit: audit._id, user: userId, day: req.body.day };

    if (req.body.hours === 0) {
      const gone = await TimeEntry.findOneAndDelete(key);
      return res.json({ ok: true, removed: Boolean(gone), id: gone?._id ?? null });
    }

    const entry = await TimeEntry.findOneAndUpdate(
      key,
      {
        $set: { hours: req.body.hours, note: req.body.note, updatedBy: req.user._id },
        $setOnInsert: { ...key, createdBy: req.user._id },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate(POPULATE);

    return res.status(201).json(summary(entry));
  })
);

/** Loads an entry the caller is allowed to change. */
async function loadOwnEntry(req) {
  const entry = await TimeEntry.findById(req.params.id);
  if (!entry) throw notFound('Time entry not found');

  const visible = await Audit.findOne({
    _id: entry.audit,
    ...visibleAuditFilter(req.user),
  }).select('_id creator');
  if (!visible) throw notFound('Time entry not found');

  const mine = String(entry.user) === String(req.user._id);
  const mayManage = req.user.role === 'admin' || idOf(visible.creator) === String(req.user._id);
  if (!mine && !mayManage) {
    throw forbidden('Only the person who logged it, the engagement creator or an admin can change it.');
  }
  return entry;
}

/*
 * No PUT. Correcting an entry means posting the same person, engagement and day again,
 * which the upsert above already handles — a second way to change the same row would be
 * two code paths for one action and one of them would rot.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const entry = await loadOwnEntry(req);
    await TimeEntry.deleteOne({ _id: entry._id });
    res.json({ ok: true, id: req.params.id });
  })
);

/**
 * One engagement's hours, for the panel inside it: the total, who spent it, and how that
 * sits against what was booked.
 *
 * Booked days come from the bookings for the same engagement, counted as distinct days per
 * person — two overlapping bookings are still those days, and summing them would report a
 * plan bigger than anybody's calendar.
 */
router.get(
  '/audit/:id',
  asyncHandler(async (req, res) => {
    const audit = await Audit.findOne({ _id: req.params.id, ...visibleAuditFilter(req.user) })
      .select('_id name creator collaborators reviewers')
      .populate([
        { path: 'creator', select: 'username firstname lastname' },
        { path: 'collaborators', select: 'username firstname lastname' },
        { path: 'reviewers', select: 'username firstname lastname' },
      ]);
    if (!audit) throw notFound('Engagement not found, or you are not on it');

    const [entries, bookings] = await Promise.all([
      TimeEntry.find({ audit: audit._id })
        .populate({ path: 'user', select: 'username firstname lastname' })
        .sort({ day: -1 }),
      Booking.find({ audit: audit._id }).select('user start end'),
    ]);

    /** Distinct booked days per person, so the plan cannot be inflated by overlaps. */
    const bookedByUser = new Map();
    for (const booking of bookings) {
      const id = idOf(booking.user);
      if (!bookedByUser.has(id)) bookedByUser.set(id, new Set());
      const days = bookedByUser.get(id);
      for (let at = booking.start; at <= booking.end; at = nextDay(at)) days.add(at);
    }

    const byUser = new Map();
    for (const entry of entries) {
      const id = userIdOf(entry);
      if (!byUser.has(id)) {
        byUser.set(id, { id, user: entry.user, hours: 0, days: 0, bookedDays: 0 });
      }
      const person = byUser.get(id);
      person.hours += entry.hours;
      person.days += 1;
    }
    // People with a booking but no hours logged yet belong in the comparison — they are
    // precisely the rows worth chasing.
    for (const id of bookedByUser.keys()) {
      if (byUser.has(id)) continue;
      const member = [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]
        .filter(Boolean)
        .find((person) => idOf(person) === id);
      byUser.set(id, { id, user: member ?? null, hours: 0, days: 0, bookedDays: 0 });
    }
    for (const [id, person] of byUser) {
      person.bookedDays = bookedByUser.get(id)?.size ?? 0;
      person.hours = Math.round(person.hours * 4) / 4;
    }

    const totalHours = Math.round(entries.reduce((sum, entry) => sum + entry.hours, 0) * 4) / 4;
    const bookedDays = [...bookedByUser.values()].reduce((sum, days) => sum + days.size, 0);

    res.json({
      entries: entries.map(summary),
      hoursPerDay: HOURS_PER_DAY,
      people: [...byUser.values()].sort((a, b) => b.hours - a.hours),
      totals: {
        hours: totalHours,
        /**
         * Person-days, at the one definition of a day this app uses.
         *
         * Two decimals, matching `effortFor()` — at one decimal the per-person rows on the
         * panel added up to 4.4 beside a headline of 4.5, and a table that does not sum
         * reads as a bug however small the discrepancy.
         */
        days: Math.round((totalHours / HOURS_PER_DAY) * 100) / 100,
        bookedDays,
        entries: entries.length,
        firstDay: entries.length ? entries.at(-1).day : null,
        lastDay: entries.length ? entries[0].day : null,
      },
    });
  })
);

/** `yyyy-mm-dd` plus one, without letting a timezone anywhere near it. */
function nextDay(iso) {
  const [year, month, date] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, date + 1));
  return at.toISOString().slice(0, 10);
}

export default router;
