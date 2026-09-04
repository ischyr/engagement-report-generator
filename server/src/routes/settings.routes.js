import { Router } from 'express';
import { z } from 'zod';

import { Settings } from '../models/settings.model.js';
import { MAIL_PROVIDERS, mailConfig, sendMail } from '../services/mail/index.js';
import { testEmail } from '../services/mail/templates.js';
import {
  ASSISTANT_PROVIDERS,
  askAssistant,
  assistantConfig,
  JOB_KEYS,
  providerPreset,
} from '../services/assistant/index.js';
import { encryptSecret, vaultEnabled, VAULT_DISABLED_MESSAGE } from '../services/vault.service.js';
import { SettingsChange } from '../models/settings-change.model.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { badRequest } from '../utils/http-error.js';
import { requireRole } from '../middleware/auth.js';
import { recordSettingsChange } from '../services/settings-audit.service.js';

const router = Router();

const hexColor = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour')
  .transform((v) => v.replace('#', '').toUpperCase());

/**
 * How this instance sends mail.
 *
 * `password` is write-only and has no counterpart in the document: it is encrypted into
 * `email.secret` by the handler, and an empty string clears it. The field the browser reads back
 * is `hasPassword`, which is a boolean.
 *
 * Named rather than inlined because the test-send route takes the same shape — it tries the
 * values on the form, which is the only way to find out whether they are right before saving them.
 */
const emailSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(Object.keys(MAIL_PROVIDERS)).optional(),
  host: z.string().trim().max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(['tls', 'starttls', 'none']).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(400).optional(),
  fromName: z.string().trim().max(120).optional(),
  fromAddress: z.string().trim().max(200).optional(),
  replyTo: z.string().trim().max(200).optional(),
  allowInvalidCertificates: z.boolean().optional(),
  allowPlaintextAuth: z.boolean().optional(),
  notifications: z.boolean().optional(),
});

/**
 * The optional assistant, in the same shape as the mail block above and for the same reasons.
 *
 * `key` is write-only and has no counterpart in the document: it is encrypted into
 * `assistant.secret` by the handler, and an empty string clears it. The field the browser reads
 * back is `hasKey`, which is a boolean.
 *
 * Named rather than inlined because the test route takes the same shape — it tries the values on
 * the form, which is the only way to find out whether they are right before saving them.
 */
const assistantSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(Object.keys(ASSISTANT_PROVIDERS)).optional(),
  wire: z.enum(['anthropic', 'openai']).optional(),
  endpoint: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  key: z.string().max(400).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).optional(),
  houseStyle: z.string().max(2000).optional(),
  jobs: z.object(Object.fromEntries(JOB_KEYS.map((job) => [job, z.boolean().optional()]))).optional(),
  allowRestricted: z.boolean().optional(),
});

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
    email: emailSchema.optional(),
    assistant: assistantSchema.optional(),
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
            figureNumbering: z.boolean().optional(),
            figureLabel: z.string().trim().max(30).optional(),
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

/**
 * Everything the app runs on — read by every signed-in account, not only by admins.
 *
 * Which is why the mail block is trimmed on the way out. The password is never in it for anybody,
 * and the server it goes through is nobody's business but an administrator's; a tester still needs
 * to know whether the "Email it" button on a delivery will work, and that is one boolean.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(forClient(await Settings.getSettings(), req.user));
  })
);

function forClient(settings, user) {
  const plain = settings.toObject();
  const email = plain.email ?? {};
  const assistant = plain.assistant ?? {};
  const hasPassword = Boolean(process.env.SMTP_PASSWORD || email.secret?.data);
  const hasKey = Boolean(process.env.ASSISTANT_API_KEY || assistant.secret?.data);

  if (user?.role !== 'admin') {
    plain.email = { enabled: Boolean(email.enabled), configured: Boolean(email.enabled && email.host) };
    /*
     * A tester needs to know whether the assistant exists on this instance, and nothing else about
     * it. Which endpoint an administrator chose and which model it runs is not their business, and
     * the endpoint in particular is somewhere a key gets sent.
     */
    plain.assistant = { enabled: Boolean(assistant.enabled) };
    return plain;
  }

  delete assistant.secret;
  plain.assistant = {
    ...assistant,
    hasKey,
    /** Where the key is coming from, because "it is set but not here" is confusing otherwise. */
    keyFromEnvironment: Boolean(process.env.ASSISTANT_API_KEY),
    vaultAvailable: vaultEnabled(),
  };

  delete email.secret;
  plain.email = {
    ...email,
    hasPassword,
    /** Where the password is coming from, because "it is set but not here" is confusing otherwise. */
    passwordFromEnvironment: Boolean(process.env.SMTP_PASSWORD),
    vaultAvailable: vaultEnabled(),
    configured: Boolean(email.enabled && email.host),
  };
  return plain;
}

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

    /*
     * The password never reaches `deepAssign`.
     *
     * It is not a field of the document — the document holds `email.secret`, which is ciphertext.
     * An empty string is a deliberate "forget it", which is different from the field being absent
     * and meaning "leave it alone".
     */
    const body = { ...req.body };
    /* The assistant key travels the same road as the SMTP password, one field further along. */
    if (body.assistant && 'key' in body.assistant) {
      if (!settings.assistant) settings.assistant = {};
      const { key, ...rest } = body.assistant;
      body.assistant = rest;
      if (key === '') {
        settings.assistant.secret = { iv: '', tag: '', data: '' };
      } else if (key) {
        if (!vaultEnabled()) throw badRequest(VAULT_DISABLED_MESSAGE);
        settings.assistant.secret = encryptSecret(key);
      }
    }
    if (body.email && 'password' in body.email) {
      /* A settings document written before this block existed has no `email` to write into. */
      if (!settings.email) settings.email = {};
      const { password, ...rest } = body.email;
      body.email = rest;
      if (password === '') {
        settings.email.secret = { iv: '', tag: '', data: '' };
      } else if (password) {
        if (!vaultEnabled()) throw badRequest(VAULT_DISABLED_MESSAGE);
        settings.email.secret = encryptSecret(password);
      }
    }

    // Nested `set` with dotted paths would clobber siblings; merge instead.
    deepAssign(settings, body);
    settings.markModified('report');
    settings.markModified('email');
    settings.markModified('assistant');
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

    res.json(forClient(settings, req.user));
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

/**
 * The provider presets, so the form does not have to hardcode a port number.
 *
 * Served rather than duplicated in the client: the note beside each one is the difference between
 * "authentication failed" and "Gmail wants an app password", and there must be one copy of it.
 */
router.get(
  '/email/providers',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    res.json({
      providers: Object.entries(MAIL_PROVIDERS).map(([key, preset]) => ({ key, ...preset })),
      vaultAvailable: vaultEnabled(),
      passwordFromEnvironment: Boolean(process.env.SMTP_PASSWORD),
    });
  })
);

/**
 * Sends one message to prove the configuration works.
 *
 * Takes the form's current values rather than only the saved ones, because the question somebody
 * has is "are these details right", and making them save a broken configuration first in order to
 * find out that it is broken is the wrong order. Nothing is written either way.
 *
 * The reply carries the SMTP conversation on failure — minus the credentials, which the client
 * never puts in the transcript. A refusal from a mail server is one line that says exactly what is
 * wrong, and hiding it behind "could not send" is how an afternoon disappears.
 */
router.post(
  '/email/test',
  requireRole('admin'),
  validate(
    z
      .object({
        to: z.string().trim().max(200).optional(),
        email: emailSchema.optional(),
      })
      .strict()
  ),
  asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    const config = await mailConfig(settings);

    /* The form's values on top of the saved ones, without touching the document. */
    const draft = req.body.email ?? {};
    const merged = {
      ...config,
      enabled: draft.enabled ?? true,
      host: draft.host ?? config.host,
      port: draft.port ?? config.port,
      security: draft.security ?? config.security,
      username: draft.username ?? config.username,
      password: draft.password || config.password,
      from: {
        name: draft.fromName ?? config.from.name,
        email: draft.fromAddress ?? config.from.email,
      },
      replyTo: draft.replyTo ?? config.replyTo,
      allowInvalidCertificates: draft.allowInvalidCertificates ?? config.allowInvalidCertificates,
      allowPlaintextAuth: draft.allowPlaintextAuth ?? config.allowPlaintextAuth,
    };

    if (!merged.host) throw badRequest('Fill in the mail server host first.');
    if (!merged.from.email) throw badRequest('Fill in the From address first.');

    const to = req.body.to || req.user.email;
    if (!to) throw badRequest('This account has no email address, so give one to send the test to.');

    const body = testEmail({
      appName: settings.branding?.appName || 'Engy Report',
      host: merged.host,
      security: merged.security,
      by: req.user.fullname || req.user.username,
    });

    const result = await sendMail(
      { to: [{ name: req.user.fullname || req.user.username, email: to }], ...body },
      { config: { ...merged, enabled: true } }
    );

    res.json({
      sent: result.sent,
      to,
      reason: result.reason ?? '',
      stage: result.stage ?? '',
      response: result.response ?? '',
      secure: result.secure ?? false,
      /* Only on the way back from a failure: on success there is nothing to read. */
      transcript: result.sent ? [] : (result.transcript ?? []),
    });
  })
);

/**
 * The assistant presets, so the form does not have to hardcode a base URL.
 *
 * Served rather than duplicated in the client for the same reason the mail presets are: the note
 * beside each one is where somebody learns that a local runtime needs no key, and there must be
 * one copy of it.
 */
router.get(
  '/assistant/providers',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    res.json({
      providers: Object.entries(ASSISTANT_PROVIDERS).map(([key, preset]) => ({ key, ...preset })),
      jobs: JOB_KEYS,
      vaultAvailable: vaultEnabled(),
      keyFromEnvironment: Boolean(process.env.ASSISTANT_API_KEY),
    });
  })
);

/**
 * Asks the provider one trivial question to prove the configuration works.
 *
 * Takes the form's current values rather than only the saved ones — the same order as the mail
 * test, and for the same reason. Nothing is written either way.
 *
 * The reply carries the provider's own words on failure, at `detail`. "Your credit balance is too
 * low", "model: claude-oops-5 not found", "connection refused" and a safety refusal are four
 * completely different afternoons, and flattening them into "the assistant did not respond" is how
 * somebody spends one of those afternoons on the wrong problem.
 */
router.post(
  '/assistant/test',
  requireRole('admin'),
  validate(z.object({ assistant: assistantSchema.optional() }).strict()),
  asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    const config = await assistantConfig(settings);
    const draft = req.body.assistant ?? {};
    const preset = providerPreset(draft.provider ?? config.provider);

    const merged = {
      ...config,
      enabled: true,
      provider: draft.provider ?? config.provider,
      wire: process.env.ASSISTANT_WIRE || draft.wire || preset.wire,
      endpoint: (draft.endpoint ?? config.endpoint) || preset.endpoint,
      model: (draft.model ?? config.model) || preset.model,
      /* Typed just now, or the stored one — never both, and never sent back to the browser. */
      key: draft.key || config.key,
      timeoutMs: Math.min(Math.max(draft.timeoutSeconds ?? 60, 5), 300) * 1000,
      /* The test is not one of the four jobs, so a job being switched off must not block it. */
      jobs: Object.fromEntries(JOB_KEYS.map((job) => [job, true])),
    };

    if (!merged.model) throw badRequest('Fill in the model first.');
    if (merged.wire === 'openai' && !merged.endpoint) throw badRequest('Fill in the endpoint first.');
    if (preset.keyRequired && !merged.key) throw badRequest('Fill in the API key first.');

    const result = await askAssistant(
      {
        job: null,
        maxTokens: 32,
        system: 'You are being tested by a report writing tool. Answer in exactly one short sentence.',
        user: 'Reply with: the assistant is connected.',
      },
      { config: merged }
    );

    res.json({
      ok: result.ok,
      reason: result.reason ?? '',
      stage: result.stage ?? '',
      detail: result.detail ?? '',
      /* What came back, so somebody can see the endpoint answered rather than a cache. */
      answer: result.ok ? result.text.slice(0, 300) : '',
      model: result.model ?? merged.model,
      ms: result.ms ?? 0,
      usage: result.usage ?? null,
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
