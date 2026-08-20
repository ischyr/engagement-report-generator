/**
 * The rules around two-factor authentication, kept out of the route handlers so
 * enrolment, login and profile changes all enforce the same policy.
 */

import jwt from 'jsonwebtoken';

import env from '../config/env.js';
import { User } from '../models/user.model.js';
import { buildEnrolment, generateSecret, verifyCode } from './totp.js';
import { badRequest, forbidden, unauthorized } from '../utils/http-error.js';

/** Bad codes tolerated before the account pauses. */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Short-lived tokens that stand between "password accepted" and "code accepted".
 * They are scoped by purpose so an enrolment token cannot be replayed as a login
 * token, and they carry the user's tokenVersion so a password change kills them.
 */
const PURPOSE = { LOGIN: 'mfa-login', ENROL: 'mfa-enrol' };
const CHALLENGE_TTL = '10m';

function signChallenge(user, purpose) {
  return jwt.sign(
    { sub: user._id.toString(), purpose, version: user.tokenVersion },
    env.jwt.accessSecret,
    { expiresIn: CHALLENGE_TTL }
  );
}

/**
 * Resolves a challenge token back to its user, with the TOTP fields selected.
 * @returns {Promise<import('mongoose').Document>}
 */
async function loadFromChallenge(token, purpose) {
  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    throw unauthorized(
      err.name === 'TokenExpiredError'
        ? 'That took too long — start again.'
        : 'This verification link is not valid.'
    );
  }
  if (payload.purpose !== purpose) throw unauthorized('This verification link is not valid.');

  const user = await User.findById(payload.sub).select(
    '+totpSecret +totpLastStep +totpFailures +totpLockedUntil'
  );
  if (!user || !user.enabled) throw unauthorized('Account is disabled or no longer exists');
  if (user.tokenVersion !== payload.version) {
    throw unauthorized('Your password changed — sign in again.');
  }
  return user;
}

export const signLoginChallenge = (user) => signChallenge(user, PURPOSE.LOGIN);
export const signEnrolChallenge = (user) => signChallenge(user, PURPOSE.ENROL);
export const loadLoginChallenge = (token) => loadFromChallenge(token, PURPOSE.LOGIN);
export const loadEnrolChallenge = (token) => loadFromChallenge(token, PURPOSE.ENROL);

/**
 * Issues a fresh secret and the data the enrolment screen renders.
 * The secret is stored immediately but `totpEnabled` stays false until a code
 * proves the app is really holding it.
 */
export async function startEnrolment(user) {
  if (user.totpEnabled) {
    throw badRequest('Two-factor authentication is already on for this account.');
  }
  user.totpSecret = generateSecret();
  user.totpLastStep = null;
  user.totpFailures = 0;
  user.totpLockedUntil = null;
  await user.save({ validateBeforeSave: false });

  return buildEnrolment({ secret: user.totpSecret, account: user.username });
}

/**
 * True only when the account is *obliged* to finish enrolling — i.e. it was
 * created under the mandatory-enrolment rule and never confirmed a code.
 *
 * Deliberately not "has a secret but is not enabled": an established user who
 * opens the setup panel and closes it also has an unconfirmed secret, and they
 * must still be able to sign in with their password.
 */
export const hasPendingEnrolment = (user) =>
  Boolean(user.totpEnrolmentRequired) && !user.totpEnabled;

/**
 * Rebuilds the enrolment screen for someone who registered but never finished.
 *
 * Deliberately reuses the stored secret rather than minting a new one: if they
 * already scanned the QR, replacing the secret would silently invalidate it.
 */
export async function resumeEnrolment(user) {
  if (user.totpEnabled) throw badRequest('Two-factor authentication is already on.');
  if (!user.totpSecret) return startEnrolment(user);
  return buildEnrolment({ secret: user.totpSecret, account: user.username });
}

/**
 * Verifies a code against the user's secret, applying the replay guard and the
 * failure lockout. Throws with a user-facing message on rejection; saves the
 * accepted step on success.
 */
export async function consumeCode(user, code) {
  if (user.isTotpLocked()) {
    const minutes = Math.max(1, Math.ceil((user.totpLockedUntil.getTime() - Date.now()) / 60000));
    throw forbidden(
      `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    );
  }
  if (!user.totpSecret) {
    throw badRequest('Two-factor authentication is not set up for this account.');
  }

  const result = verifyCode(user.totpSecret, code, { lastUsedStep: user.totpLastStep ?? null });

  if (!result.valid) {
    // A replayed code means the secret is right, so it does not count towards
    // the lockout the way guessing does — but it must still be refused.
    if (result.reason !== 'replay') {
      user.totpFailures = (user.totpFailures ?? 0) + 1;
      if (user.totpFailures >= MAX_FAILURES) {
        user.totpLockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.totpFailures = 0;
      }
      await user.save({ validateBeforeSave: false });
    }

    if (result.reason === 'replay') {
      throw badRequest('That code has already been used. Wait for the next one.');
    }
    if (result.reason === 'format') {
      throw badRequest('Enter the 6-digit code from your authenticator app.');
    }
    const remaining = MAX_FAILURES - (user.totpFailures ?? 0);
    throw unauthorized(
      remaining > 0 && remaining <= 2
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left before a temporary lock.`
        : 'Incorrect code. Check your authenticator app and try again.'
    );
  }

  user.totpLastStep = result.step;
  user.totpFailures = 0;
  user.totpLockedUntil = null;
  await user.save({ validateBeforeSave: false });
  return result;
}

/** Completes enrolment once a code has been accepted. */
export async function finishEnrolment(user, code) {
  if (user.totpEnabled) throw badRequest('Two-factor authentication is already on.');
  await consumeCode(user, code);
  user.totpEnabled = true;
  // The obligation is discharged; turning 2FA off later must not re-impose it.
  user.totpEnrolmentRequired = false;
  await user.save({ validateBeforeSave: false });
  return user;
}

/** Turns 2FA off and forgets the secret. */
export async function disableTotp(user) {
  user.totpEnabled = false;
  user.totpSecret = null;
  user.totpLastStep = null;
  user.totpFailures = 0;
  user.totpLockedUntil = null;
  // Also covers the admin reset: someone who lost their phone must be able to
  // sign in with their password, not be sent straight back to enrolment.
  user.totpEnrolmentRequired = false;
  await user.save({ validateBeforeSave: false });
  return user;
}

export { MAX_FAILURES, LOCKOUT_MS };
