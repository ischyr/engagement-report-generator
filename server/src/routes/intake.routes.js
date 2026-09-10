/**
 * Pre-engagement questionnaires.
 *
 * Split down the middle: two **public** routes behind a token, and the rest behind the usual
 * session. The public half is mounted before the blanket auth gate in `routes/index.js`, the same
 * way the password links are, and is deliberately the smallest surface that can work — read the
 * form, submit the form, nothing else. It grants no session and never touches an engagement.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Intake } from '../models/intake.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireWrite } from '../middleware/auth.js';
import { ACTIONS, recordActivity } from '../services/activity.service.js';
import {
  engagementFromAnswers,
  intakeState,
  issueIntake,
  publicView,
  readIntake,
} from '../services/intake.service.js';

const router = Router();

/**
 * The only unauthenticated write in the app besides signing in.
 *
 * Tight limits, because a token is 32 random bytes and the only way at one is to guess: a
 * hundred attempts an hour from one address is far more than a client filling in a form needs
 * and far less than a search is worth.
 */
const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

const DAY = /^(\d{4}-\d{2}-\d{2})?$/;

const answersSchema = z.object({
  contactName: z.string().trim().max(160).optional().default(''),
  contactEmail: z.string().trim().max(200).optional().default(''),
  contactPhone: z.string().trim().max(60).optional().default(''),
  engagementName: z.string().trim().max(200).optional().default(''),
  kind: z.string().trim().max(120).optional().default(''),
  windowStart: z.string().regex(DAY, 'Use a yyyy-mm-dd date').optional().default(''),
  windowEnd: z.string().regex(DAY, 'Use a yyyy-mm-dd date').optional().default(''),
  assets: z.string().max(20000).optional().default(''),
  constraints: z.string().max(4000).optional().default(''),
  testingWindowNote: z.string().max(500).optional().default(''),
  escalationName: z.string().trim().max(160).optional().default(''),
  escalationPhone: z.string().trim().max(60).optional().default(''),
  extra: z.string().max(4000).optional().default(''),
});

/* -------------------------------------------------------------------------- */
/* Public — the client's half                                                  */
/* -------------------------------------------------------------------------- */

router.get(
  '/public/:token',
  intakeLimiter,
  asyncHandler(async (req, res) => {
    const intake = await readIntake(req.params.token);
    /*
     * A missing token and a withdrawn one answer identically, so the response cannot be used to
     * work out which tokens ever existed.
     */
    if (!intake) {
      return res.status(404).json({ error: 'This link is not valid.' });
    }
    res.json(publicView(intake));
  })
);

router.post(
  '/public/:token',
  intakeLimiter,
  validate(answersSchema),
  asyncHandler(async (req, res) => {
    const intake = await readIntake(req.params.token);
    if (!intake) return res.status(404).json({ error: 'This link is not valid.' });

    const state = intakeState(intake);
    if (!state.open) throw badRequest(state.reason);

    intake.answers = req.body;
    intake.status = 'submitted';
    intake.submittedAt = new Date();
    // Coarse, and only for the record: which network it came from is occasionally the thing that
    // settles "we never sent that".
    intake.submittedFrom = String(req.ip ?? '').slice(0, 80);
    await intake.save();

    res.json({ ok: true, ...publicView(intake) });
  })
);

/* -------------------------------------------------------------------------- */
/* The team's half                                                             */
/* -------------------------------------------------------------------------- */

router.use(requireAuth);

const summary = (intake) => ({
  _id: intake._id,
  company: intake.company?._id
    ? { _id: intake.company._id, name: intake.company.name }
    : intake.company,
  label: intake.label,
  status: intake.status,
  expiresAt: intake.expiresAt,
  submittedAt: intake.submittedAt,
  requestedBy: intake.requestedBy,
  createdAudit: intake.createdAudit,
  answers: intake.answers ?? {},
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = /^[0-9a-fA-F]{24}$/.test(req.query.company ?? '')
      ? { company: req.query.company }
      : {};
    const rows = await Intake.find(filter)
      .populate([
        { path: 'company', select: 'name' },
        { path: 'requestedBy', select: 'username firstname lastname' },
      ])
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(rows.map(summary));
  })
);

router.post(
  '/',
  requireWrite,
  validate(
    z.object({
      company: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Pick a client'),
      label: z.string().trim().max(200).optional().default(''),
    })
  ),
  asyncHandler(async (req, res) => {
    const company = await Company.findById(req.body.company);
    if (!company) throw notFound('Client not found');

    const { intake, path } = await issueIntake({
      company,
      label: req.body.label,
      requestedBy: req.user,
    });
    await intake.populate({ path: 'company', select: 'name' });

    /*
     * The link is handed back to whoever asked for it rather than emailed, exactly like a
     * password invitation: there is no SMTP in this app on purpose, and delivering a URL is
     * left to a channel the firm already trusts.
     */
    res.status(201).json({ ...summary(intake), path });
  })
);

router.post(
  '/:id/cancel',
  requireWrite,
  asyncHandler(async (req, res) => {
    const intake = await Intake.findById(req.params.id);
    if (!intake) throw notFound('Questionnaire not found');
    if (intake.status === 'used') throw badRequest('That one has already been used.');

    intake.status = 'cancelled';
    await intake.save();
    res.json({ ok: true, status: intake.status });
  })
);

/**
 * Builds the engagement the answers describe.
 *
 * A draft of what the client *asked for*, never of what was agreed: everything in it is one
 * side's account, typed into a form by somebody who may have guessed. The questionnaire is kept
 * and linked either way, so the answers survive every edit made afterwards — which is the whole
 * reason for collecting them in a form rather than a mail thread.
 */
router.post(
  '/:id/engagement',
  requireWrite,
  asyncHandler(async (req, res) => {
    const intake = await Intake.findById(req.params.id).populate({
      path: 'company',
      select: 'name',
    });
    if (!intake) throw notFound('Questionnaire not found');
    if (intake.status === 'used') {
      throw badRequest('An engagement has already been created from this questionnaire.');
    }
    if (intake.status !== 'submitted') {
      throw badRequest('Nobody has filled this one in yet.');
    }
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const audit = await Audit.create(engagementFromAnswers(intake, { creator: req.user }));

    intake.status = 'used';
    intake.createdAudit = audit._id;
    await intake.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.AUDIT_CREATED,
      summary: `${
        [req.user.firstname, req.user.lastname].filter(Boolean).join(' ') || req.user.username
      } created this engagement from the client's questionnaire`,
    });

    res.status(201).json({ audit: { _id: audit._id, name: audit.name }, intake: summary(intake) });
  })
);

export default router;
