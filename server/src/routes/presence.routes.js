/**
 * Who is currently working, for the sidebar.
 *
 * Deliberately built on a heartbeat rather than websockets: presence is
 * advisory, a few seconds of staleness costs nothing, and this keeps the whole
 * server a plain request/response app with no extra transport to operate.
 */

import { Router } from 'express';
import { z } from 'zod';

import { User } from '../models/user.model.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/**
 * How long after their last heartbeat someone still counts as online. Comfortably
 * more than the client's interval so a slow request does not blink them out.
 */
export const ONLINE_WINDOW_MS = 75_000;
/** Shorter window for the "active right now" dot versus merely "recently here". */
const ACTIVE_WINDOW_MS = 35_000;

const heartbeatSchema = z.object({
  /** What they are doing, e.g. "editing Acme Portal". Empty clears it. */
  activity: z.string().trim().max(120).optional().default(''),
  /**
   * Which record they have open, e.g. `finding:<audit>:<finding>`. Empty clears it.
   *
   * The point of carrying it on the heartbeat rather than in its own endpoint is that it expires
   * the same way presence does: a browser that closes mid-write leaves no lock behind, because
   * there is no lock — only somebody who was here 20 seconds ago and now is not.
   */
  location: z.string().trim().max(200).optional().default(''),
});

/**
 * Records that the caller is alive. Uses a bare update rather than loading and
 * saving the document, so a heartbeat costs one write and cannot collide with a
 * concurrent profile edit.
 */
router.post(
  '/heartbeat',
  validate(heartbeatSchema),
  asyncHandler(async (req, res) => {
    await User.updateOne(
      { _id: req.user._id },
      { $set: { lastSeenAt: new Date(), activity: req.body.activity, location: req.body.location } }
    );
    res.json({ ok: true, onlineWindowMs: ONLINE_WINDOW_MS });
  })
);

/** Clears presence immediately, so signing out does not leave a ghost online. */
router.post(
  '/leave',
  asyncHandler(async (req, res) => {
    await User.updateOne(
      { _id: req.user._id },
      { $set: { lastSeenAt: null, activity: '', location: '' } }
    );
    res.json({ ok: true });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - ONLINE_WINDOW_MS);
    const users = await User.find({
      lastSeenAt: { $gte: since },
      enabled: true,
      approvedAt: { $ne: null },
    })
      .select('username firstname lastname email roles lastSeenAt activity location')
      .sort({ lastSeenAt: -1 })
      .limit(100);

    const now = Date.now();
    res.json({
      onlineWindowMs: ONLINE_WINDOW_MS,
      users: users.map((user) => ({
        id: user._id.toString(),
        username: user.username,
        firstname: user.firstname,
        lastname: user.lastname,
        fullname: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
        role: user.role,
        activity: user.activity ?? '',
        /** What they have open, for "somebody else is in this finding too". */
        location: user.location ?? '',
        lastSeenAt: user.lastSeenAt,
        /** False when they are inside the window but have gone quiet. */
        active: now - new Date(user.lastSeenAt).getTime() <= ACTIVE_WINDOW_MS,
        isSelf: user._id.equals(req.user._id),
      })),
    });
  })
);

export default router;
