/**
 * A person's own notes, which belong to no engagement.
 *
 * Every route here is scoped to `req.user` in the query itself rather than by checking ownership
 * after loading. That is the difference between a rule and a habit: a scratchpad that could be
 * read by passing somebody else's id would be worse than not having one, because people would
 * write in it as though it were private.
 *
 * There is no admin override and no sharing. The way a note becomes visible to anybody is
 * `POST /:id/move`, which puts it on an engagement as an ordinary note — on the record, in the
 * activity log, with mentions announced like any other.
 */
import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Scratch } from '../models/scratch.model.js';
import { ACTIONS } from '../models/activity.model.js';
import { recordActivity } from '../services/activity.service.js';
import { notifyMentions } from '../services/activity.service.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const router = Router();

const scratchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  content: z.string().max(200_000).optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
});

const summary = (row) => ({
  _id: row._id,
  title: row.title,
  content: row.content,
  tags: row.tags ?? [],
  pinned: Boolean(row.pinned),
  fromAudit: row.fromAudit ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Everything of mine, pinned first.
 *
 * Unpaginated on purpose. A scratchpad with enough entries to need paging is one somebody should
 * be tidying, and the page searches what it has rather than asking the server on every keystroke —
 * which for a few hundred short notes is both faster and simpler than the alternative.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await Scratch.find({ user: req.user._id })
      .sort({ pinned: -1, updatedAt: -1 })
      .limit(500);
    res.json({ notes: rows.map(summary) });
  })
);

router.post(
  '/',
  validate(scratchSchema),
  asyncHandler(async (req, res) => {
    const row = await Scratch.create({
      ...req.body,
      title: req.body.title || 'Untitled',
      user: req.user._id,
    });
    res.status(201).json(summary(row));
  })
);

router.put(
  '/:id',
  validate(scratchSchema),
  asyncHandler(async (req, res) => {
    const row = await Scratch.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: req.body },
      { new: true }
    );
    if (!row) throw notFound('That note is not here');
    res.json(summary(row));
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await Scratch.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!row) throw notFound('That note is not here');
    res.json({ ok: true, id: req.params.id });
  })
);

/**
 * Moves one onto an engagement, where it stops being private.
 *
 * A copy by default rather than a move: the note is often a personal reference — the payload, the
 * quirk — that stays useful after the part worth telling somebody has been written up. Passing
 * `keep: false` is how you say this one was only ever meant for the engagement.
 *
 * The mention announcement is deliberate. A note that arrives on an engagement naming a colleague
 * should reach them exactly as it would if it had been typed there, and quietly skipping that
 * because of where the text came from would be a surprise the first time somebody relied on it.
 */
router.post(
  '/:id/move',
  validate(
    z.object({
      audit: z.string().regex(/^[0-9a-fA-F]{24}$/),
      keep: z.boolean().optional().default(true),
    })
  ),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await Scratch.findOne({ _id: req.params.id, user: req.user._id });
    if (!row) throw notFound('That note is not here');

    const audit = await Audit.findOne({ _id: req.body.audit, ...visibleAuditFilter(req.user) });
    if (!audit) throw notFound('That engagement is not one you can open');
    if (audit.state === 'APPROVED' || audit.deletedAt) {
      throw badRequest('That engagement is locked, so nothing can be added to it.');
    }

    audit.notes.push({
      title: row.title || 'Untitled note',
      content: row.content ?? '',
      author: req.user._id,
      updatedBy: req.user._id,
      /* Newest first, the same rule the engagement's own note route uses. */
      order: Math.min(0, ...(audit.notes ?? []).map((note) => note.order ?? 0)) - 1,
    });
    await audit.save();
    const note = audit.notes.at(-1);

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.NOTE_CREATED,
      target: note.title,
      meta: { from: 'the scratchpad' },
    });
    const mentions = await notifyMentions({
      body: note.content,
      actor: req.user,
      audit,
      where: 'note',
      title: note.title,
    });

    if (!req.body.keep) await Scratch.deleteOne({ _id: row._id, user: req.user._id });
    else {
      /* Remembered, so the page can say where it went and not offer the same move twice. */
      row.fromAudit = audit._id;
      await row.save();
    }

    res.status(201).json({
      note: { _id: note._id, title: note.title },
      audit: { _id: audit._id, name: audit.name },
      kept: req.body.keep !== false,
      mentions,
    });
  })
);

export default router;
