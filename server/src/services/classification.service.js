/**
 * What being marked restricted actually costs.
 *
 * A classification that is only a label is a label. The point of this one is that every
 * consequence is enforced by the server rather than remembered by a person: you cannot open a
 * restricted engagement without two-factor, you cannot lend it a credential that never expires,
 * you cannot promote its write-ups into the library everybody can read, a copy of it stays
 * restricted, and its trash empties sooner.
 *
 * The rules live here rather than spread across the routes that apply them, so "what does
 * restricted mean" has one answer and adding a sixth consequence is one edit.
 */

import { forbidden, badRequest } from '../utils/http-error.js';
import { Settings } from '../models/settings.model.js';

export const CLASSIFICATIONS = ['standard', 'restricted'];

export const CLASSIFICATION_LABELS = {
  standard: 'Standard',
  restricted: 'Restricted',
};

/** How long a borrowed credential may live on a restricted engagement, in days. */
export const RESTRICTED_CREDENTIAL_DAYS = 30;

export const isRestricted = (audit) => audit?.classification === 'restricted';

/**
 * Refuses to open a restricted engagement without a second factor.
 *
 * Applies to admins too, which is the point: an account that can read every engagement in the
 * instance is exactly the one whose password should not be sufficient on its own. The message
 * says what to do, because a flat "forbidden" on an engagement somebody was invited to reads
 * like a bug.
 */
export function assertMayOpen(audit, user) {
  if (!isRestricted(audit)) return;
  if (user?.totpEnabled) return;
  throw forbidden(
    'This engagement is marked restricted, so it needs two-factor authentication. ' +
      'Set it up on your profile and sign in again.'
  );
}

/**
 * Refuses a credential that would outlive the job.
 *
 * A borrowed password with no expiry is the thing the vault exists to stop being permanent, and
 * on a restricted engagement "we will delete it when we remember" is not good enough.
 *
 * @param {Date|null} expiresAt what the caller asked for
 * @returns {Date} the expiry to store
 */
export function resolveCredentialExpiry(audit, expiresAt) {
  if (!isRestricted(audit)) return expiresAt ?? null;

  const cap = new Date(Date.now() + RESTRICTED_CREDENTIAL_DAYS * 86_400_000);
  if (!expiresAt) {
    throw badRequest(
      `This engagement is restricted, so a credential has to expire. ` +
        `Pick a window of up to ${RESTRICTED_CREDENTIAL_DAYS} days.`
    );
  }
  // Silently shortened rather than refused: the intent was already "make this temporary", and
  // arguing about the exact day helps nobody.
  return expiresAt > cap ? cap : expiresAt;
}

/** Refuses to copy a restricted engagement's text into the library everybody can read. */
export function assertMayPromoteToLibrary(audit) {
  if (!isRestricted(audit)) return;
  throw forbidden(
    'This engagement is restricted, so its write-ups cannot go into the shared library — ' +
      'everybody with an account can read that. Copy the text by hand if it is genuinely generic.'
  );
}

/**
 * How long a trashed engagement of this classification is kept.
 *
 * Restricted work is the work you least want lying about in a trash nobody looks at, so it gets
 * a shorter window — configurable, and never longer than the ordinary one, because a setting
 * that made restricted material outlive everything else would be the opposite of the point.
 */
export async function retentionDaysFor(classification, settings = null) {
  const resolved = settings ?? (await Settings.getSettings());
  const ordinary = Number(resolved.danger?.public?.nbdaydelete);
  const base = Number.isFinite(ordinary) && ordinary >= 0 ? ordinary : 15;

  if (classification !== 'restricted') return base;

  const strict = Number(resolved.danger?.public?.nbdaydeleteRestricted);
  const wanted = Number.isFinite(strict) && strict >= 0 ? strict : 3;
  return Math.min(wanted, base);
}

export default assertMayOpen;
