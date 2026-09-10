/**
 * Making, listing and retiring your own API tokens. Mounted at `/api/auth/tokens`.
 *
 * Beside the session list rather than under Settings, because these are the same kind of thing: a
 * credential that acts as you, which you should be able to see all of and end any of. Settings is
 * where an administrator configures the instance; this is where a person manages their own keys.
 *
 * Own tokens only, in both directions. There is no route here that reads anybody else's, including
 * for an admin — the same rule and the same reasoning as `/auth/sessions`: "which credentials does
 * this person hold" is not the authority that managing accounts confers. An admin who needs
 * somebody's automation stopped disables the account, which stops every token it owns at once.
 */
import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { ApiToken, DEFAULT_TOKEN_DAYS, MAX_TOKEN_DAYS, SCOPES, SCOPE_NAMES } from '../models/api-token.model.js';
import { WORKING_ROLES } from '../models/user.model.js';
import {
  describeApiToken,
  mintApiToken,
  revokeApiToken,
} from '../services/api-tokens.service.js';
import { isRestricted } from '../services/classification.service.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/* Every route here is about the caller's own credentials, so all of them need a session. */
router.use(requireAuth);

/**
 * Only somebody who does the work can hold one.
 *
 * A sales account is confined to the Sales section, and `/api/v1` serves engagements — so a token
 * of theirs would be a credential that can reach nothing. Refused at the point of making it, with
 * the reason, rather than issued and then silently useless.
 */
function assertMayHoldTokens(user) {
  if (!(user.roles ?? []).some((role) => WORKING_ROLES.includes(role))) {
    throw forbidden('This account only has access to the Sales section, so it cannot hold API tokens.');
  }
}

/**
 * Your tokens, and everything the interface needs to offer a new one.
 *
 * The scope catalogue travels with the list so the form's labels and the server's enum cannot
 * drift apart — the same argument as the session list taking its device wording from the server.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await ApiToken.find({ owner: req.user._id }).sort({ createdAt: -1 });

    /*
     * The engagements a token could be bound to: the caller's own, minus the restricted ones.
     *
     * Restricted work is not reachable with a token at all — `loadTokenAudit` refuses it — so
     * offering it in the picker would be offering a choice that cannot work. Filtered here so the
     * refusal is a thing somebody never has to discover.
     */
    const engagements = await Audit.find(
      visibleAuditFilter(req.user, { classification: { $ne: 'restricted' } })
    )
      .select('name reference')
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    res.json({
      tokens: rows.map((row) => describeApiToken(row)),
      engagements: engagements.map((row) => ({
        id: row._id.toString(),
        name: row.name,
        reference: row.reference ?? '',
      })),
      scopes: Object.entries(SCOPES).map(([name, meta]) => ({ name, ...meta })),
      maxDays: MAX_TOKEN_DAYS,
      defaultDays: DEFAULT_TOKEN_DAYS,
      /** So the interface can say it in the same words the model means it. */
      canWrite: !(req.user.roles ?? []).includes('readonly'),
      /**
       * Whether this account may have one at all.
       *
       * Said here rather than left to the refusal, because a sales account has a profile page like
       * everybody else — and a button that is always going to fail is worse than an absent one
       * with a sentence in its place.
       */
      canHold: (req.user.roles ?? []).some((role) => WORKING_ROLES.includes(role)),
    });
  })
);

const mintBody = z.object({
  label: z.string().trim().min(1, 'Say what the token is for').max(120),
  scopes: z.array(z.enum(SCOPE_NAMES)).min(1, 'Choose at least one thing it may do'),
  /** Empty means every engagement its owner is on, which the interface warns about. */
  engagements: z
    .array(z.string().regex(/^[a-f\d]{24}$/i, 'That is not an engagement id'))
    .max(100)
    .optional()
    .default([]),
  days: z.coerce.number().int().min(1).max(MAX_TOKEN_DAYS).optional().default(DEFAULT_TOKEN_DAYS),
});

/**
 * Issues one, and answers with the secret — the only time it exists anywhere but in the caller's
 * hands.
 *
 * The engagements are checked against what the caller can actually reach, and against the
 * restricted rule, so a bad id or an engagement somebody has been taken off is refused here with
 * a sentence rather than at three in the morning with a 403.
 */
router.post(
  '/',
  validate(mintBody),
  asyncHandler(async (req, res) => {
    assertMayHoldTokens(req.user);

    const { label, scopes, engagements, days } = req.body;

    if (engagements.length) {
      const reachable = await Audit.find(
        visibleAuditFilter(req.user, { _id: { $in: engagements } })
      )
        .select('classification')
        .lean();

      const found = new Set(reachable.map((row) => row._id.toString()));
      const missing = engagements.filter((id) => !found.has(id));
      if (missing.length) {
        throw badRequest(
          `You are not on ${missing.length === 1 ? 'one of those engagements' : `${missing.length} of those engagements`}, so a token of yours cannot be for it.`
        );
      }
      const restricted = reachable.filter((row) => isRestricted(row));
      if (restricted.length) {
        throw badRequest(
          'One of those engagements is marked restricted. Restricted work needs a person signing in with two-factor authentication, so it cannot be reached with a token.'
        );
      }
    }

    const { token, row } = await mintApiToken({
      owner: req.user,
      label,
      scopes,
      audits: engagements,
      days,
      ip: req.ip ?? '',
    });

    res.status(201).json({
      /**
       * Shown once and never again.
       *
       * Named `token` rather than tucked inside the description, so a caller reading the response
       * in a terminal cannot miss the one field that will not be there next time.
       */
      token,
      /** Where to send it, so a person copying the secret has the URL beside it. */
      baseUrl: '/api/v1',
      apiToken: describeApiToken(row),
    });
  })
);

/** Retires one of yours. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await ApiToken.findOne({ _id: req.params.id, owner: req.user._id });
    if (!row) throw notFound('No such token');
    await revokeApiToken(row, req.user);
    res.json({ ok: true, apiToken: describeApiToken(row) });
  })
);

/**
 * All of them at once.
 *
 * Here because of what changing a password does *not* do. A password change bumps `tokenVersion`
 * and ends every session, and it deliberately leaves tokens alone: a routine rotation should not
 * break a pipeline, or nobody will rotate. That is the right default and it leaves a gap — the
 * person who has just realised something is wrong wants one button — so this is that button, and
 * the interface says plainly that the password change did not press it.
 */
router.post(
  '/revoke-all',
  asyncHandler(async (req, res) => {
    const result = await ApiToken.updateMany(
      { owner: req.user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: req.user._id } }
    );
    res.json({ ok: true, revoked: result.modifiedCount ?? 0 });
  })
);

export default router;
