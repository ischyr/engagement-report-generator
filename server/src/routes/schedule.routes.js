/**
 * Who is on what, and when.
 *
 * Reads across engagements, so it lives here rather than under `/audits/:id` — the
 * question "am I free that week" cannot be answered one engagement at a time, which is
 * why nothing could answer it before.
 *
 * Scoped like everything else: you see bookings on engagements you are on. A schedule
 * that showed every engagement in the instance would be a list of the clients you are
 * not allowed to know about.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { User } from '../models/user.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { ACTIONS, recordActivity } from '../services/activity.service.js';
import { Notification } from '../models/notification.model.js';
import { Leave } from '../models/leave.model.js';
import { Settings } from '../models/settings.model.js';
import { candidatesFor, capacityFor } from '../services/staffing.service.js';
import {
  clashingLeave,
  describeClash,
  leaveDayMap,
  availableDaysFor,
  weekdaysBetween,
  allowanceUsage,
  daysIn,
  isWeekend,
} from '../services/leave.service.js';

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, 'Use a yyyy-mm-dd date');

const idOf = (value) => String(value?._id ?? value ?? '');

const bookingSchema = z.object({
  audit: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Pick an engagement'),
  /** Omitted means yourself, which is the common case. */
  user: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  start: day,
  end: day,
  note: z.string().trim().max(300).optional().default(''),
});

const POPULATE = [
  { path: 'user', select: 'username firstname lastname' },
  { path: 'audit', select: 'name reference state company', populate: { path: 'company', select: 'name shortName' } },
];

/**
 * Tells somebody their week changed, when it was not them who changed it.
 *
 * The person whose time it is, and nobody else: the engagement's own activity log already
 * records the change for whoever is watching the engagement, and a notification to the creator
 * as well would mean two people told about one edit — which is how a bell earns being ignored.
 *
 * Never for your own edits. Telling somebody what they just did is the noise that makes the
 * useful notices invisible.
 */
async function noticeBookingChange({ booking, audit, actor, what, clash = null }) {
  const owner = String(booking.user?._id ?? booking.user ?? '');
  if (!owner || owner === String(actor._id)) return false;

  const who = [actor.firstname, actor.lastname].filter(Boolean).join(' ') || actor.username;
  const where = audit?.reference || audit?.name || 'an engagement';
  await Notification.create({
    user: owner,
    type: 'booking-changed',
    actor: actor._id,
    audit: audit?._id ?? null,
    auditName: audit?.name ?? '',
    target: where,
    /*
     * The clash is appended rather than sent as a second notice. Being booked over your own
     * holiday is not a separate event from being booked — it is the most important thing
     * about it, and two notifications for one edit is how a bell earns being ignored.
     */
    message: `${who} ${what} your time on ${where} (${booking.start} → ${booking.end})${
      clash ? ` — ${clash}` : ''
    }`,
    href: '/schedule',
  });
  return true;
}

/**
 * A leave row as the calendar needs it.
 *
 * The note is withheld from everybody but its owner and the admins: that somebody is away is
 * what a shared calendar is for, and why they are away is not. `noteHidden` says a reason
 * exists rather than implying there is none.
 */
const leaveSummary = (leave, viewer) => {
  const owner = String(leave.user?._id ?? leave.user ?? '');
  const mayReadNote = viewer.role === 'admin' || (owner && owner === String(viewer._id));
  return {
    _id: leave._id,
    user: leave.user,
    /** Survives a deleted account, exactly like a booking's. */
    userId: String(leave.populated?.('user') ?? leave.user?._id ?? leave.user ?? ''),
    everyone: !owner,
    start: leave.start,
    end: leave.end,
    type: leave.type,
    portion: leave.portion,
    status: leave.status,
    note: mayReadNote ? leave.note : '',
    noteHidden: Boolean(leave.note) && !mayReadNote,
    /** Weekdays it costs — what a reader is counting when they look at a range. */
    workingDays:
      daysIn(leave.start, leave.end).filter((d) => !isWeekend(d)).length *
      (leave.portion === 'full' ? 1 : 0.5),
  };
};

const summary = (booking) => ({
  _id: booking._id,
  start: booking.start,
  end: booking.end,
  note: booking.note,
  user: booking.user,
  /**
   * Survives the account. `user` is null once somebody is deleted — `populated()` keeps the
   * reference, which is what anything matching bookings against other records needs.
   */
  userId: String(booking.populated?.('user') ?? booking.user?._id ?? booking.user ?? ''),
  audit: booking.audit,
  createdAt: booking.createdAt,
});

/** The engagements the caller may book against, and who is on each. */
async function visibleAudits(req) {
  return Audit.find(visibleAuditFilter(req.user)).select(
    'name reference state date_start date_end company creator collaborators reviewers'
  );
}

/**
 * Loads the engagement and checks that this booking is allowed to exist.
 *
 * Two rules, both borrowed from how the team already works:
 * - the person being booked has to be *on* the engagement, or the booking would put
 *   time against something they cannot open;
 * - booking somebody else is the creator's call, or an admin's — the same rule that
 *   governs who may change the team, because a booking is a claim on someone's week.
 */
async function assertBookable(req, auditId, userId) {
  const audit = await Audit.findOne({ _id: auditId, ...visibleAuditFilter(req.user) });
  if (!audit) throw notFound('Engagement not found, or you are not on it');

  const team = [
    idOf(audit.creator),
    ...(audit.collaborators ?? []).map(idOf),
    ...(audit.reviewers ?? []).map(idOf),
  ];
  if (!team.includes(String(userId))) {
    throw badRequest('That person is not on this engagement, so they cannot be booked to it.');
  }

  const isSelf = String(userId) === String(req.user._id);
  const mayBookOthers = req.user.role === 'admin' || idOf(audit.creator) === String(req.user._id);
  if (!isSelf && !mayBookOthers) {
    throw forbidden(
      'Only the person themselves, the engagement creator or an admin can book someone else’s time.'
    );
  }
  return audit;
}

/**
 * Everything overlapping a window.
 *
 * Overlap, not containment: a booking that started last month and runs through this one
 * belongs on this month's calendar, and asking for bookings that *begin* in the range
 * would quietly lose exactly the long engagements a schedule exists to show.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const from = DAY.test(String(req.query.from ?? '')) ? String(req.query.from) : null;
    const to = DAY.test(String(req.query.to ?? '')) ? String(req.query.to) : null;

    const audits = await visibleAudits(req);
    const filter = { audit: { $in: audits.map((audit) => audit._id) } };
    if (from) filter.end = { $gte: from };
    if (to) filter.start = { $lte: to };

    const bookings = await Booking.find(filter).populate(POPULATE).sort({ start: 1 });

    /*
     * Who is away, in the same request.
     *
     * Unscoped by engagement on purpose: leave is a fact about a person's week, and the
     * question this page exists to answer — "can I book them that week" — cannot be
     * answered by a calendar that only knows what they already said yes to. Declined and
     * cancelled rows are history and stay off it.
     */
    const leaveFilter = { status: { $in: ['requested', 'approved'] } };
    if (from) leaveFilter.end = { $gte: from };
    if (to) leaveFilter.start = { $lte: to };
    const leave = await Leave.find(leaveFilter)
      .populate({ path: 'user', select: 'username firstname lastname' })
      .sort({ start: 1 });

    const dayMap = leaveDayMap(leave, from ?? '0000-01-01', to ?? '9999-12-31');

    /*
     * The allowance and the approval rule come back with the calendar rather than from a
     * second request. The page needs all of it to draw one screen, and it is the page that
     * already fetches bookings, leave and logged hours — a fourth round trip for two numbers
     * would be the kind of thing that makes a calendar feel slow.
     */
    const settings = await Settings.getSettings();
    const allowanceDays = settings.leave?.allowanceDays ?? 0;

    res.json({
      bookings: bookings.map(summary),
      /** The reason is stripped for everybody but its owner and the admins. */
      leave: leave.map((row) => leaveSummary(row, req.user)),
      /**
       * What the window is worth, for the person reading it: weekdays, minus their own
       * approved leave and the public holidays everybody gets.
       */
      capacity:
        from && to
          ? { weekdays: weekdaysBetween(from, to), ...availableDaysFor(req.user._id, from, to, dayMap) }
          : null,
      /** Your own holiday balance for the calendar year. */
      allowance: await allowanceUsage(req.user._id, new Date().getFullYear(), allowanceDays || null),
      /** Whether somebody's own request waits for a decision or simply lands on the calendar. */
      requireApproval: settings.leave?.requireApproval !== false,
      /** For the picker: what can be booked, who is on it, and the client's own window. */
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
 * Who could take this work, in this window.
 *
 * Readable by anybody signed in, like the Skills page: "who is free to do this" is a question
 * a tester has as often as a lead, and an app that keeps the answer in the admin zone leaves it
 * where it was — in somebody's head.
 *
 * Declared before the parameterised routes below, or Express reads "availability" as an id.
 */
router.get(
  '/availability',
  asyncHandler(async (req, res) => {
    res.json(
      await candidatesFor({
        from: req.query.from,
        to: req.query.to,
        skill: req.query.skill,
        minLevel: ['learning', 'working', 'strong', 'expert'].includes(String(req.query.level))
          ? String(req.query.level)
          : null,
        viewer: req.user,
      })
    );
  })
);

/** Available person-days per week, forwards — the "can we take a job in March" read. */
router.get(
  '/capacity',
  asyncHandler(async (req, res) => {
    res.json(await capacityFor({ from: req.query.from, to: req.query.to, viewer: req.user }));
  })
);

router.post(
  '/',
  validate(bookingSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const userId = req.body.user ?? String(req.user._id);
    const audit = await assertBookable(req, req.body.audit, userId);
    if (req.body.end < req.body.start) throw badRequest('A booking cannot end before it starts.');

    const booking = await Booking.create({
      audit: audit._id,
      user: userId,
      start: req.body.start,
      end: req.body.end,
      note: req.body.note,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    // In the engagement's own log too: who is booked on it is part of its history.
    const person = await User.findById(userId).select('username firstname lastname');
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.BOOKING_ADDED,
      target: [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username || 'somebody',
      meta: { start: booking.start, end: booking.end },
    });

    /*
     * Booking somebody over their own time off is reported, never refused — the same rule
     * this page already applies to overlapping bookings, because a scheduler that refuses to
     * record reality gets worked around, and a retest half-day inside somebody's holiday is
     * occasionally the truth. It is said out loud in three places: to whoever is booking, in
     * the notification to whoever is booked, and on the calendar afterwards.
     */
    const clashes = await clashingLeave(userId, booking.start, booking.end);
    const theirName = [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username;
    const clash = describeClash(clashes, String(userId) === String(req.user._id) ? 'You' : theirName ?? 'They');

    await noticeBookingChange({ booking, audit, actor: req.user, what: 'booked', clash });

    await booking.populate(POPULATE);
    res.status(201).json({ ...summary(booking), warning: clash });
  })
);

/** Loads a booking the caller is allowed to change. */
async function loadOwnBooking(req) {
  const booking = await Booking.findById(req.params.id).populate('audit', 'creator');
  if (!booking) throw notFound('Booking not found');

  const visible = await Audit.findOne({
    _id: booking.audit?._id ?? booking.audit,
    ...visibleAuditFilter(req.user),
  }).select('_id creator name');
  if (!visible) throw notFound('Booking not found');

  const mine = String(booking.user) === String(req.user._id);
  const mayManage = req.user.role === 'admin' || idOf(visible.creator) === String(req.user._id);
  if (!mine && !mayManage) {
    throw forbidden('Only the person booked, the engagement creator or an admin can change it.');
  }
  return { booking, audit: visible };
}

router.put(
  '/:id',
  validate(bookingSchema.partial().omit({ audit: true, user: true })),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const { booking } = await loadOwnBooking(req);

    const wasStart = booking.start;
    const wasEnd = booking.end;
    booking.set({ ...req.body, updatedBy: req.user._id });
    if (booking.end < booking.start) throw badRequest('A booking cannot end before it starts.');
    /*
     * Moved dates make it news again: somebody reminded about Monday needs telling when it
     * becomes Thursday, and the sweep only ever mentions a booking once.
     */
    const moved = booking.start !== wasStart || booking.end !== wasEnd;
    if (moved) booking.reminderSentAt = null;
    await booking.save();

    let clash = null;
    if (moved) {
      const audit = await Audit.findById(booking.audit).select('name reference');
      const clashes = await clashingLeave(booking.user, booking.start, booking.end);
      const person = await User.findById(booking.user).select('username firstname lastname');
      const theirName = [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username;
      clash = describeClash(clashes, String(booking.user) === String(req.user._id) ? 'You' : theirName ?? 'They');
      await noticeBookingChange({ booking, audit, actor: req.user, what: 'moved', clash });
    }

    await booking.populate(POPULATE);
    res.json({ ...summary(booking), warning: clash });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const { booking, audit } = await loadOwnBooking(req);
    await Booking.deleteOne({ _id: booking._id });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.BOOKING_REMOVED,
      meta: { start: booking.start, end: booking.end },
    });
    await noticeBookingChange({ booking, audit, actor: req.user, what: 'cancelled' });
    res.json({ ok: true, id: req.params.id });
  })
);

export default router;
