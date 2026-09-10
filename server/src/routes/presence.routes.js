/**
 * Who is currently working, for the sidebar.
 *
 * Deliberately built on a heartbeat rather than websockets: presence is
 * advisory, a few seconds of staleness costs nothing, and this keeps the whole
 * server a plain request/response app with no extra transport to operate.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { ONLINE_WINDOW_MS, liveSnapshot, presenceRoster } from '../services/live.service.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';

const router = Router();

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
 * Records that the caller is alive, and answers with everything they poll for.
 *
 * Uses a bare update rather than loading and saving the document, so a heartbeat costs one write
 * and cannot collide with a concurrent profile edit.
 *
 * It used to answer `{ ok: true }`, and the client then made two more requests on two more timers
 * to ask who was online and whether anything had happened. Since something has to tell the server
 * this browser is still here, the heartbeat is the one request that cannot be removed — so it is
 * the one that answers. The update comes first, so the caller appears in the roster it is handed
 * rather than in the next one.
 *
 * The old `GET /presence` and `GET /notifications` are untouched and still correct: a page that
 * wants either on its own still has it, and `liveSnapshot` is how this cannot drift from them.
 */
router.post(
  '/heartbeat',
  validate(heartbeatSchema),
  asyncHandler(async (req, res) => {
    await User.updateOne(
      { _id: req.user._id },
      { $set: { lastSeenAt: new Date(), activity: req.body.activity, location: req.body.location } }
    );
    res.json({ ok: true, ...(await liveSnapshot(req.user)) });
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

/**
 * The roster on its own.
 *
 * Still here, and still the same roster: the heartbeat answers with this now, so nothing the app
 * itself does calls this any more — but it is a documented shape somebody's script may read, and
 * `presenceRoster` is what stops the two from drifting apart.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ onlineWindowMs: ONLINE_WINDOW_MS, users: await presenceRoster(req.user) });
  })
);

/**
 * A location key, resolved to the thing it names.
 *
 * The client writes `engagement:<id>:<tab>` and `finding:<id>:<findingId>`, and `FollowBar` turns
 * those back into routes. This turns them back into *nouns*, which is what a board needs: an
 * engagement's name and the part of it somebody is in.
 */
function readLocation(key) {
  const parts = String(key ?? '').split(':');
  if (parts[0] === 'finding' && parts[1]) return { audit: parts[1], where: 'a finding' };
  if (parts[0] === 'engagement' && parts[1]) return { audit: parts[1], where: parts[2] || '' };
  return { audit: null, where: '' };
}

/**
 * Who is where, and what nobody is looking at.
 *
 * The heartbeat has always known this and nothing ever aggregated it: presence fed a row of
 * avatars in the sidebar and a "somebody else is in this finding" banner, both of which answer a
 * question about *one* record. A lead running three engagements at once has the opposite question,
 * and had to open each one to answer it.
 *
 * Three lists, and the third is the point. "Who is online" is pleasant; "which engagement has had
 * nobody in it since Tuesday" is the one that changes what somebody does next.
 */
router.get(
  '/board',
  asyncHandler(async (req, res) => {
    const now = Date.now();
    const since = new Date(now - ONLINE_WINDOW_MS);

    const [online, away, audits] = await Promise.all([
      User.find({ lastSeenAt: { $gte: since }, enabled: true, approvedAt: { $ne: null } })
        .select('username firstname lastname roles lastSeenAt activity location')
        .sort({ lastSeenAt: -1 })
        .limit(100),
      User.find({
        enabled: true,
        approvedAt: { $ne: null },
        $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: since } }],
      })
        .select('username firstname lastname roles lastSeenAt')
        .sort({ lastSeenAt: -1 })
        .limit(60),
      /* Only what this person may see: a board that named engagements they cannot open would
         be a listing of clients they are not on. */
      Audit.find({ ...visibleAuditFilter(req.user), state: { $ne: 'APPROVED' }, deletedAt: null })
        .select('name reference state onHold updatedAt creator collaborators date_end')
        .populate({ path: 'creator', select: 'username firstname lastname' })
        .populate({ path: 'collaborators', select: 'username firstname lastname' })
        .sort({ updatedAt: 1 })
        .limit(200),
    ]);

    const byAudit = new Map(audits.map((audit) => [String(audit._id), audit]));
    const person = (user) => ({
      id: String(user._id),
      username: user.username,
      fullname: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
      lastSeenAt: user.lastSeenAt ?? null,
    });

    const here = online.map((user) => {
      const { audit, where } = readLocation(user.location);
      const record = audit ? byAudit.get(String(audit)) : null;
      return {
        ...person(user),
        activity: user.activity ?? '',
        where,
        /* Null when they are in something this reader cannot see, which reads as "elsewhere". */
        engagement: record
          ? { _id: record._id, name: record.name, reference: record.reference ?? '' }
          : null,
        isSelf: user._id.equals(req.user._id),
        idle: now - new Date(user.lastSeenAt).getTime() > 35_000,
      };
    });

    const busy = new Set(here.map((entry) => String(entry.engagement?._id ?? '')).filter(Boolean));
    const day = 86_400_000;

    const quiet = audits
      .map((audit) => ({
        _id: audit._id,
        name: audit.name,
        reference: audit.reference ?? '',
        state: audit.state,
        onHold: Boolean(audit.onHold),
        /* Whole days, so "today" is 0 rather than a fraction of one. */
        untouchedDays: Math.floor((now - new Date(audit.updatedAt).getTime()) / day),
        dueOn: audit.date_end ?? null,
        team: [audit.creator, ...(audit.collaborators ?? [])].filter(Boolean).map(person),
        somebodyIn: busy.has(String(audit._id)),
      }))
      /* Somebody is in it right now, so it is not quiet whatever its timestamp says. */
      .filter((audit) => !audit.somebodyIn && audit.untouchedDays >= 1)
      .sort((a, b) => b.untouchedDays - a.untouchedDays);

    res.json({
      onlineWindowMs: ONLINE_WINDOW_MS,
      here,
      away: away.map(person),
      quiet,
      counts: { here: here.length, away: away.length, quiet: quiet.length, open: audits.length },
    });
  })
);

export default router;
