/**
 * The notifications bar.
 *
 * Polled on the same schedule as presence rather than pushed, for the same
 * reason: a few seconds of lag on "someone mentioned you" is invisible, and it
 * keeps the server a plain request/response app.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  Notification,
  NOTIFICATION_TYPES,
  READ_TTL_MS,
  UNREAD_TTL_MS,
} from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { ALWAYS_ON, isMutable } from '../services/notify.service.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/** Newest first, with the unread count the badge shows. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const filter = { user: req.user._id };
    if (req.query.unread === 'true') filter.read = false;

    const [items, unread] = await Promise.all([
      Notification.find(filter)
        .populate('actor', 'username firstname lastname')
        .sort({ createdAt: -1 })
        .limit(limit),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);

    res.json({ unread, items });
  })
);

/** Just the badge, for the poll — cheap enough to call often. */
router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const unread = await Notification.countDocuments({ user: req.user._id, read: false });
    res.json({ unread });
  })
);

router.post(
  '/:id/read',
  validate(z.object({ read: z.boolean().optional().default(true) })),
  asyncHandler(async (req, res) => {
    // Scoped to the caller, so an id from someone else's bar is simply not found.
    const notification = await Notification.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!notification) throw notFound('Notification not found');

    notification.read = req.body.read;
    notification.readAt = req.body.read ? new Date() : null;
    /*
     * Reading it shortens its life; marking it unread again gives the time back.
     *
     * Both directions, because this route does both — a notification put back to unread is one
     * somebody means to return to, and expiring it a month later on the strength of a click they
     * undid would be the opposite of what they asked for.
     */
    notification.expiresAt = new Date(
      Date.now() + (req.body.read ? READ_TTL_MS : UNREAD_TTL_MS)
    );
    await notification.save();
    res.json(notification);
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true, readAt: new Date(), expiresAt: new Date(Date.now() + READ_TTL_MS) } }
    );
    res.json({ ok: true, marked: result.modifiedCount ?? 0 });
  })
);

/** Clearing the bar. Read ones only, so nothing unseen is thrown away. */
router.delete(
  '/read',
  asyncHandler(async (req, res) => {
    const result = await Notification.deleteMany({ user: req.user._id, read: true });
    res.json({ ok: true, removed: result.deletedCount ?? 0 });
  })
);

/**
 * What each kind of notification is, and whether you have it on.
 *
 * The words live here rather than in the browser because the list they describe lives here: a
 * nineteenth kind added to `NOTIFICATION_TYPES` should appear on the settings page without
 * anybody remembering to write it there too, and a label the server does not know about is a
 * label for a notification that no longer exists.
 *
 * Grouped, because nineteen switches in one column is a list nobody reads to the bottom of — and
 * the groups are about *why* you would turn something off rather than about where it came from.
 */
const CATALOGUE = [
  {
    group: 'Work that is yours',
    hint: 'Somebody has handed you something, or is waiting on you.',
    types: [
      ['finding-assigned', 'A finding becomes yours to write'],
      ['check-assigned', 'A test check is assigned to you'],
      ['review-requested', 'You are asked to review an engagement'],
      ['second-opinion-asked', 'Somebody asks what you think about one finding'],
      ['second-opinion-given', 'Your question about a finding is answered'],
    ],
  },
  {
    group: 'People talking',
    hint: 'Mentions and comments on what you wrote.',
    types: [
      ['mention', 'Somebody @mentions you'],
      ['comment-on-your-finding', 'Somebody comments on a finding you wrote'],
    ],
  },
  {
    group: 'The diary',
    hint: 'Bookings, leave and dates coming round. The noisiest group on a busy instance.',
    types: [
      ['booking-soon', 'A booking of yours starts in the next two days'],
      ['booking-changed', 'A booking of yours is moved or cancelled'],
      ['leave-requested', 'Somebody asks for time off'],
      ['leave-decided', 'Your time off is approved or refused'],
      ['engagement-due', 'An engagement that recurs is due again'],
    ],
  },
  {
    group: 'The client',
    hint: 'What reaches you from outside the firm, through a client link.',
    types: [
      ['client-updated-finding', 'A client marks a finding fixed or disputes it'],
      ['client-asked-question', 'A client asks a question'],
    ],
  },
  {
    group: 'The instance',
    hint: 'Things the app itself needs to tell you.',
    types: [
      ['render-failed', 'A report you asked for failed to generate'],
      ['engagement-held', 'An engagement is stopped'],
      ['account-awaiting-approval', 'Somebody is waiting for their account to be approved'],
      ['new-sign-in', 'A new sign-in on your account'],
      ['account-approved', 'Your account is approved'],
    ],
  },
];

router.get(
  '/preferences',
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user._id).select('notificationsOff').lean();
    const off = me?.notificationsOff ?? {};

    res.json({
      groups: CATALOGUE.map((group) => ({
        ...group,
        types: group.types.map(([type, label]) => ({
          type,
          label,
          /* Said by the server rather than inferred from a list the browser keeps its own copy of:
             the two types that cannot be switched off are a rule, not a presentation choice. */
          locked: !isMutable(type),
          on: isMutable(type) ? off[type] !== true : true,
        })),
      })),
      /** For the page's own sanity check: a type in neither the catalogue nor the schema. */
      unlisted: NOTIFICATION_TYPES.filter(
        (type) => !CATALOGUE.some((group) => group.types.some(([known]) => known === type))
      ),
      alwaysOn: [...ALWAYS_ON],
    });
  })
);

/**
 * Turns one kind on or off.
 *
 * One at a time rather than a whole map, so a switch is a request and a request is a switch —
 * sending the lot back would make two people changing their own settings in two tabs able to undo
 * each other, which for a personal preference is a surprising way to lose a decision.
 *
 * A type that cannot be muted is refused rather than quietly ignored: the page already knows which
 * those are, so a request to mute one is a bug somewhere, and answering "fine" to it would hide
 * the bug behind a switch that springs back.
 */
router.put(
  '/preferences/:type',
  validate(z.object({ on: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { type } = req.params;
    if (!NOTIFICATION_TYPES.includes(type)) throw notFound('No notification of that kind');
    if (!isMutable(type)) {
      throw badRequest('That one cannot be switched off — it is how you find out about the others.');
    }

    /*
     * Stored as what is *off*, so the field stays empty for everybody who has never changed
     * anything — which is what makes "absent means yes" a safe default rather than a guess.
     */
    await User.updateOne(
      { _id: req.user._id },
      req.body.on
        ? { $unset: { [`notificationsOff.${type}`]: '' } }
        : { $set: { [`notificationsOff.${type}`]: true } }
    );

    res.json({ ok: true, type, on: req.body.on });
  })
);

export default router;
