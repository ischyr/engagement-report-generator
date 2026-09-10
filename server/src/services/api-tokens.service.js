/**
 * Minting, reading back and retiring the credentials that reach `/api/v1`.
 *
 * The secret exists in one place for one moment: the response to the request that created it. It
 * is not stored, not logged, not recoverable and not shown again — the row keeps a SHA-256 and the
 * first few characters, and that is all it ever keeps. A feature that could show a token twice
 * would be a feature that could show it to the wrong person.
 *
 * See `models/api-token.model.js` for why the bounds are shaped the way they are.
 */
import crypto from 'node:crypto';

import {
  ApiToken,
  DEFAULT_TOKEN_DAYS,
  MAX_TOKEN_DAYS,
  SCOPE_NAMES,
  TOKEN_PREFIX,
  WRITE_SCOPES,
  hashToken,
} from '../models/api-token.model.js';
import { badRequest, forbidden } from '../utils/http-error.js';

/** How many characters of a token the list may show. Enough to recognise, far too few to use. */
const PREVIEW_LENGTH = TOKEN_PREFIX.length + 6;

/**
 * A new secret.
 *
 * 30 bytes because base64url encodes it without padding into 40 characters, which is a string
 * somebody can select with a double-click and paste without a stray `=` at the end breaking a
 * shell quote. The entropy is not the interesting part at this size; the handling is.
 */
function newSecret() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(30).toString('base64url')}`;
}

/**
 * Issues one, and hands back the only copy of the secret there will ever be.
 *
 * @param {object} input
 * @param {object} input.owner       the account it acts as
 * @param {string} input.label       what it is for
 * @param {string[]} input.scopes    from SCOPE_NAMES
 * @param {string[]} [input.audits]  engagement ids; empty means everything the owner can reach
 * @param {number} [input.days]      lifetime, capped at MAX_TOKEN_DAYS
 * @param {string} [input.ip]        where it was made
 * @returns {Promise<{token: string, row: object}>}
 */
export async function mintApiToken({ owner, label, scopes, audits = [], days, ip = '' }) {
  const wanted = [...new Set((scopes ?? []).filter((scope) => SCOPE_NAMES.includes(scope)))];
  if (wanted.length === 0) throw badRequest('Choose at least one thing the token may do.');

  /*
   * A read-only account cannot mint a credential that writes.
   *
   * `requireWrite` already refuses the mutating routes for such an account, and the whole point of
   * that role is that a second role cannot quietly undo it. A token is a second credential, which
   * would be exactly such an undoing if this check were left out — and it would be an undoing that
   * outlives the session that arranged it.
   */
  if ((owner.roles ?? []).includes('readonly')) {
    const writes = wanted.filter((scope) => WRITE_SCOPES.includes(scope));
    if (writes.length) {
      throw forbidden('Your account is read-only, so a token of yours cannot be allowed to write.');
    }
  }

  const lifetime = Math.min(Math.max(1, Math.round(days ?? DEFAULT_TOKEN_DAYS)), MAX_TOKEN_DAYS);
  const token = newSecret();

  const row = await ApiToken.create({
    label,
    owner: owner._id,
    tokenHash: hashToken(token),
    preview: token.slice(0, PREVIEW_LENGTH),
    scopes: wanted,
    audits,
    expiresAt: new Date(Date.now() + lifetime * 24 * 60 * 60 * 1000),
    issuedIp: ip,
  });

  return { token, row };
}

/**
 * The token behind a presented secret, or null.
 *
 * Looks up by hash, so an unknown string costs one indexed query and reveals nothing by timing.
 * Whether the row is *usable* is a separate question with several answers, and the middleware
 * asks it — this only answers "is there such a token".
 */
export function findApiTokenBySecret(presented) {
  const value = String(presented ?? '');
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  return ApiToken.findOne({ tokenHash: hashToken(value) }).populate({
    path: 'owner',
    select: '+tokenVersion',
  });
}

/**
 * Notes that a token was used, at most once a minute.
 *
 * The reason to record it at all is so somebody can tell a live token from a forgotten one before
 * deleting it. The reason to throttle is that a pipeline making forty calls in a burst would
 * otherwise make forty writes to record a fact that has not changed. `useCount` is incremented on
 * the same schedule, so it is a coarse signal of use and is documented as one rather than being a
 * count somebody might trust for billing.
 */
const TOUCH_EVERY_MS = 60 * 1000;

export async function touchApiToken(row, ip = '') {
  const last = row.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last < TOUCH_EVERY_MS) return;
  await ApiToken.updateOne(
    { _id: row._id },
    { $set: { lastUsedAt: new Date(), lastUsedIp: ip }, $inc: { useCount: 1 } }
  ).catch(() => {
    /* A bookkeeping write must never fail the request it was bookkeeping for. */
  });
}

/**
 * What a token looks like to its owner, and to the API's own `whoami`.
 *
 * An explicit field list rather than the document: this shape is published, and a spread would
 * mean any field added to the model tomorrow is published too — starting with `tokenHash`.
 */
export function describeApiToken(row, { now = new Date() } = {}) {
  const expired = row.expiresAt <= now;
  return {
    id: row._id.toString(),
    label: row.label,
    preview: row.preview,
    scopes: row.scopes ?? [],
    /** The engagements it is bound to, as ids. Empty means everything its owner can reach. */
    engagements: (row.audits ?? []).map((id) => id?._id?.toString() ?? id.toString()),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp || '',
    useCount: row.useCount ?? 0,
    revokedAt: row.revokedAt,
    /** One word for the row's condition, so a list does not have to derive it three ways. */
    state: row.revokedAt ? 'revoked' : expired ? 'expired' : 'live',
  };
}

/** Retires one. Idempotent: revoking a revoked token is not an error worth raising. */
export async function revokeApiToken(row, actor) {
  if (row.revokedAt) return row;
  row.revokedAt = new Date();
  row.revokedBy = actor?._id ?? null;
  await row.save();
  return row;
}

export { SCOPE_NAMES, MAX_TOKEN_DAYS, DEFAULT_TOKEN_DAYS };
