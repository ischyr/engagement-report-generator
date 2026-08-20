import { Router } from 'express';
import { z } from 'zod';

import { Vulnerability } from '../models/vulnerability.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireWrite } from '../middleware/auth.js';
import { calculateCvss, CVSS_DEFAULT_VECTOR } from '../services/cvss.js';
import { normaliseTitle } from '../services/finding-history.service.js';
import { mediaIdsInHtml } from '../services/media.service.js';
import { contentDisposition } from '../utils/content-disposition.js';

const router = Router();

const customFieldValue = z.object({
  key: z.string(),
  label: z.string().optional().default(''),
  fieldType: z.string().optional().default('input'),
  value: z.any().optional().default(''),
});

const detailSchema = z.object({
  locale: z.string().trim().min(2).max(10).default('en'),
  title: z.string().trim().max(400).default(''),
  vulnType: z.string().trim().max(120).default(''),
  description: z.string().default(''),
  observation: z.string().default(''),
  remediation: z.string().default(''),
  references: z.array(z.string().trim()).default([]),
  customFields: z.array(customFieldValue).default([]),
});

const createSchema = z.object({
  cvssv3: z.string().trim().max(300).default(CVSS_DEFAULT_VECTOR),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  remediationComplexity: z.number().int().min(1).max(3).nullable().optional(),
  category: z.string().trim().max(120).default(''),
  details: z.array(detailSchema).min(1, 'At least one localised detail is required'),
});

/** Attaches the computed score so lists can sort and colour without recomputing. */
const decorate = (doc) => {
  const object = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const cvss = calculateCvss(object.cvssv3);
  return {
    ...object,
    cvssScore: cvss.baseScore,
    severity: cvss.baseSeverity,
  };
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { locale, category, search, severity } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (locale) filter['details.locale'] = locale;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'details.title': rx }, { 'details.description': rx }, { category: rx }];
    }

    let list = (await Vulnerability.find(filter).sort({ updatedAt: -1 }).limit(2000)).map(decorate);
    // Severity is derived, so it has to be filtered after the query.
    if (severity) list = list.filter((v) => v.severity === severity);

    res.json(list);
  })
);

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const categories = await Vulnerability.distinct('category');
    res.json(categories.filter(Boolean).sort());
  })
);

// Declared before `/:id`, or Express would read "export" as an id.
/* ------------------------------- bundles ---------------------------------- */

/** What an exported file says it is, so an import can refuse the wrong thing. */
const BUNDLE_FORMAT = 'engy-vulnerability-library';
const BUNDLE_VERSION = 1;

/** The fields that travel. Ids, authorship and timestamps belong to an instance. */
const forExport = (entry) => ({
  cvssv3: entry.cvssv3,
  priority: entry.priority ?? null,
  remediationComplexity: entry.remediationComplexity ?? null,
  category: entry.category ?? '',
  details: (entry.details ?? []).map((detail) => ({
    locale: detail.locale ?? 'en',
    title: detail.title ?? '',
    vulnType: detail.vulnType ?? '',
    description: detail.description ?? '',
    observation: detail.observation ?? '',
    remediation: detail.remediation ?? '',
    references: detail.references ?? [],
    customFields: detail.customFields ?? [],
  })),
});

/**
 * How an incoming entry is matched against what is already here.
 *
 * Category plus the normalised title of its first locale — the same notion of "the same
 * issue" the recurrence check uses across a client's engagements, so the two cannot
 * disagree about what counts as a duplicate.
 */
const bundleKey = (entry) => {
  const detail = (entry.details ?? []).find((d) => d.title) ?? entry.details?.[0] ?? {};
  return `${String(entry.category ?? '').toLowerCase().trim()}|${normaliseTitle(detail.title)}`;
};

/** How many stored screenshots an entry's text points at. */
const mediaCount = (entry) => {
  let count = 0;
  for (const detail of entry.details ?? []) {
    for (const field of ['description', 'observation', 'remediation']) {
      // A Set, not an array — `.length` here silently produced NaN.
      count += mediaIdsInHtml(detail?.[field]).size;
    }
  }
  return count;
};

/**
 * The whole library as one file.
 *
 * A library could only be built by hand, one entry at a time, in this instance: no way to
 * seed a new one, keep it in git, share it with a colleague's laptop or start from a
 * published set. `POST /import` has always existed — with no export to feed it, and no UI
 * to reach either.
 *
 * Screenshots are *not* in the bundle. They live in this instance's storage as
 * `/api/media/<id>` references, and inlining them would turn a readable file into
 * megabytes of base64, so the count is reported and the references travel as-is.
 */
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const entries = await Vulnerability.find().sort({ category: 1, 'details.title': 1 }).lean();
    const withMedia = entries.filter((entry) => mediaCount(entry) > 0).length;

    const bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      /** Told plainly, because it is the one thing this file cannot carry. */
      entriesReferencingScreenshots: withMedia,
      entries: entries.map(forExport),
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`vulnerability-library-${entries.length}-entries.json`)
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(JSON.stringify(bundle, null, 2));
  })
);

const importSchema = z.object({
  /** A whole exported bundle, or just the entries. Both are accepted. */
  format: z.string().optional(),
  version: z.number().optional(),
  entries: z.array(createSchema).optional(),
  vulnerabilities: z.array(createSchema).optional(),
  /**
   * What to do with an entry that is already here. Skipping is the default because
   * re-importing a bundle should be safe, not destructive.
   */
  mode: z.enum(['skip', 'update']).optional().default('skip'),
});

/**
 * Bringing a bundle in, twice if you like.
 *
 * The old version inserted whatever it was given, so importing the same file twice left
 * two of everything — which made the endpoint unusable for the thing it existed for.
 * Existing entries are now matched and either skipped or updated, and the answer says
 * which happened to how many.
 */
router.post(
  '/import',
  requireWrite,
  validate(importSchema),
  asyncHandler(async (req, res) => {
    const incoming = req.body.entries ?? req.body.vulnerabilities ?? [];
    if (!incoming.length) throw badRequest('That file contains no library entries.');
    if (incoming.length > 5000) throw badRequest('Import is limited to 5000 entries at a time');
    if (req.body.format && req.body.format !== BUNDLE_FORMAT) {
      throw badRequest(`That file says it is "${req.body.format}", not a library bundle.`);
    }
    if (req.body.version && req.body.version > BUNDLE_VERSION) {
      throw badRequest(
        `That bundle was written by a newer version (${req.body.version}) than this instance understands.`
      );
    }

    const existing = await Vulnerability.find().select('category details cvssv3').lean();
    const byKey = new Map(existing.map((entry) => [bundleKey(entry), entry._id]));

    const added = [];
    const updates = [];
    let skipped = 0;
    let missingMedia = 0;

    // Within-file duplicates count as duplicates too, or a bundle containing the same
    // entry twice would still land twice.
    const seen = new Set();

    for (const entry of incoming) {
      const key = bundleKey(entry);
      missingMedia += mediaCount(entry);

      if (seen.has(key) || byKey.has(key)) {
        if (byKey.has(key) && req.body.mode === 'update') {
          updates.push({ _id: byKey.get(key), entry });
        } else {
          skipped += 1;
        }
        continue;
      }
      seen.add(key);
      added.push({ ...entry, createdBy: req.user._id });
    }

    if (added.length) await Vulnerability.insertMany(added, { ordered: false });
    for (const { _id, entry } of updates) {
      await Vulnerability.updateOne({ _id }, { $set: forExport(entry) });
    }

    res.status(201).json({
      added: added.length,
      updated: updates.length,
      skipped,
      /** Screenshot references that point at storage this instance may not have. */
      danglingScreenshots: missingMedia,
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const vulnerability = await Vulnerability.findById(req.params.id);
    if (!vulnerability) throw notFound('Vulnerability not found');
    res.json(decorate(vulnerability));
  })
);

router.post(
  '/',
  requireWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const vulnerability = await Vulnerability.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json(decorate(vulnerability));
  })
);

router.put(
  '/:id',
  requireWrite,
  validate(createSchema.partial()),
  asyncHandler(async (req, res) => {
    const vulnerability = await Vulnerability.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!vulnerability) throw notFound('Vulnerability not found');
    res.json(decorate(vulnerability));
  })
);

router.delete(
  '/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const vulnerability = await Vulnerability.findByIdAndDelete(req.params.id);
    if (!vulnerability) throw notFound('Vulnerability not found');
    res.json({ ok: true, id: req.params.id });
  })
);

export default router;
