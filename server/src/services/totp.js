/**
 * Time-based one-time passwords (RFC 6238) for Google Authenticator, Authy,
 * 1Password and anything else that scans an `otpauth://` URI.
 *
 * Implemented on `node:crypto` rather than a package: it is HMAC plus a
 * documented truncation, and a wrong or abandoned dependency here would be a
 * security problem rather than an inconvenience.
 *
 * Google Authenticator only honours SHA-1 / 6 digits / 30 seconds, so those are
 * fixed rather than configurable.
 */

import crypto from 'node:crypto';
import QRCode from 'qrcode';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const TOTP_ALGORITHM = 'sha1';
/** Steps of clock drift accepted either side of now. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* -------------------------------------------------------------------------- */
/* Base32 (RFC 4648, unpadded — what authenticator apps expect)               */
/* -------------------------------------------------------------------------- */

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* -------------------------------------------------------------------------- */
/* Code generation and verification                                           */
/* -------------------------------------------------------------------------- */

/** A fresh 160-bit secret, base32-encoded — the length RFC 4226 recommends. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Counter for a moment in time. Exposed so callers can record the step used. */
export const stepFor = (when = Date.now()) => Math.floor(when / 1000 / TOTP_PERIOD);

/** HOTP for an explicit counter. */
export function generateCodeForStep(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  // 8-byte big-endian counter. writeBigUInt64BE keeps it correct past 2^32.
  counter.writeBigUInt64BE(BigInt(step));

  const digest = crypto.createHmac(TOTP_ALGORITHM, key).update(counter).digest();
  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const generateCode = (secret, when = Date.now()) =>
  generateCodeForStep(secret, stepFor(when));

/**
 * Checks a user-supplied code.
 *
 * @param {string} secret base32 secret
 * @param {string} code whatever the user typed
 * @param {{when?: number, lastUsedStep?: number|null}} [options]
 *   `lastUsedStep` blocks replay: a code stays valid for 30 seconds, so without
 *   this an attacker who observes one can reuse it inside that window.
 * @returns {{valid: boolean, step: number|null, reason?: string}}
 */
export function verifyCode(secret, code, options = {}) {
  const { when = Date.now(), lastUsedStep = null } = options;

  const digits = String(code ?? '').replace(/\D/g, '');
  if (digits.length !== TOTP_DIGITS) {
    return { valid: false, step: null, reason: 'format' };
  }
  if (!secret) return { valid: false, step: null, reason: 'no-secret' };

  const current = stepFor(when);
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift += 1) {
    const step = current + drift;
    let expected;
    try {
      expected = generateCodeForStep(secret, step);
    } catch {
      return { valid: false, step: null, reason: 'no-secret' };
    }
    // Constant-time compare; both operands are always 6 ASCII digits here.
    const matches = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits));
    if (!matches) continue;
    if (lastUsedStep !== null && step <= lastUsedStep) {
      return { valid: false, step, reason: 'replay' };
    }
    return { valid: true, step };
  }
  return { valid: false, step: null, reason: 'mismatch' };
}

/* -------------------------------------------------------------------------- */
/* Enrolment                                                                  */
/* -------------------------------------------------------------------------- */

/** The URI an authenticator app scans. */
export function buildOtpauthUri({ secret, account, issuer = 'Engy Report' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Everything the enrolment screen needs: the QR to scan, plus the secret in
 * readable groups for anyone typing it in by hand.
 */
export async function buildEnrolment({ secret, account, issuer = 'Engy Report' }) {
  const uri = buildOtpauthUri({ secret, account, issuer });
  const qr = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#0a0e14', light: '#ffffff' },
  });
  return {
    secret,
    otpauthUri: uri,
    qr,
    manualKey: secret.replace(/(.{4})/g, '$1 ').trim(),
    issuer,
    account,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  };
}

export default { generateSecret, generateCode, verifyCode, buildEnrolment };
