/**
 * Encryption for the one kind of data here that is not ours to keep: client credentials.
 *
 * Test accounts, API keys and VPN details used to live in **notes** — plaintext in the
 * database, in every backup, for ever, and readable by anyone who could read the
 * collection. They belong to the client, they are only needed for the length of the
 * engagement, and they are the first thing that client's own auditor asks about.
 *
 * AES-256-GCM, a fresh random IV per record, and the tag stored with it — so a modified
 * ciphertext fails to decrypt rather than returning something plausible.
 *
 * The key is **not** derived from `JWT_REFRESH_SECRET` or anything else already in use.
 * Rotating a JWT secret is routine and expected; if the vault hung off one, doing so would
 * silently destroy stored credentials. It gets its own variable, and without it the vault
 * refuses to store anything rather than quietly keeping secrets in the clear under a
 * reassuring label.
 */

import crypto from 'node:crypto';

import env from '../config/env.js';
import { badRequest } from '../utils/http-error.js';

const ALGORITHM = 'aes-256-gcm';

/**
 * 32 bytes, from hex or base64.
 *
 * Deliberately strict about length: a short key would be silently padded by a naive
 * implementation, and "encrypted with 6 bytes of entropy" is worse than an error.
 */
function readKey() {
  const raw = String(process.env.VAULT_KEY ?? '').trim();
  if (!raw) return null;

  let key = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) key = decoded;
  }
  return key;
}

/**
 * Read every time rather than cached.
 *
 * It is a 32-byte parse on a path that already talks to the database, and caching it makes
 * the module's behaviour depend on which call happened first — which is exactly the kind of
 * thing that is untestable and then wrong.
 */
const vaultKey = () => readKey();

/** Whether this instance can hold credentials at all. */
export const vaultEnabled = () => Boolean(vaultKey());

/** The same sentence in the API and the UI, so the fix is never a guess. */
export const VAULT_DISABLED_MESSAGE =
  'The credential vault is off because VAULT_KEY is not set. Generate one with ' +
  '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`, put it in ' +
  '.env as VAULT_KEY and restart. Keep it safe: without it, stored credentials cannot be read.';

export function assertVault() {
  if (!vaultEnabled()) throw badRequest(VAULT_DISABLED_MESSAGE);
}

/** @returns {{iv: string, tag: string, data: string}} all base64 */
export function encryptSecret(plaintext) {
  assertVault();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, vaultKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * Reverses it, or explains why it cannot.
 *
 * A failure here almost always means the key changed, so it says so — the alternative is a
 * generic error and an afternoon spent suspecting the database.
 */
export function decryptSecret(record) {
  assertVault();
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      vaultKey(),
      Buffer.from(record.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw badRequest(
      'This credential cannot be decrypted with the current VAULT_KEY. If the key was changed or ' +
        'regenerated, entries stored under the old one are unreadable and should be deleted and re-entered.'
    );
  }
}

export default { vaultEnabled, encryptSecret, decryptSecret, assertVault };
