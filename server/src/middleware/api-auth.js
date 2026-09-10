/**
 * The gate in front of `/api/v1`, and the only place a token is accepted.
 *
 * Two credentials exist in this application and they are not interchangeable. A session — access
 * token, refresh cookie, media cookie, collaboration cookie — belongs to a person at a keyboard
 * and reaches the app's own routes. A token belongs to a script and reaches `/api/v1`. Neither
 * works where the other does, and both refusals say which credential the route wanted.
 *
 * That is a deliberate cost. It would be less code to widen `requireAuth` to also accept a token
 * and let everything through, and it would be wrong twice over: the app's own routes are shaped
 * for the app and change whenever the app does — one of them changed shape earlier in this very
 * codebase's history and surprised the person who wrote it — while `/api/v1` is a promise to
 * somebody's pipeline. A promise and a moving target cannot be the same routes.
 *
 * The refusal in the other direction matters just as much. If a session reached `/api/v1`, the
 * versioned surface would quietly become the app's own back door: every scope check bypassed,
 * because a session has no scopes to check.
 */
import jwt from 'jsonwebtoken';

import env from '../config/env.js';
import { SIGN_IN_BLOCK_MESSAGES } from '../models/user.model.js';
import { TOKEN_PREFIX } from '../models/api-token.model.js';
import { findApiTokenBySecret, touchApiToken } from '../services/api-tokens.service.js';
import { isRestricted } from '../services/classification.service.js';
import { membershipExpired } from '../utils/audit-scope.js';
import asyncHandler from '../utils/async-handler.js';
import { forbidden, notFound, unauthorized } from '../utils/http-error.js';

/** The credential on the request, whatever kind it is. */
function bearer(req) {
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Rejects the request unless a live, in-scope token is behind it.
 *
 * Sets `req.token` to the row and `req.user` to its owner, so everything downstream that already
 * knows how to read `req.user` — `membershipExpired`, the audit queries, `recordActivity` — keeps
 * working without a second notion of who is acting.
 */
export const requireApiToken = asyncHandler(async (req, _res, next) => {
  const presented = bearer(req);
  if (!presented) {
    throw unauthorized(
      `This API needs a token. Send it as "Authorization: Bearer ${TOKEN_PREFIX}…" — make one on your profile.`
    );
  }

  /*
   * A session's access token, sent here by mistake, gets told so.
   *
   * Worth the two lines: somebody wiring up a script copies the Authorization header out of their
   * browser's network tab, and "Invalid token" would send them looking for a typo in a string that
   * is not the problem. It is verified rather than merely shaped, so this cannot be used to learn
   * anything about an arbitrary string.
   */
  if (!presented.startsWith(TOKEN_PREFIX)) {
    let isSession = false;
    try {
      jwt.verify(presented, env.jwt.accessSecret);
      isSession = true;
    } catch {
      isSession = false;
    }
    throw unauthorized(
      isSession
        ? 'That is a browser session token. This API only accepts an API token, which you make on your profile.'
        : `That is not an API token. They begin with "${TOKEN_PREFIX}".`
    );
  }

  const row = await findApiTokenBySecret(presented);
  if (!row) throw unauthorized('That API token is not recognised. It may have been deleted.');

  /* Said apart, because "expired" and "revoked" lead somebody to different next actions. */
  if (row.revokedAt) throw unauthorized('That API token has been revoked.');
  if (row.expiresAt <= new Date()) {
    throw unauthorized(`That API token expired on ${row.expiresAt.toISOString().slice(0, 10)}.`);
  }

  const owner = row.owner;
  if (!owner) throw unauthorized('The account this token belongs to no longer exists.');
  const block = owner.signInBlock?.();
  if (block) throw unauthorized(SIGN_IN_BLOCK_MESSAGES[block]);

  req.token = row;
  req.user = owner;
  /* Not awaited before the work: bookkeeping should not add latency to a machine's request. */
  touchApiToken(row, req.ip ?? '');
  return next();
});

/**
 * Route guard: `requireScope('findings:write')`.
 *
 * Every route names what it needs. There is no implication between scopes — `findings:write` does
 * not confer `findings:read` — because a hierarchy is a thing the reader of a token list has to
 * hold in their head, and the list is the whole point of scopes existing.
 */
export const requireScope =
  (...needed) =>
  (req, _res, next) => {
    if (!req.token) return next(unauthorized());
    const held = req.token.scopes ?? [];
    const missing = needed.filter((scope) => !held.includes(scope));
    if (missing.length === 0) return next();
    return next(
      forbidden(
        `This token does not have ${missing.join(' or ')}. It has: ${held.join(', ') || 'nothing'}.`
      )
    );
  };

/**
 * The clause naming every engagement a token may reach.
 *
 * Three bounds, all applied, and the interesting one is what is *absent*: `auditAccessClause`
 * returns null for an admin, meaning "no restriction", and this deliberately does not do that. An
 * account that can open every engagement in the instance is exactly the account whose long-lived
 * bearer string should not inherit that reach — so an admin's token has to name its engagements
 * like anybody else's, and an admin's token with no engagements named reaches only the engagements
 * they are actually on.
 *
 * Restricted engagements are excluded outright. `assertMayOpen` lets a person with two-factor
 * authentication open one, which is a statement about a person proving themselves twice; a token
 * is a single string in a configuration file and can prove nothing twice. So the most sensitive
 * engagements are not reachable by automation at all, and the message says so rather than
 * pretending the engagement does not exist.
 */
export function tokenAuditFilter(req, extra = {}) {
  const user = req.user;
  const bound = (req.token.audits ?? []).map((id) => id?._id ?? id);

  return {
    deletedAt: null,
    classification: { $ne: 'restricted' },
    ...extra,
    $and: [
      ...(extra.$and ?? []),
      /* Membership, always — no admin short-circuit. See above. */
      {
        $or: [{ creator: user._id }, { collaborators: user._id }, { reviewers: user._id }],
      },
      /* And, when the token names engagements, only those. */
      ...(bound.length ? [{ _id: { $in: bound } }] : []),
    ],
  };
}

/**
 * Loads one engagement for a token, or explains which of the several reasons refused it.
 *
 * The reasons are told apart on purpose. "Not found", "your token is not for that engagement" and
 * "that engagement is restricted" send somebody to three different places, and collapsing them
 * into one 404 to avoid confirming an id's existence would be security theatre here: the caller
 * already holds a credential belonging to a named member of staff.
 */
export async function loadTokenAudit(req, { populate = false } = {}) {
  const { Audit } = await import('../models/audit.model.js');

  const query = Audit.findOne({ _id: req.params.id, deletedAt: null });
  if (populate) query.populate({ path: 'company', select: 'name' });
  const audit = await query;
  if (!audit) throw notFound('Engagement not found');

  if (isRestricted(audit)) {
    throw forbidden(
      'That engagement is marked restricted, so it cannot be reached with an API token. ' +
        'Restricted work needs a person signing in with two-factor authentication.'
    );
  }

  const bound = (req.token.audits ?? []).map((id) => String(id?._id ?? id));
  if (bound.length && !bound.includes(String(audit._id))) {
    throw forbidden('This token is not for that engagement.');
  }

  const uid = String(req.user._id);
  const member = [
    String(audit.creator?._id ?? audit.creator ?? ''),
    ...(audit.collaborators ?? []).map((id) => String(id?._id ?? id)),
    ...(audit.reviewers ?? []).map((id) => String(id?._id ?? id)),
  ].includes(uid);
  if (!member) {
    throw forbidden(
      'The account this token belongs to is not on that engagement. A token cannot reach more than its owner can.'
    );
  }
  if (membershipExpired(audit, req.user)) {
    throw forbidden("The account this token belongs to no longer has access to that engagement.");
  }

  return audit;
}

export default requireApiToken;
