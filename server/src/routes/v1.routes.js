/**
 * `/api/v1` — the surface a script may hold a credential for, and the only versioned one.
 *
 * Everything else under `/api` is the application talking to its own front end. Those routes are
 * free to change shape whenever the interface does, and they do: one of them answers with an
 * envelope where a list would have been the obvious guess, which was a real defect in a real
 * component before it was a lesson. That freedom is worth keeping, and it is incompatible with
 * being something a client's pipeline depends on. So this is a second, smaller surface with a
 * promise attached, and the promise is what the version number means.
 *
 * ## What v1 promises
 *
 * Additive change only. New endpoints, new fields on existing responses, new optional parameters —
 * all fine, and a caller that ignores them keeps working. Anything that removes a field, renames
 * one, or changes what one means is a v2, served alongside v1 rather than instead of it.
 *
 * Two consequences shape the code below:
 *
 *   - **Every response is an object, never a bare array.** A route answering `[...]` has nowhere to
 *     put `total` when somebody eventually needs paging, so the additive promise would already be
 *     broken by the first thing anybody asks for. Lists arrive as `{ findings: [...], total, … }`.
 *   - **Every field is written out by hand**, in `v1-payload.service.js`. A spread would mean the
 *     next field added to a model is published without anybody deciding to publish it.
 *
 * ## What it deliberately does not do
 *
 * No deletes, of anything. A token is a string in a configuration file, and the failure mode of a
 * misconfigured script with delete rights is somebody's engagement quietly emptying out. Removal
 * stays a thing a person does while looking at the screen.
 *
 * No evidence upload yet, and no report generation. Both are wanted — the first for a CLI that
 * pipes tool output in, the second for a nightly build — and both are better absent than
 * half-promised, because adding an endpoint to v1 later is allowed and changing one is not.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { Audit, ENUMERATION_PHASES, ENUMERATION_STATUSES, REMEDIATION_STATUSES } from '../models/audit.model.js';
import { ACTIONS, recordActivity } from '../services/activity.service.js';
import { CVSS_DEFAULT_VECTOR } from '../services/cvss.js';
import { assertEditable, nextIdentifier } from '../services/engagement-write.service.js';
import {
  loadEnumerationBody,
  saveEnumerationBody,
} from '../services/enumeration-body.service.js';
import { SCOPES } from '../models/api-token.model.js';
import { v1Engagement, v1Finding, v1Step, v1Whoami } from '../services/v1-payload.service.js';
import {
  loadTokenAudit,
  requireApiToken,
  requireScope,
  tokenAuditFilter,
} from '../middleware/api-auth.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/**
 * A ceiling per token, not per address.
 *
 * Per-address is the wrong key for machine traffic: a CI provider runs every customer's job from a
 * handful of egress addresses, so one busy pipeline elsewhere would throttle this instance's, and
 * two tokens on one runner would share a budget for no reason a person could work out. The token
 * is the thing that was issued, so it is the thing with a budget.
 *
 * Generous, because the honest use is a burst: a script that files eleven findings at the end of a
 * scan makes twelve calls in a second and then nothing for a day.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.token?._id ?? req.ip),
  message: { error: 'Too many requests for this token. The limit is 300 a minute.' },
});

router.use(requireApiToken, apiLimiter);

/* ----------------------------------------------------------------- itself --- */

/**
 * What this is, and what a caller can reach.
 *
 * An index rather than a 404 at the root, because the first thing somebody does with a new API is
 * curl its base URL, and the useful answer to that is the list of routes and the scope each needs.
 * Written out rather than derived from the router: a generated list would describe the code, and
 * what a caller needs is the shape that has been promised.
 */
router.get('/', (req, res) => {
  res.json({
    api: 'engy-report',
    version: 'v1',
    documentation: '/docs/api',
    scopesHeld: req.token.scopes ?? [],
    endpoints: [
      { method: 'GET', path: '/api/v1/whoami', scope: null },
      { method: 'GET', path: '/api/v1/engagements', scope: 'engagements:read' },
      { method: 'GET', path: '/api/v1/engagements/:id', scope: 'engagements:read' },
      { method: 'GET', path: '/api/v1/engagements/:id/findings', scope: 'findings:read' },
      { method: 'GET', path: '/api/v1/engagements/:id/findings/:findingId', scope: 'findings:read' },
      { method: 'POST', path: '/api/v1/engagements/:id/findings', scope: 'findings:write' },
      { method: 'PATCH', path: '/api/v1/engagements/:id/findings/:findingId', scope: 'findings:write' },
      { method: 'GET', path: '/api/v1/engagements/:id/enumeration', scope: 'enumeration:read' },
      { method: 'GET', path: '/api/v1/engagements/:id/enumeration/:stepId', scope: 'enumeration:read' },
      { method: 'POST', path: '/api/v1/engagements/:id/enumeration', scope: 'enumeration:write' },
    ],
    scopes: Object.entries(SCOPES).map(([name, meta]) => ({ name, ...meta })),
  });
});

/** Who the token acts as, what it may do, and how long it has left. */
router.get('/whoami', (req, res) => res.json(v1Whoami(req)));

/* ------------------------------------------------------------ engagements --- */

/**
 * Paging, shared by every list.
 *
 * A default rather than everything, because a list endpoint with no ceiling is one that works
 * until an instance has four years of engagements in it. `total` travels with every page so a
 * caller can tell whether it has them all without asking for another one.
 */
const paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  state: z.enum(['EDIT', 'REVIEW', 'APPROVED']).optional(),
});

router.get(
  '/engagements',
  requireScope('engagements:read'),
  validate(paging, 'query'),
  asyncHandler(async (req, res) => {
    const { limit, offset, state } = req.query;
    const filter = tokenAuditFilter(req, state ? { state } : {});

    const [rows, total] = await Promise.all([
      Audit.find(filter)
        .select('name reference auditType kind state company findings updatedAt')
        .populate({ path: 'company', select: 'name' })
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit),
      Audit.countDocuments(filter),
    ]);

    res.json({
      engagements: rows.map((row) => v1Engagement(row)),
      total,
      limit,
      offset,
    });
  })
);

router.get(
  '/engagements/:id',
  requireScope('engagements:read'),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req, { populate: true });
    res.json({ engagement: v1Engagement(audit, { detail: true }) });
  })
);

/* --------------------------------------------------------------- findings --- */

router.get(
  '/engagements/:id/findings',
  requireScope('findings:read'),
  validate(
    z.object({
      severity: z.enum(['Critical', 'High', 'Medium', 'Low', 'None']).optional(),
      remediationStatus: z.enum(REMEDIATION_STATUSES).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    await audit.populate({ path: 'findings.assignedTo', select: 'username' });

    /*
     * Filtered here rather than in the query, because severity is computed from the vector and the
     * team's override — it is not a stored field, and a `$match` on one would answer with whatever
     * a stale copy said. The cost is reading the engagement's findings, which is one document.
     */
    let findings = (audit.findings ?? []).map((finding) => v1Finding(finding, { detail: false }));
    if (req.query.severity) {
      findings = findings.filter((finding) => finding.severity === req.query.severity);
    }
    if (req.query.remediationStatus) {
      findings = findings.filter(
        (finding) => finding.remediationStatus === req.query.remediationStatus
      );
    }

    res.json({ findings, total: findings.length });
  })
);

router.get(
  '/engagements/:id/findings/:findingId',
  requireScope('findings:read'),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    await audit.populate({ path: 'findings.assignedTo', select: 'username' });
    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('No such finding on that engagement');
    res.json({ finding: v1Finding(finding) });
  })
);

/**
 * What a token may set on a finding.
 *
 * Narrower than the application's own `findingSchema` on purpose, and the omissions are the
 * interesting part:
 *
 *   - `identifier` — allocated by the server, as it is everywhere else. A caller-supplied number
 *     could collide with an existing finding's or renumber one a delivered report already cites.
 *   - `tags` — an internal field. The report strips them and so does this.
 *   - `assignedTo`, `vulnerability`, `customFields`, `sortIndex` — each needs something a script
 *     cannot sensibly know: a user id, a library entry, an instance's field definitions, a place
 *     in a hand-ordered list. Left out rather than accepted and ignored.
 *   - `severityOverride` — standing behind a severity against the vector's own arithmetic is a
 *     judgement with a name attached to it. A script has no name.
 */
const findingWrite = z.object({
  title: z.string().trim().min(1, 'A finding needs a title').max(400),
  vulnType: z.string().trim().max(120).optional().default(''),
  category: z.string().trim().max(120).optional().default(''),
  description: z.string().max(200000).optional().default(''),
  observation: z.string().max(200000).optional().default(''),
  remediation: z.string().max(200000).optional().default(''),
  poc: z.string().max(200000).optional().default(''),
  scope: z.string().max(20000).optional().default(''),
  references: z.array(z.string().trim().max(500)).max(50).optional().default([]),
  cvssv3: z.string().trim().max(300).optional().default(CVSS_DEFAULT_VECTOR),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  remediationComplexity: z.number().int().min(1).max(3).nullable().optional(),
  remediationStatus: z.enum(REMEDIATION_STATUSES).optional().default('open'),
});

/**
 * Records that a script did something, and which one.
 *
 * The activity log says "Marcus created the finding" for a person, and for a token that sentence
 * would be a lie of the useful kind — the account is Marcus's, the hands were a pipeline's. So the
 * summary is overridden to name the token, and `meta.via` marks the entry for anything that later
 * wants to count machine writes separately.
 */
function recordTokenActivity({ audit, req, action, target }) {
  const who = [req.user.firstname, req.user.lastname].filter(Boolean).join(' ') || req.user.username;
  const verb = {
    [ACTIONS.FINDING_CREATED]: 'created the finding',
    [ACTIONS.FINDING_UPDATED]: 'updated the finding',
    [ACTIONS.ENUM_STEP_CREATED]: 'added the enumeration step',
  }[action] ?? 'changed something';

  return recordActivity({
    audit,
    actor: req.user,
    action,
    target,
    meta: { via: 'api-token', token: req.token.label },
    summary: `“${req.token.label}” (an API token of ${who}'s) ${verb} ${target}`.trim(),
  });
}

router.post(
  '/engagements/:id/findings',
  requireScope('findings:write'),
  validate(findingWrite),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    assertEditable(audit, req.user);

    audit.findings.push({
      ...req.body,
      identifier: await nextIdentifier(audit),
      sortIndex: (audit.findings ?? []).length,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await audit.save();

    const finding = audit.findings.at(-1);
    await recordTokenActivity({
      audit,
      req,
      action: ACTIONS.FINDING_CREATED,
      target: finding.title,
    });
    res.status(201).json({ finding: v1Finding(finding) });
  })
);

router.patch(
  '/engagements/:id/findings/:findingId',
  requireScope('findings:write'),
  validate(findingWrite.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    assertEditable(audit, req.user);

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('No such finding on that engagement');
    if (Object.keys(req.body).length === 0) throw badRequest('Nothing to change.');

    /*
     * A finding somebody has taken for editing is not one a script may overwrite.
     *
     * The lock exists so two people cannot write over each other, and a pipeline arriving in the
     * middle of somebody's afternoon is the same collision with worse manners — they at least get
     * a dialog. The lock's own staleness rules belong to the application; this simply declines.
     */
    if (finding.lockedBy) {
      throw badRequest('Somebody has that finding open for editing. Try again shortly.');
    }

    for (const [key, value] of Object.entries(req.body)) finding[key] = value;
    finding.updatedBy = req.user._id;
    await audit.save();

    await recordTokenActivity({
      audit,
      req,
      action: ACTIONS.FINDING_UPDATED,
      target: finding.title,
    });
    res.json({ finding: v1Finding(finding) });
  })
);

/* ------------------------------------------------------------ enumeration --- */

router.get(
  '/engagements/:id/enumeration',
  requireScope('enumeration:read'),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    const steps = (audit.enumeration ?? [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((step) => v1Step(step));
    res.json({ steps, total: steps.length });
  })
);

router.get(
  '/engagements/:id/enumeration/:stepId',
  requireScope('enumeration:read'),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    const step = audit.enumeration.id(req.params.stepId);
    if (!step) throw notFound('No such enumeration step on that engagement');

    /* The output lives in its own collection, which is why the list above does not carry it. */
    const body = await loadEnumerationBody(audit._id, step._id);
    res.json({ step: v1Step(step, { output: body.output ?? '' }) });
  })
);

/**
 * What a token may record as a tool run.
 *
 * `content` — the operator's own written notes on the step — is deliberately absent. Notes are
 * prose a colleague reads, and a script filing them would be putting words in somebody's mouth.
 * `output` is what a machine has to say, and it is what this takes.
 */
const stepWrite = z.object({
  title: z.string().trim().min(1, 'A step needs a title').max(200),
  tool: z.string().trim().max(120).optional().default(''),
  command: z.string().max(2000).optional().default(''),
  target: z.string().trim().max(400).optional().default(''),
  output: z.string().max(200000).optional().default(''),
  ranAt: z.string().trim().max(120).optional().default(''),
  phase: z.enum([...ENUMERATION_PHASES, '']).optional().default(''),
  status: z.enum([...ENUMERATION_STATUSES, '']).optional().default(''),
  summary: z.string().trim().max(600).optional().default(''),
  internal: z.boolean().optional(),
  parent: z
    .string()
    .regex(/^[a-f\d]{24}$/i, 'A parent step id is 24 hex characters')
    .nullable()
    .optional(),
});

router.post(
  '/engagements/:id/enumeration',
  requireScope('enumeration:write'),
  validate(stepWrite),
  asyncHandler(async (req, res) => {
    const audit = await loadTokenAudit(req);
    assertEditable(audit, req.user);

    const { output, parent = null, ...shape } = req.body;
    if (parent && !audit.enumeration.id(parent)) throw badRequest('That parent step does not exist.');

    audit.enumeration.push({
      ...shape,
      parent,
      author: req.user._id,
      updatedBy: req.user._id,
      /* The bottom of its own branch, the same rule the application's own route follows. */
      order:
        Math.max(
          0,
          ...(audit.enumeration ?? [])
            .filter((step) => String(step.parent ?? '') === String(parent ?? ''))
            .map((step) => step.order ?? 0)
        ) + 1,
    });

    const step = audit.enumeration.at(-1);
    /* Before the save, so the counts the tree reads land in the same write as the step. */
    const body = await saveEnumerationBody(audit, step, { output: output ?? '', content: '' });
    await audit.save();

    await recordTokenActivity({
      audit,
      req,
      action: ACTIONS.ENUM_STEP_CREATED,
      target: step.title,
    });
    res.status(201).json({ step: v1Step(step, { output: body.output ?? '' }) });
  })
);

/* ---------------------------------------------------------------- the end --- */

/**
 * Anything under `/api/v1` this file does not route stops here.
 *
 * Not tidiness. Without it the request falls out of this router and into the session gate mounted
 * below it in `routes/index.js`, which reads the Authorization header, finds a string that is not a
 * JWT, and answers 401 — so `DELETE /api/v1/engagements/…` reported "invalid access token" when the
 * true answer is "there is no delete in v1, deliberately". A credential error and a missing route
 * send somebody to opposite ends of their own code, and the first thing a person writing against a
 * new API does is call something that does not exist.
 *
 * Found by an assertion that expected a 404 and got a 401 — which is the whole reason for asserting
 * the status of a route that is *supposed* to be absent.
 */
router.use((req, _res, next) => {
  next(
    notFound(
      `No such route in this API: ${req.method} /api/v1${req.path === '/' ? '' : req.path}. GET /api/v1 lists them.`
    )
  );
});

export default router;
