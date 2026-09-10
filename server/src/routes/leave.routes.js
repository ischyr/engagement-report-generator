/**
 * Time off — holiday, sickness, training, and the public holidays everybody gets.
 *
 * Not under `/audits/:id`, and not scoped to engagements: leave is a fact about a person's
 * week, not about a client's job, and the whole point is that it is visible to whoever is
 * about to book that week. The one thing that is *not* shared is the reason — see `visible()`.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Leave, LEAVE_TYPES, LEAVE_PORTIONS } from '../models/leave.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { allowanceUsage, daysIn, isWeekend, weekdaysBetween, leaveDayMap, availableDaysFor } from '../services/leave.service.js';

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, 'Use a yyyy-mm-dd date');

const leaveSchema = z.object({
  /** Omitted means your own, which is the common case. */
  user: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  start: day,
  end: day,
  type: z.enum(LEAVE_TYPES).optional().default('holiday'),
  portion: z.enum(LEAVE_PORTIONS).optional().default('full'),
  note: z.string().trim().max(300).optional().default(''),
});

const decisionSchema = z.object({
  status: z.enum(['approved', 'declined']),
  note: z.string().trim().max(300).optional().default(''),
});

const idOf = (value) => String(value?._id ?? value ?? '');
const nameOf = (person) =>
  [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username || 'Somebody';

/**
 * One row, with the reason stripped for everybody but its owner and the admins.
 *
 * That somebody is away is what a shared calendar is for; *why* is between them and whoever
 * approves it. `noteHidden` rather than silently dropping the field, so the page can say a
 * reason exists instead of implying there is none.
 */
function visible(leave, viewer) {
  const owner = idOf(leave.user);
  const mayReadNote = viewer.role === 'admin' || (owner && owner === String(viewer._id));
  return {
    _id: leave._id,
    user: leave.user,
    userId: String(leave.populated?.('user') ?? leave.user?._id ?? leave.user ?? ''),
    start: leave.start,
    end: leave.end,
    type: leave.type,
    portion: leave.portion,
    status: leave.status,
    note: mayReadNote ? leave.note : '',
    noteHidden: Boolean(leave.note) && !mayReadNote,
    decidedBy: leave.decidedBy,
    decidedAt: leave.decidedAt,
    decisionNote: leave.decisionNote,
    createdAt: leave.createdAt,
    /** Weekdays it costs — what a reader is actually counting when they look at a range. */
    workingDays:
      daysIn(leave.start, leave.end).filter((d) => !isWeekend(d)).length *
      (leave.portion === 'full' ? 1 : 0.5),
  };
}

const POPULATE = [
  { path: 'user', select: 'username firstname lastname' },
  { path: 'decidedBy', select: 'username firstname lastname' },
];

/** Tells the admins somebody has asked for time off. Nobody else needs it. */
async function noticeRequest(leave, actor) {
  const admins = await User.find({
    roles: 'admin',
    enabled: true,
    approvedAt: { $ne: null },
  }).select('_id');
  const who = nameOf(actor);
  await Notification.create(
    admins
      .filter((admin) => String(admin._id) !== String(actor._id))
      .map((admin) => ({
        user: admin._id,
        type: 'leave-requested',
        actor: actor._id,
        target: `${leave.start} → ${leave.end}`,
        message: `${who} asked for ${leave.type === 'holiday' ? 'holiday' : leave.type} from ${leave.start} to ${leave.end}`,
        href: '/schedule',
      }))
  );
}

/**
 * Tells somebody what was decided about their request.
 *
 * The one notification in this file that matters most: a request that sits unanswered on a
 * page nobody has open is the reason people ask over chat instead.
 */
async function noticeDecision(leave, actor) {
  const owner = idOf(leave.user);
  if (!owner || owner === String(actor._id)) return;
  await Notification.create({
    user: owner,
    type: 'leave-decided',
    actor: actor._id,
    target: `${leave.start} → ${leave.end}`,
    message: `${nameOf(actor)} ${leave.status} your ${leave.type} from ${leave.start} to ${leave.end}${
      leave.decisionNote ? ` — ${leave.decisionNote}` : ''
    }`,
    href: '/schedule',
  });
}

/**
 * Everything overlapping a window, plus the numbers a calendar wants beside it.
 *
 * Overlap rather than containment, exactly like bookings: a fortnight that started last
 * month still belongs on this month's calendar.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const from = DAY.test(String(req.query.from ?? '')) ? String(req.query.from) : null;
    const to = DAY.test(String(req.query.to ?? '')) ? String(req.query.to) : null;

    const filter = {};
    if (from) filter.end = { $gte: from };
    if (to) filter.start = { $lte: to };
    // Declined and cancelled rows are history, not the calendar; the owner still sees their
    // own so a decision does not simply disappear from under them.
    filter.$or = [
      { status: { $in: ['requested', 'approved'] } },
      { user: req.user._id },
    ];

    const rows = await Leave.find(filter).populate(POPULATE).sort({ start: 1 });

    const settings = await Settings.getSettings();
    const allowanceDays = settings.leave?.allowanceDays ?? 0;
    const year = new Date().getFullYear();

    /*
     * Availability for the window, per person, so the page can say "8 of 21 working days"
     * without recomputing what a working day is in a second place.
     */
    const dayMap = leaveDayMap(rows, from ?? '0000-01-01', to ?? '9999-12-31');
    const mine =
      from && to
        ? availableDaysFor(req.user._id, from, to, dayMap)
        : { available: 0, off: 0 };

    res.json({
      leave: rows.map((row) => visible(row, req.user)),
      /** Your own balance for the calendar year — the number people actually want. */
      allowance: await allowanceUsage(req.user._id, year, allowanceDays || null),
      window:
        from && to
          ? { from, to, weekdays: weekdaysBetween(from, to), yourWorkingDays: mine.available, yourDaysOff: mine.off }
          : null,
      requireApproval: settings.leave?.requireApproval !== false,
      /** So the page can show admins a queue without a second request. */
      pending: rows.filter((row) => row.status === 'requested').length,
    });
  })
);

router.post(
  '/',
  validate(leaveSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    if (req.body.end < req.body.start) throw badRequest('Leave cannot end before it starts.');

    const isPublic = req.body.type === 'public-holiday';
    const forSelf = !req.body.user || String(req.body.user) === String(req.user._id);
    const isAdmin = req.user.role === 'admin';

    if (isPublic && !isAdmin) throw forbidden('Only an admin can add a public holiday.');
    if (!forSelf && !isAdmin) throw forbidden('Only an admin can record somebody else’s leave.');

    const settings = await Settings.getSettings();
    /*
     * An admin recording leave is recording a decision, not asking for one — including
     * their own, since the person who would approve it is them. Everybody else's own
     * request waits, unless the instance has turned approval off.
     */
    const approved = isAdmin || settings.leave?.requireApproval === false;

    const leave = await Leave.create({
      user: isPublic ? null : (req.body.user ?? req.user._id),
      start: req.body.start,
      end: req.body.end,
      type: req.body.type,
      portion: req.body.portion,
      note: req.body.note,
      status: approved ? 'approved' : 'requested',
      decidedBy: approved ? req.user._id : null,
      decidedAt: approved ? new Date() : null,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    if (!approved) await noticeRequest(leave, req.user);
    // Leave recorded *for* somebody else is news to them either way.
    if (!forSelf && !isPublic) await noticeDecision(leave, req.user);

    await leave.populate(POPULATE);
    res.status(201).json(visible(leave, req.user));
  })
);

/** Loads a row the caller is allowed to touch, and says which powers they have over it. */
async function loadLeave(req) {
  const leave = await Leave.findById(req.params.id).populate(POPULATE);
  if (!leave) throw notFound('That leave is not there any more');
  const owner = idOf(leave.user);
  const mine = owner && owner === String(req.user._id);
  const isAdmin = req.user.role === 'admin';
  if (!mine && !isAdmin) throw forbidden('Only its owner or an admin can change it.');
  return { leave, mine, isAdmin };
}

router.put(
  '/:id',
  validate(leaveSchema.partial().omit({ user: true })),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const { leave, isAdmin } = await loadLeave(req);

    /*
     * Editing an approved request would be changing something somebody else agreed to. The
     * owner cancels and asks again; an admin, who is the person that agreed, may just edit.
     */
    if (!isAdmin && leave.status !== 'requested') {
      throw badRequest('That has already been decided — cancel it and ask again.');
    }

    leave.set({ ...req.body, updatedBy: req.user._id });
    if (leave.end < leave.start) throw badRequest('Leave cannot end before it starts.');
    await leave.save();

    await leave.populate(POPULATE);
    res.json(visible(leave, req.user));
  })
);

/** Approve or decline. Admin only, because it is the only decision in this file. */
router.post(
  '/:id/decision',
  validate(decisionSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') throw forbidden('Only an admin can decide a leave request.');
    const leave = await Leave.findById(req.params.id).populate(POPULATE);
    if (!leave) throw notFound('That leave is not there any more');
    if (!leave.user) throw badRequest('A public holiday is not a request, so there is nothing to decide.');

    leave.status = req.body.status;
    leave.decidedBy = req.user._id;
    leave.decidedAt = new Date();
    leave.decisionNote = req.body.note;
    await leave.save();

    await noticeDecision(leave, req.user);
    await leave.populate(POPULATE);
    res.json(visible(leave, req.user));
  })
);

/**
 * Withdraw or cancel.
 *
 * A request nobody has answered is simply removed — there is no decision to preserve. One
 * that was approved becomes `cancelled` instead, because "it was approved and then it
 * vanished" is not a state a shared calendar should be able to reach quietly.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const { leave, isAdmin } = await loadLeave(req);

    if (leave.status === 'requested' || isAdmin) {
      await Leave.deleteOne({ _id: leave._id });
      // An admin cancelling somebody's approved leave is news to them.
      if (isAdmin && leave.status === 'approved' && idOf(leave.user) !== String(req.user._id)) {
        await Notification.create({
          user: idOf(leave.user),
          type: 'leave-decided',
          actor: req.user._id,
          target: `${leave.start} → ${leave.end}`,
          message: `${nameOf(req.user)} removed your ${leave.type} from ${leave.start} to ${leave.end}`,
          href: '/schedule',
        });
      }
      return res.json({ ok: true, id: req.params.id, removed: true });
    }

    leave.status = 'cancelled';
    leave.updatedBy = req.user._id;
    await leave.save();
    return res.json({ ok: true, id: req.params.id, removed: false, status: leave.status });
  })
);

export default router;
