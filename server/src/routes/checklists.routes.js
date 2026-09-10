/**
 * Checklists — the methodologies an engagement's test list is started from.
 *
 * Full CRUD, including the built-in ones. They are marked `builtin` so the UI can
 * label them, but nothing here treats them as read-only: a shipped methodology that
 * cannot be pruned to your own practice is not much use, and `npm run seed` puts
 * them back if you want them again.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Checklist } from '../models/checklist.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireWrite } from '../middleware/auth.js';
import { assertFresh } from '../utils/concurrency.js';

const router = Router();

const checkSchema = z.object({
  title: z.string().trim().min(1, 'A check needs a title').max(300),
  description: z.string().trim().max(2000).optional().default(''),
  category: z.string().trim().max(120).optional().default(''),
  order: z.number().int().optional(),
});

const checklistSchema = z.object({
  name: z.string().trim().min(1, 'Give the checklist a name').max(160),
  description: z.string().trim().max(1000).optional().default(''),
  checks: z.array(checkSchema).optional().default([]),
});

/**
 * Callers send the timestamp they last saw, so a stale write is refused instead of
 * quietly replacing somebody else's edit — the same contract as findings, sections
 * and notes. A checklist is the most shared thing in the app: it is edited by
 * everybody and used by every engagement, which makes it the *most* likely place for
 * two people to overwrite each other, not the least.
 */
const withVersion = (schema) =>
  schema.extend({ expectedUpdatedAt: z.string().datetime().optional() });

/**
 * The freshness token, wherever the verb can carry it.
 *
 * DELETE has no body by convention, so those routes take it as a query parameter.
 */
const versionOf = (req) => req.body?.expectedUpdatedAt ?? req.query?.expectedUpdatedAt;

/** Categories in the order they first appear, which is the order they read in. */
const categoriesOf = (checks) => [
  ...new Set((checks ?? []).map((check) => check.category?.trim() || 'Ungrouped')),
];

/** The list shape, which is also what the engagement preset picker consumes. */
const summarise = (checklist) => ({
  id: checklist._id,
  _id: checklist._id,
  name: checklist.name,
  description: checklist.description ?? '',
  slug: checklist.slug ?? null,
  builtin: Boolean(checklist.builtin),
  count: (checklist.checks ?? []).length,
  categories: categoriesOf(checklist.checks),
  updatedAt: checklist.updatedAt,
});

async function load(id) {
  const checklist = await Checklist.findById(id);
  if (!checklist) throw notFound('Checklist not found');
  return checklist;
}

/** Keeps `order` dense and sequential after any insert or removal. */
function renumber(checklist) {
  checklist.checks.forEach((check, index) => {
    check.order = index;
  });
}

/* -------------------------------------------------------------------------- */

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const checklists = await Checklist.find().sort({ builtin: -1, name: 1 });
    res.json(checklists.map(summarise));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    await checklist.populate([
      { path: 'createdBy', select: 'username firstname lastname' },
      { path: 'updatedBy', select: 'username firstname lastname' },
    ]);
    res.json(checklist);
  })
);

router.post(
  '/',
  requireWrite,
  validate(checklistSchema),
  asyncHandler(async (req, res) => {
    const checklist = await Checklist.create({
      ...req.body,
      checks: (req.body.checks ?? []).map((check, index) => ({ ...check, order: index })),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    res.status(201).json(checklist);
  })
);

/** Renames or re-describes. Checks have their own endpoints below. */
router.put(
  '/:id',
  requireWrite,
  validate(withVersion(checklistSchema.partial().omit({ checks: true }))),
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    const { expectedUpdatedAt, ...patch } = req.body;

    // Against the details marker, not `updatedAt`: adding a check elsewhere must not
    // make a rename look like a conflict.
    assertFresh({ updatedAt: checklist.detailsUpdatedAt }, expectedUpdatedAt, {
      label: `the checklist "${checklist.name}"`,
      current: checklist,
    });

    checklist.set({ ...patch, updatedBy: req.user._id, detailsUpdatedAt: new Date() });
    await checklist.save();
    res.json(checklist);
  })
);

/** Copying a methodology is how most teams start their own version of it. */
router.post(
  '/:id/duplicate',
  requireWrite,
  asyncHandler(async (req, res) => {
    const source = await load(req.params.id);
    const copy = await Checklist.create({
      name: `${source.name} (copy)`,
      description: source.description,
      // A copy is yours: no slug, not built in, so seeding never overwrites it.
      slug: null,
      builtin: false,
      checks: (source.checks ?? []).map((check, index) => ({
        title: check.title,
        description: check.description,
        category: check.category,
        order: index,
      })),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    res.status(201).json(copy);
  })
);

router.delete(
  '/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    // Deleting a shared methodology affects everyone, so it is the creator's or an
    // admin's call. Built-in ones have no creator, hence admin-only.
    const mine = checklist.createdBy && checklist.createdBy.equals(req.user._id);
    if (!mine && req.user.role !== 'admin') {
      throw forbidden('Only the person who created this checklist, or an admin, can delete it');
    }
    await checklist.deleteOne();
    res.json({ ok: true, id: req.params.id });
  })
);

/* ------------------------------- the checks -------------------------------- */

router.post(
  '/:id/checks',
  requireWrite,
  validate(checkSchema),
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    checklist.checks.push({ ...req.body, order: checklist.checks.length });
    checklist.updatedBy = req.user._id;
    await checklist.save();
    res.status(201).json(checklist.checks.at(-1));
  })
);

/**
 * Adds many at once, one per line.
 *
 * A methodology usually arrives as a list already — pasted out of a document or
 * another tool — and adding forty items through a single-line form is the kind of
 * friction that stops people from curating their checklists at all.
 */
router.post(
  '/:id/checks/bulk',
  requireWrite,
  validate(
    z.object({
      text: z.string().min(1, 'Paste at least one line'),
      category: z.string().trim().max(120).optional().default(''),
    })
  ),
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);

    const existing = new Set(
      checklist.checks.map((check) => `${check.category ?? ''}|${check.title}`.toLowerCase())
    );

    let added = 0;
    let skipped = 0;
    let category = req.body.category ?? '';

    for (const rawLine of req.body.text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // A line ending in a colon, or wrapped in [brackets], starts a new category —
      // so a pasted methodology keeps its structure instead of flattening.
      const heading = /^\[(.+)\]$/.exec(line) ?? /^(.{2,60}):$/.exec(line);
      if (heading) {
        category = heading[1].trim();
        continue;
      }

      const title = line.replace(/^[-*•\d.)\s]+/, '').trim();
      if (!title) continue;

      const key = `${category}|${title}`.toLowerCase();
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      checklist.checks.push({ title, category, order: checklist.checks.length });
      added += 1;
    }

    if (added === 0 && skipped === 0) throw badRequest('Nothing in that text looked like a check.');

    checklist.updatedBy = req.user._id;
    renumber(checklist);
    await checklist.save();
    res.json({ added, skipped, checklist });
  })
);

router.put(
  '/:id/checks/:checkId',
  requireWrite,
  validate(withVersion(checkSchema.partial())),
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    const check = checklist.checks.id(req.params.checkId);
    if (!check) throw notFound('Check not found');

    const { expectedUpdatedAt, ...patch } = req.body;
    // Per check, not per checklist: two people editing different checks in the same
    // methodology are not in conflict, and treating them as such would be noise.
    assertFresh(check, expectedUpdatedAt, {
      label: `the check "${check.title}"`,
      current: check,
    });

    check.set(patch);
    checklist.updatedBy = req.user._id;
    await checklist.save();
    res.json(check);
  })
);

router.delete(
  '/:id/checks/:checkId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);
    const check = checklist.checks.id(req.params.checkId);
    if (!check) throw notFound('Check not found');

    // Refuses to delete a check somebody has edited since you last saw it — the
    // wording you are removing may no longer be the wording you read.
    assertFresh(check, versionOf(req), {
      label: `the check "${check.title}"`,
      current: check,
    });

    check.deleteOne();
    checklist.updatedBy = req.user._id;
    renumber(checklist);
    await checklist.save();
    res.json({ ok: true, id: req.params.checkId, remaining: checklist.checks.length });
  })
);

/** Clears a whole category, for pruning a shipped methodology to scope. */
router.delete(
  '/:id/categories/:category',
  requireWrite,
  asyncHandler(async (req, res) => {
    const checklist = await load(req.params.id);

    /*
     * Guarded against the whole checklist, deliberately. A concurrent addition
     * elsewhere will make this fail even though it touched a different category —
     * but this route removes many checks at once, and a needless retry costs
     * nothing next to deleting items a colleague added seconds ago.
     */
    assertFresh(checklist, versionOf(req), {
      label: `the checklist "${checklist.name}"`,
      current: checklist,
    });

    const target = decodeURIComponent(req.params.category);
    const before = checklist.checks.length;

    checklist.checks = checklist.checks.filter(
      (check) => (check.category?.trim() || 'Ungrouped') !== target
    );
    if (checklist.checks.length === before) throw notFound('No checks in that category');

    checklist.updatedBy = req.user._id;
    renumber(checklist);
    await checklist.save();
    res.json({ ok: true, removed: before - checklist.checks.length });
  })
);

export default router;
