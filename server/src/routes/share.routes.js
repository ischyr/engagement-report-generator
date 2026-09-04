/**
 * The client's own view of their findings, and the team's control of it.
 *
 * Mounted **before** the authentication gate, like the intake questionnaire, because the person
 * this exists for has no account. Everything under `/share/link` applies `requireAuth` itself; the
 * two token routes are open by design and defended by four things instead:
 *
 *   1. the token is 32 random bytes, kept only as a hash
 *   2. every hit is rate limited per address
 *   3. a failure says nothing about why — expired, revoked and never-real are one answer
 *   4. what a valid token can reach is a whitelist in `share.service.js`, not a filter here
 *
 * The write is deliberately one field with two values. Anything more — a comment, an attachment,
 * a date — is a second thing to validate, sanitise, store and show to the team, over a credential
 * that can be forwarded in an email.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { Settings } from '../models/settings.model.js';
import { ACTIONS } from '../models/activity.model.js';
import { recordActivity } from '../services/activity.service.js';
import {
  applyClientStatus,
  clientView,
  DEFAULT_DAYS,
  issueShareLink,
  MAX_DAYS,
  noteView,
  readShareLink,
} from '../services/share.service.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import asyncHandler from '../utils/async-handler.js';
import { forbidden, notFound } from '../utils/http-error.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const router = Router();

/**
 * The same shape the intake form uses, and for the same reason.
 *
 * A hundred an hour is far more than a client reading their report needs, and far less than
 * guessing a 32-byte token is worth.
 */
const shareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

/* -------------------------------------------------------------------------- */
/* What the client can reach                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  '/:token',
  shareLimiter,
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');

    const settings = await Settings.getSettings();
    await noteView(link);
    res.json({
      ...clientView(link, settings.report?.public?.cvssColors ?? {}),
      /* So the page can say whose report it is without the client asking. */
      firm: settings.branding?.appName ?? '',
    });
  })
);

router.post(
  '/:token/findings/:findingId',
  shareLimiter,
  validate(z.object({ fixed: z.boolean() })),
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    if (!link.allowUpdates) throw forbidden('This link is read-only.');

    /* Reloaded as a document: `readShareLink` populates a projection, and this one is saved. */
    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    if (audit.state === 'APPROVED') {
      throw forbidden('This report is closed. Tell your contact and they will reopen it.');
    }

    const { finding, from, to } = applyClientStatus(
      audit,
      req.params.findingId,
      req.body.fixed,
      link.label
    );
    if (from !== to) {
      await audit.save();
      /*
       * On the log with no actor, and a summary written here rather than built from one.
       * Everything else in the log was done by somebody with an account; this was not, and a
       * line that implied otherwise would be the most misleading kind of record.
       */
      await recordActivity({
        audit,
        actor: null,
        action: ACTIONS.CLIENT_UPDATED_FINDING,
        target: finding.identifier || finding.title,
        meta: { from, to, link: link.label || 'a shared link' },
        summary: `The client${link.label ? ` (${link.label})` : ''} marked ${
          finding.identifier || finding.title
        } as ${to === 'fixed' ? 'fixed' : 'still open'}`,
      });

      /*
       * And tell somebody.
       *
       * The log is where you look when you already know to look. A client acting on a report is
       * news — it is the thing the whole link exists to produce — and until now the team found out
       * by opening the engagement on the off-chance. Everyone on it is told, because "whose finding
       * was it" is not the question: a client fixing something is the engagement's business.
       *
       * No actor, deliberately. The bridge that turns these into email skips a notification you
       * caused yourself by comparing actors, and there is nobody here to compare — which is the
       * right outcome, because nobody on the team did this.
       */
      const team = [audit.creator, ...(audit.collaborators ?? [])]
        .map((person) => String(person?._id ?? person ?? ''))
        .filter(Boolean);
      const told = [...new Set(team)];
      if (told.length) {
        await Notification.insertMany(
          told.map((user) => ({
            user,
            type: 'client-updated-finding',
            actor: null,
            audit: audit._id,
            auditName: audit.name,
            findingId: finding._id,
            target: finding.identifier || finding.title,
            message: `${link.label || 'The client'} marked ${
              finding.identifier || finding.title
            } as ${to === 'fixed' ? 'fixed' : 'still open'} — worth a look before the retest.`,
            /* Straight to the finding, not to a list of forty. */
            href: `/engagements/${audit._id}/findings/${finding._id}`,
          }))
        ).catch(() => {
          /* The client's change is recorded; failing to announce it must not undo that. */
        });
      }
    }

    const fresh = await readShareLink(req.params.token);
    res.json(clientView(fresh, (await Settings.getSettings()).report?.public?.cvssColors ?? {}));
  })
);

/* -------------------------------------------------------------------------- */
/* What the team can do about it                                               */
/* -------------------------------------------------------------------------- */

router.use(requireAuth);

/** Loads an engagement this person may open, or refuses without saying it exists. */
async function loadForShare(req) {
  const audit = await Audit.findOne({
    _id: req.params.auditId,
    ...visibleAuditFilter(req.user),
  }).select('name state deletedAt');
  if (!audit) throw notFound('Engagement not found');
  return audit;
}

const summary = (row, origin = '') => ({
  _id: row._id,
  label: row.label,
  allowUpdates: row.allowUpdates,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt ?? null,
  views: row.views ?? 0,
  lastViewedAt: row.lastViewedAt ?? null,
  createdAt: row.createdAt,
  createdBy: row.createdBy ?? null,
  /** Live only when it is still good for something, so the UI never offers a dead link. */
  live: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
  origin,
});

router.get(
  '/link/:auditId',
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    const rows = await ShareLink.find({ audit: audit._id })
      .populate({ path: 'createdBy', select: 'username firstname lastname' })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ links: rows.map((row) => summary(row)) });
  })
);

/**
 * Issues one, and hands the URL back exactly once.
 *
 * Once, because only the hash is kept — the same contract as an invitation. Somebody who loses the
 * link makes another, and the old one can be revoked, which is a better outcome than a token this
 * app could hand out twice.
 */
router.post(
  '/link/:auditId',
  validate(
    z.object({
      label: z.string().trim().max(160).optional().default(''),
      days: z.number().int().min(1).max(MAX_DAYS).optional().default(DEFAULT_DAYS),
      allowUpdates: z.boolean().optional().default(true),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const { link, token } = await issueShareLink({ audit, ...req.body, actor: req.user });
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SHARE_LINK_CREATED,
      target: req.body.label || 'the client',
      meta: { days: req.body.days, readOnly: !req.body.allowUpdates },
    });

    res.status(201).json({
      ...summary(link),
      /** The only time this is ever returned. */
      token,
      path: `/shared/${token}`,
    });
  })
);

router.post(
  '/link/:auditId/:linkId/revoke',
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await ShareLink.findOne({ _id: req.params.linkId, audit: audit._id });
    if (!row) throw notFound('That link is not on this engagement');
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      row.revokedBy = req.user._id;
      await row.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.SHARE_LINK_REVOKED,
        target: row.label || 'a shared link',
      });
    }
    res.json(summary(row));
  })
);

export default router;
