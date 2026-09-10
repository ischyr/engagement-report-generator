/**
 * The four things the assistant can be asked, and the gate in front of each of them.
 *
 * Every route here is read-only against the engagement. Nothing in this file writes to an audit, a
 * finding, a section or a step: each one assembles a prompt from data the caller can already see,
 * asks, and hands back a suggestion for a person to accept in the ordinary editor with the ordinary
 * rules. That is not a UI decision that could later be optimised away — it is why none of this
 * needs to reason about locks, conflicts, the review state or the activity log.
 *
 * Four gates, in this order, before anything leaves the building:
 *
 *   1. **The caller can see the engagement.** The same clause as everywhere else, plus the
 *      restricted-work two-factor check, which is above the admin short-circuit as it is elsewhere.
 *   2. **The instance allows it at all** — the assistant is on, and this job is on.
 *   3. **The engagement allows it.** A restricted engagement is refused unless an administrator has
 *      separately said otherwise, because marking work restricted and then posting it to a third
 *      party would make the marking meaningless.
 *   4. **The material is trimmed and redacted** by `jobs.js` and `redact.js` — the proof of concept
 *      is never included, screenshots are never included, and what was removed is counted and
 *      returned so the person who pressed the button is told.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { Settings } from '../models/settings.model.js';
import { askAssistant, assistantConfig, JOBS } from '../services/assistant/index.js';
import {
  enumerationJob,
  libraryJob,
  plainText,
  REWRITABLE,
  rewriteJob,
  summaryJob,
} from '../services/assistant/jobs.js';
import { loadEnumerationBody } from '../services/enumeration-body.service.js';
import { isRestricted, assertMayOpen } from '../services/classification.service.js';
import { findingSeverity } from '../services/cvss.js';
import { stripImages } from '../services/media.service.js';
import { normaliseTitle } from '../services/finding-history.service.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { badRequest, forbidden, HttpError, notFound } from '../utils/http-error.js';

const router = Router();

/**
 * A ceiling on what one person can spend in an hour.
 *
 * Not a security boundary — everybody here has an account — but a bill. Each of these is a paid
 * request to somebody else's service, and a held-down key or a loop in a browser extension should
 * cost an apology rather than a month's budget. Generous enough that nobody writing a report will
 * ever see it.
 */
const assistantLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id ?? req.ip),
  message: { error: 'That is a lot of assistant requests in an hour. Give it a few minutes.' },
});

/**
 * Whether this instance has an assistant at all, and which jobs it will answer.
 *
 * Cheap and unauthenticated beyond the ordinary token, because every engagement page asks it once
 * on load to decide whether to draw the buttons. It deliberately says nothing about the endpoint or
 * the key: a tester needs to know the feature exists, and where an administrator points it is not
 * their business.
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const config = await assistantConfig();
    res.json({
      available: config.enabled,
      /* Named so the client can say "the assistant is off" rather than drawing a dead button. */
      reason: config.enabled ? '' : (config.reason ?? ''),
      jobs: config.enabled ? config.jobs : {},
      /* Shown in the suggestion dialog: whose model wrote this is not a detail to hide. */
      model: config.enabled ? config.model : '',
      allowRestricted: config.allowRestricted,
    });
  })
);

router.use(assistantLimiter);

/**
 * The engagement, if this person may see it and this instance may send it.
 *
 * `visibleAuditFilter` is the same clause the rest of the app uses, and `assertMayOpen` is the
 * restricted-work two-factor check — deliberately applied before the classification gate below, so
 * an engagement nobody may open does not reveal whether it is restricted.
 */
async function loadForAssistant(req, auditId) {
  const audit = await Audit.findOne({ _id: auditId, ...visibleAuditFilter(req.user) });
  if (!audit || audit.deletedAt) throw notFound('Engagement not found');
  assertMayOpen(audit, req.user);
  return audit;
}

/**
 * Decides whether this job may be done on this engagement at all, and returns the configuration.
 *
 * Called *first* in every route, before anything is assembled, searched for or read out of another
 * collection. That ordering is the point: a job that is switched off should cost nothing and reveal
 * nothing, and the library route learned this the hard way — it shortlisted the library and
 * answered "no match" for a job an administrator had turned off, which is a switch that does not
 * switch anything.
 *
 * One function, so the restricted rule cannot be enforced in three routes and forgotten in the
 * fourth.
 */
async function gate(audit, job) {
  const settings = await Settings.getSettings();
  const config = await assistantConfig(settings);
  if (!config.enabled) throw badRequest(config.reason ?? 'The assistant is not configured.');
  if (config.jobs[job] === false) {
    throw badRequest(`“${JOBS[job]?.label ?? job}” is switched off in Settings.`);
  }

  if (isRestricted(audit) && !config.allowRestricted) {
    throw forbidden(
      'This engagement is marked restricted, and the assistant is not allowed to send restricted ' +
        'work off this machine. An administrator can change that under Settings → Assistant, or ' +
        'point the assistant at a model running here.'
    );
  }
  return config;
}

/** Sends one prompt, with the configuration the gate already resolved. */
async function ask(prompt, config) {
  const result = await askAssistant(prompt, { config });
  if (!result.ok) {
    /*
     * A provider problem is a 502 rather than a 500: the request was fine, somebody else's service
     * was not. The message is theirs, and the provider's own words ride along in `details` — a
     * refusal, a spent balance and a wrong model name are three different afternoons.
     */
    throw new HttpError(result.stage === 'config' ? 400 : 502, result.reason, {
      stage: result.stage ?? '',
      detail: result.detail ?? '',
    });
  }
  return result;
}

/** The shape every job answers in, so one dialog can show all four. */
const answer = (result, extra = {}) => ({
  model: result.model,
  ms: result.ms,
  /** How many secrets were taken out of what was sent. Shown, always. */
  redacted: result.redacted ?? 0,
  truncated: Boolean(result.truncated),
  cut: Boolean(result.cut),
  usage: result.usage ?? null,
  ...extra,
});

/* -------------------------------------------------------------------------- */
/* 1. A first draft of the executive summary                                   */
/* -------------------------------------------------------------------------- */

router.post(
  '/summary',
  validate(z.object({ auditId: z.string().length(24) })),
  asyncHandler(async (req, res) => {
    const audit = await loadForAssistant(req, req.body.auditId);
    const config = await gate(audit, 'summary');
    await audit.populate({ path: 'company', select: 'name' });

    const findings = (audit.findings ?? [])
      .map((finding) => {
        const rated = findingSeverity(finding);
        return {
          identifier: finding.identifier ? `#${finding.identifier}` : '',
          title: finding.title ?? '',
          severity: rated.severity,
          score: rated.score,
          status: finding.remediationStatus ?? 'open',
          /*
           * A line of the description, not the whole thing.
           *
           * Forty findings at two thousand characters each is a fifth of a context window spent on
           * material the summary is explicitly told not to repeat. What it needs from each finding
           * is enough to know what it was.
           */
          snippet: plainText(finding.description, 220),
          sortScore: rated.sortScore,
        };
      })
      .sort((a, b) => b.sortScore - a.sortScore);

    if (!findings.length) {
      throw badRequest('There are no findings yet, so there is nothing to summarise.');
    }

    const hosts = (audit.scope ?? []).reduce(
      (total, group) => total + (group.hosts?.length ?? 0),
      0
    );

    const prompt = summaryJob(
      {
        name: audit.name ?? '',
        client: audit.company?.name ?? '',
        type: audit.auditType ?? '',
        window:
          audit.date_start && audit.date_end ? `${audit.date_start} to ${audit.date_end}` : '',
        scope: hosts
          ? `${hosts} host${hosts === 1 ? '' : 's'} across ${audit.scope.length} group${
              audit.scope.length === 1 ? '' : 's'
            }`
          : '',
        findings,
      },
      config.houseStyle
    );

    const result = await ask(prompt, config);
    res.json(answer(result, { ...summaryJob.parse(result.text), counted: findings.length }));
  })
);

/* -------------------------------------------------------------------------- */
/* 2. A house-style rewrite of one passage                                     */
/* -------------------------------------------------------------------------- */

router.post(
  '/rewrite',
  validate(
    z.object({
      auditId: z.string().length(24),
      findingId: z.string().length(24),
      field: z.enum(Object.keys(REWRITABLE)),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadForAssistant(req, req.body.auditId);
    const config = await gate(audit, 'rewrite');
    const finding = audit.findings.id(req.body.findingId);
    if (!finding) throw notFound('Finding not found');

    const source = String(finding[req.body.field] ?? '');
    if (!plainText(source)) throw badRequest('There is nothing written in that field yet.');

    /*
     * A passage with screenshots in it is refused rather than quietly flattened.
     *
     * The images are not sent — a screenshot is where a password ends up by accident — so a
     * rewrite of this passage could only come back without them, and accepting it would delete
     * evidence from a report. Refusing and saying why is the honest outcome.
     */
    const images = stripImages(source).removed;
    if (images) {
      throw badRequest(
        `That passage has ${images} screenshot${images === 1 ? '' : 's'} in it. They are never ` +
          'sent to the assistant, so a rewrite would come back without them and replacing the ' +
          'text would delete them from the report. Rewrite this one by hand, or move the ' +
          'screenshots into another field first.'
      );
    }

    const rated = findingSeverity(finding);
    const prompt = rewriteJob({
      field: req.body.field,
      finding: {
        title: finding.title ?? '',
        vulnType: finding.vulnType ?? '',
        severity: rated.severity,
        [req.body.field]: source,
      },
      houseStyle: config.houseStyle,
    });

    const result = await ask(prompt, config);
    res.json(answer(result, { field: req.body.field, ...rewriteJob.parse(result.text) }));
  })
);

/* -------------------------------------------------------------------------- */
/* 3. One line saying what a tool run established                              */
/* -------------------------------------------------------------------------- */

router.post(
  '/enumeration',
  validate(z.object({ auditId: z.string().length(24), stepId: z.string().length(24) })),
  asyncHandler(async (req, res) => {
    const audit = await loadForAssistant(req, req.body.auditId);
    const config = await gate(audit, 'enumeration');
    const step = (audit.enumeration ?? []).find(
      (entry) => String(entry._id) === req.body.stepId
    );
    if (!step) throw notFound('That step is not on this engagement');

    /* The output lives in its own document — this is the one job that has to go and get it. */
    const body = await loadEnumerationBody(audit._id, step._id);
    if (!String(body?.output ?? '').trim()) {
      throw badRequest('That step has no output to summarise yet.');
    }

    const prompt = enumerationJob({
      step: {
        title: step.title,
        tool: step.tool,
        target: step.target,
        command: step.command,
      },
      output: body.output,
      houseStyle: config.houseStyle,
    });

    const result = await ask(prompt, config);
    res.json(answer(result, enumerationJob.parse(result.text)));
  })
);

/* -------------------------------------------------------------------------- */
/* 4. Which library entry this finding is                                      */
/* -------------------------------------------------------------------------- */

/**
 * The shortlist, chosen here rather than by the model.
 *
 * The text index first, because it is what the library page searches with and it is the team's own
 * vocabulary. If it finds nothing — a two-word title, a stop-word, an index that has not caught up —
 * the normalised title is tried as a loose match, which is the same normaliser that matches a
 * finding to its earlier occurrences.
 *
 * Only the shortlist is sent. Describing the whole library on every request would be both the
 * expensive way of asking and the leaky one.
 */
async function shortlist(finding, locale = 'en') {
  const detailOf = (entry) =>
    entry.details?.find((detail) => detail.locale === locale) ?? entry.details?.[0] ?? {};

  const query = [finding.title, finding.vulnType].filter(Boolean).join(' ').trim();
  let rows = [];
  if (query) {
    rows = await Vulnerability.find(
      { $text: { $search: query } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(8)
      .lean();
  }

  if (!rows.length) {
    const needle = normaliseTitle(finding.title ?? '');
    if (needle.length > 3) {
      rows = await Vulnerability.find({
        'details.title': { $regex: needle.split(' ').slice(0, 3).join('|'), $options: 'i' },
      })
        .limit(8)
        .lean();
    }
  }

  return rows.map((row) => {
    const detail = detailOf(row);
    return {
      _id: String(row._id),
      title: detail.title ?? '(untitled)',
      category: row.category ?? '',
      snippet: plainText(detail.description, 300),
      /*
       * The entry's own write-up, carried on the candidate rather than fetched again.
       *
       * Not sent to the provider — `libraryJob` builds its prompt from the title, the category and
       * the snippet, and never touches this. It is here so that accepting a match can fill the
       * finding's empty fields without a second round trip, and it is the team's own text that the
       * person asking could already read on the library page.
       */
      body: {
        vulnType: detail.vulnType ?? '',
        description: detail.description ?? '',
        observation: detail.observation ?? '',
        remediation: detail.remediation ?? '',
        references: detail.references ?? [],
        cvssv3: row.cvssv3 ?? '',
        category: row.category ?? '',
      },
    };
  });
}

/** The shortlist as the model is shown it — the write-up above is deliberately not in the prompt. */
const forPrompt = (candidates) =>
  candidates.map(({ _id, title, category, snippet }) => ({ _id, title, category, snippet }));

router.post(
  '/library',
  validate(
    z.object({
      auditId: z.string().length(24),
      findingId: z.string().length(24),
      locale: z.string().trim().max(10).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadForAssistant(req, req.body.auditId);
    const config = await gate(audit, 'library');
    const finding = audit.findings.id(req.body.findingId);
    if (!finding) throw notFound('Finding not found');

    const candidates = await shortlist(finding, req.body.locale || 'en');
    if (!candidates.length) {
      /*
       * Answered without asking anybody. An empty library is a fact this machine already knows,
       * and paying a provider to be told there is no match in a list of nothing would be silly.
       */
      return res.json({
        match: null,
        reason: 'Nothing in the library looks like this one.',
        candidates: [],
        model: '',
        ms: 0,
        redacted: 0,
        asked: false,
      });
    }

    const prompt = libraryJob({
      finding: {
        title: finding.title ?? '',
        vulnType: finding.vulnType ?? '',
        description: finding.description ?? '',
      },
      candidates: forPrompt(candidates),
      houseStyle: config.houseStyle,
    });

    const result = await ask(prompt, config);
    const picked = libraryJob.parse(result.text);
    const match = picked.index ? (candidates[picked.index - 1] ?? null) : null;

    res.json(
      answer(result, {
        match,
        reason: picked.reason,
        /* The shortlist as well, so somebody who disagrees can pick another without searching. */
        candidates,
        asked: true,
      })
    );
  })
);

export default router;
