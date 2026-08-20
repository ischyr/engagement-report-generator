/**
 * Reusable text: yours, and the firm's.
 *
 * Not scoped to an engagement, because the whole point is that it outlives one. Scoped to a
 * person instead: you see your own and everything anybody has shared, and you can only change
 * what is yours — or anything, if you are an admin, because house wording somebody has left
 * behind still needs an owner.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Snippet } from '../models/snippet.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const snippetSchema = z.object({
  title: z.string().trim().min(1, 'Give it a name you will recognise').max(160),
  body: z.string().max(200_000).optional().default(''),
  tags: z.array(z.string().trim().max(40)).max(12).optional().default([]),
  shared: z.boolean().optional().default(false),
});

/** Yours and everything shared, most-used first — a list nobody has to organise. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await Snippet.find({ $or: [{ owner: req.user._id }, { shared: true }] })
      .populate('owner', 'username firstname lastname')
      .sort({ uses: -1, updatedAt: -1 })
      .limit(300);

    res.json(
      rows.map((row) => ({
        _id: row._id,
        title: row.title,
        body: row.body,
        tags: row.tags ?? [],
        shared: row.shared,
        uses: row.uses ?? 0,
        mine: String(row.owner?._id ?? row.owner) === String(req.user._id),
        owner: row.owner,
        updatedAt: row.updatedAt,
      }))
    );
  })
);

router.post(
  '/',
  validate(snippetSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const snippet = await Snippet.create({ ...req.body, owner: req.user._id });
    res.status(201).json(snippet);
  })
);

/** Loads one the caller is allowed to change: their own, or anything if they are an admin. */
async function loadOwn(req) {
  const snippet = await Snippet.findById(req.params.id);
  if (!snippet) throw notFound('That snippet is not there any more');
  const mine = String(snippet.owner) === String(req.user._id);
  if (!mine && req.user.role !== 'admin') {
    throw forbidden('Only its owner or an admin can change a snippet.');
  }
  return snippet;
}

router.put(
  '/:id',
  validate(snippetSchema.partial()),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const snippet = await loadOwn(req);
    snippet.set(req.body);
    await snippet.save();
    res.json(snippet);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const snippet = await loadOwn(req);
    await Snippet.deleteOne({ _id: snippet._id });
    res.json({ ok: true, id: req.params.id });
  })
);

/**
 * Counts a use.
 *
 * Its own endpoint rather than part of the read, because reading the list is not using anything —
 * and the count is what puts the three snippets somebody actually pastes at the top without
 * asking them to arrange anything.
 */
router.post(
  '/:id/used',
  asyncHandler(async (req, res) => {
    const snippet = await Snippet.findOne({
      _id: req.params.id,
      $or: [{ owner: req.user._id }, { shared: true }],
    });
    if (!snippet) throw badRequest('That snippet is not available to you');
    snippet.uses = (snippet.uses ?? 0) + 1;
    snippet.lastUsedAt = new Date();
    await snippet.save({ validateBeforeSave: false });
    res.json({ ok: true, uses: snippet.uses });
  })
);

export default router;
