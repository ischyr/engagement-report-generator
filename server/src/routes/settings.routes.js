import { Router } from 'express';
import { z } from 'zod';

import { Settings } from '../models/settings.model.js';
import { SettingsChange } from '../models/settings-change.model.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { recordSettingsChange } from '../services/settings-audit.service.js';

const router = Router();

const hexColor = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour')
  .transform((v) => v.replace('#', '').toUpperCase());

const settingsSchema = z
  .object({
    /**
     * Who we are on a contract. Not `branding` — that is what the app calls itself on screen,
     * and an NDA needs a registered entity at an address.
     */
    firm: z
      .object({
        legalName: z.string().trim().max(200).optional(),
        address: z.string().max(500).optional(),
        registration: z.string().trim().max(80).optional(),
        vat: z.string().trim().max(80).optional(),
        email: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(60).optional(),
        signatoryName: z.string().trim().max(160).optional(),
        signatoryTitle: z.string().trim().max(120).optional(),
        jurisdiction: z.string().trim().max(160).optional(),
      })
      .optional(),
    branding: z
      .object({
        appName: z.string().trim().max(60).optional(),
        tagline: z.string().trim().max(80).optional(),
        /** A data URI. Bounded because it is served on every page load. */
        logo: z
          .string()
          .max(400_000, 'Logo is too large — use an image under about 300 KB')
          .refine(
            (value) => value === '' || /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(value),
            'The logo must be an image'
          )
          .optional(),
      })
      .optional(),
    report: z
      .object({
        enabled: z.boolean().optional(),
        public: z
          .object({
            cvssColors: z
              .object({
                noneColor: hexColor.optional(),
                lowColor: hexColor.optional(),
                mediumColor: hexColor.optional(),
                highColor: hexColor.optional(),
                criticalColor: hexColor.optional(),
              })
              .optional(),
            remediationColorsComplexity: z
              .object({
                lowColor: hexColor.optional(),
                mediumColor: hexColor.optional(),
                highColor: hexColor.optional(),
              })
              .optional(),
            remediationColorsPriority: z
              .object({
                lowColor: hexColor.optional(),
                mediumColor: hexColor.optional(),
                highColor: hexColor.optional(),
                urgentColor: hexColor.optional(),
              })
              .optional(),
            captionStyle: z.string().trim().max(60).optional(),
            codeBlockTheme: z.enum(['terminal', 'light', 'template']).optional(),
            dateFormat: z.string().trim().max(40).optional(),
            findingIdPrefix: z.string().trim().max(20).optional(),
            extendCvssTemporalEnvironment: z.boolean().optional(),
          })
          .optional(),
        private: z
          .object({
            imageBorder: z.boolean().optional(),
            imageBorderColor: hexColor.optional(),
            updateFieldsOnOpen: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    reviews: z
      .object({
        enabled: z.boolean().optional(),
        public: z
          .object({
            mandatoryReview: z.boolean().optional(),
            minReviewers: z.number().int().min(1).max(20).optional(),
          })
          .optional(),
        private: z.object({ removeApprovalsUponUpdate: z.boolean().optional() }).optional(),
      })
      .optional(),
    /** The rate card. See the block of the same name on the model for why it is this small. */
    sales: z
      .object({
        currency: z.string().trim().min(3).max(3).toUpperCase().optional(),
        dayRate: z.number().min(0).max(1_000_000).nullable().optional(),
        floorDayRate: z.number().min(0).max(1_000_000).nullable().optional(),
        maxDiscountPercent: z.number().min(0).max(100).optional(),
        taxLabel: z.string().trim().max(20).optional(),
        taxPercent: z.number().min(0).max(100).optional(),
        paymentTermsDays: z.number().int().min(0).max(365).optional(),
      })
      .optional(),
    leave: z
      .object({
        allowanceDays: z.number().int().min(0).max(365).optional(),
        requireApproval: z.boolean().optional(),
      })
      .optional(),
    danger: z
      .object({
        enabled: z.boolean().optional(),
        public: z.object({ nbdaydelete: z.number().int().min(1).max(3650).optional() }).optional(),
      })
      .optional(),
  })
  .strict();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await Settings.getSettings());
  })
);

router.put(
  '/',
  requireRole('admin'),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    /*
     * A copy of the relevant values *before* the merge, for the change log.
     *
     * `toObject()` rather than holding the document: `deepAssign` mutates it in place, so
     * anything kept by reference would already have the new values by the time it was read.
     */
    const before = settings.toObject();

    // Nested `set` with dotted paths would clobber siblings; merge instead.
    deepAssign(settings, req.body);
    settings.markModified('report');
    settings.markModified('reviews');
    settings.markModified('sales');
    settings.markModified('leave');
    settings.markModified('danger');
    await settings.save();

    /*
     * Who changed what, and what it was.
     *
     * Every engagement has an activity log; the settings that govern all of them had none, so
     * the review quorum could be lowered or the trash retention shortened with no trace. The
     * diff is driven by what was submitted, so a save that changed nothing records nothing.
     */
    await recordSettingsChange({ actor: req.user, before, after: req.body, req });

    res.json(settings);
  })
);

/**
 * What has been changed here, most recent first.
 *
 * Admin-only like the settings themselves, and deliberately not paginated: an instance's
 * settings change a handful of times a year, and a page of them is the whole history.
 */
router.get(
  '/history',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await SettingsChange.find()
      .populate({ path: 'actor', select: 'username firstname lastname' })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      changes: rows.map((row) => ({
        _id: row._id,
        action: row.action,
        actor: row.actor,
        ip: row.ip,
        at: row.createdAt,
        changes: (row.changes ?? []).map((entry) => ({
          path: entry.path,
          from: entry.from,
          to: entry.to,
        })),
      })),
      total: await SettingsChange.estimatedDocumentCount(),
    });
  })
);

router.post(
  '/reset',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await Settings.deleteOne({ singleton: 'settings' });
    const settings = await Settings.getSettings();
    // Recorded as one entry rather than a diff of everything: "restored the defaults" is what
    // happened, and listing forty paths would bury it.
    await recordSettingsChange({ actor: req.user, action: 'reset', req });
    res.json(settings);
  })
);

function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepAssign(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export default router;
