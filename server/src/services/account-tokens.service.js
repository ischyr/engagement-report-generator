/**
 * Issuing and spending the one-time links that let somebody set their own password.
 *
 * One mechanism, two purposes and three ways in: an admin invites a new colleague, an admin
 * issues a reset for somebody who is locked out, and `npm run reset-password` does the same from
 * a shell for the case an admin cannot log in to do it — which is the case that matters, because
 * a firm with one admin who forgot their password had no way back into their own instance.
 */

import crypto from 'node:crypto';

import { AccountToken } from '../models/account-token.model.js';
import { User } from '../models/user.model.js';

/**
 * How long each kind is good for.
 *
 * An invitation is arranged with a person and may sit in a chat over a weekend. A reset is
 * something somebody asked for a minute ago, and a link that stays live for a week is a link
 * that outlives the reason it was made.
 */
export const TOKEN_LIFETIME = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * A new link for this account, invalidating any earlier one.
 *
 * Earlier tokens are dropped on purpose: two live links for one account is two chances for the
 * wrong one to be used, and "I sent it again" should mean the first is dead.
 *
 * @returns {Promise<{token: string, expiresAt: Date, purpose: string, path: string}>}
 */
export async function issueAccountToken({ user, purpose, issuedBy = null, ip = '' }) {
  await AccountToken.deleteMany({ user: user._id });

  // 32 bytes, url-safe: long enough that guessing is not a strategy and short enough to paste.
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (TOKEN_LIFETIME[purpose] ?? TOKEN_LIFETIME.reset));

  await AccountToken.create({
    user: user._id,
    tokenHash: hash(token),
    purpose,
    issuedBy: issuedBy?._id ?? null,
    issuedIp: ip,
    expiresAt,
  });

  return {
    token,
    expiresAt,
    purpose,
    /** What to append to the instance's own address. The app has no idea what that is. */
    path: `/set-password/${token}`,
  };
}

/**
 * Looks a token up without spending it, for the page that shows the form.
 *
 * Says nothing about *why* it failed. "No such token" and "that token expired" are the same
 * answer to somebody guessing, and the person holding a real link does not need the distinction
 * to know they should ask for another.
 */
export async function readAccountToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = await AccountToken.findOne({ tokenHash: hash(token) }).populate(
    'user',
    'username firstname lastname email enabled totpEnabled'
  );
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  if (!row.user || row.user.enabled === false) return null;
  return row;
}

/**
 * Spends it: sets the password, ends every existing session, and deletes the token.
 *
 * `tokenVersion` is bumped so refresh tokens minted before the change stop working. Somebody
 * resetting a password they think was compromised must not leave the other party signed in — a
 * reset that only changes what you type at the front door is not a reset.
 *
 * Two-factor is deliberately untouched. A link that both set a password *and* cleared the second
 * factor would be a single-channel account takeover, which is the opposite of what this is for;
 * `npm run reset-2fa` exists for a genuinely lost authenticator.
 */
export async function consumeAccountToken(token, password) {
  const row = await readAccountToken(token);
  if (!row) return null;

  const user = await User.findById(row.user._id).select('+password');
  if (!user) return null;

  user.password = password;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  /*
   * An invitation completes the account. Registration normally requires pairing an
   * authenticator, and an invited account has never been through it — so the flag stays set and
   * the first sign-in walks them into enrolment, exactly as a self-registration would.
   */
  if (row.purpose === 'invite' && user.totpEnabled !== true) {
    user.totpEnrolmentRequired = true;
  }
  await user.save();

  await AccountToken.deleteMany({ user: user._id });
  const { Session } = await import('../models/session.model.js');
  await Session.updateMany(
    { user: user._id, revokedAt: null },
    { revokedAt: new Date(), revokedReason: 'password-change' }
  );

  return { user, purpose: row.purpose };
}

export default issueAccountToken;
