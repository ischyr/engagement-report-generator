/**
 * The notifications bar.
 *
 * Polled on the same schedule as presence rather than pushed, for the same
 * reason: a few seconds of lag on "someone mentioned you" is invisible, and it
 * keeps the server a plain request/response app.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Notification } from '../models/notification.model.js';
import asyncHandler from '../utils/async-handler.js';
import { notFound } from '../utils/http-error.js';
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
    await notification.save();
    res.json(notification);
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true, readAt: new Date() } }
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

export default router;
