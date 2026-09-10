/**
 * A signature the client can check without trusting us.
 *
 * The delivery register already answers "which file did they get": the SHA-256 of the exact bytes
 * is recorded beside who received them and when, so a document somebody is arguing about can be
 * matched against the row or shown not to match it. That is enough between colleagues and not
 * enough with a stranger, because the register is ours. A client who has been sent a report by
 * somebody impersonating us, or handed an edited copy by a third party, cannot check a hash they
 * were given by the same channel as the file.
 *
 * A detached signature closes that. The bytes are signed with a private key that never leaves this
 * server; the recipient verifies with a public key they can get once, out of band, and keep. After
 * that, every report they ever receive proves for itself that it came from this instance and has
 * not been altered by a comma.
 *
 * ## Why Ed25519, and why a detached file
 *
 * Ed25519 because the whole operation is one line of `node:crypto` on this side and one line of
 * `openssl` on theirs, with no certificate, no chain, no expiry and no authority to pay. The
 * alternatives were considered and are worse for this:
 *
 * - **PKCS#7 / CMS**, which Word and Acrobat understand natively, needs a certificate from a CA
 *   the client's machine already trusts to mean anything more than this does, and hand-rolling
 *   SignedData ASN.1 to avoid that dependency would be a great deal of code to produce a worse
 *   guarantee.
 * - **GPG** would mean requiring the binary, a keyring on the server and a key management story
 *   nobody asked for, to produce a signature most clients have no tool for.
 * - **Signing inside the .docx** (a Word digital signature) would change the bytes the delivery
 *   register recorded, and Word's own signature UI refuses anything but a certificate.
 *
 * Detached means the file is untouched: the same bytes the register hashed, the same bytes the
 * client opens, plus a second small file they may ignore. Nothing about the report depends on it.
 *
 * ## What is signed
 *
 * The file, not a hash of the file. Signing a digest we computed would ask the recipient to trust
 * our digest, which is the thing being proved. `openssl pkeyutl -verify -rawin` hashes the file
 * itself as part of verifying, so the client's tool reads the client's copy.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

import { assertVault, decryptSecret, encryptSecret } from './vault.service.js';
import { badRequest } from '../utils/http-error.js';

/** Written into every record, so a future second algorithm cannot be mistaken for this one. */
export const SIGNING_ALGORITHM = 'ed25519';

/** What the public key file is called wherever it is offered for download. */
export const PUBLIC_KEY_FILENAME = 'engy-signing-key.pub.pem';

/**
 * `SHA256:` and the base64 digest of the public key, which is OpenSSH's format.
 *
 * Recognisable, and short enough to read down a phone or print on a letterhead, which is how a
 * public key is actually verified out of band. Of the DER rather than the PEM: the PEM's line
 * breaks and header are presentation, and two files that differ only in those describe one key.
 */
export function fingerprintOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}

/**
 * A new key pair, with the private half ready for the vault.
 *
 * The vault is asserted first rather than after generating, so a server with no `VAULT_KEY` says
 * so instead of producing a key it cannot store and losing it on the way to the database.
 */
export function generateSigningKey() {
  assertVault();

  const { publicKey, privateKey } = generateKeyPairSync(SIGNING_ALGORITHM);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  return {
    algorithm: SIGNING_ALGORITHM,
    publicKey: publicKeyPem,
    /* AES-256-GCM under VAULT_KEY, exactly like a client's borrowed credential. */
    privateKey: encryptSecret(privateKeyPem),
    fingerprint: fingerprintOf(publicKeyPem),
    createdAt: new Date(),
  };
}

/** Whether this instance can sign at all, without decrypting anything to find out. */
export const signingConfigured = (settings) =>
  Boolean(settings?.signing?.enabled && settings?.signing?.publicKey && settings?.signing?.privateKey?.data);

/**
 * The signature over these exact bytes.
 *
 * Returns everything a record needs and nothing it does not: the private key is used and dropped.
 *
 * @returns {{algorithm: string, fingerprint: string, value: string, signedAt: Date}}
 */
export function signBytes(buffer, settings) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw badRequest('There is nothing to sign.');
  }
  if (!signingConfigured(settings)) {
    throw badRequest('No signing key is configured. Settings, then Delivery, then generate one.');
  }

  const privateKeyPem = decryptSecret(settings.signing.privateKey);
  if (!privateKeyPem) {
    throw badRequest('The signing key could not be read. It may have been stored under a different VAULT_KEY.');
  }

  /*
   * `null` as the algorithm is not an omission: Ed25519 has its own hash built into the scheme, and
   * Node refuses a digest name for it. Passing 'sha256' here throws.
   */
  const value = cryptoSign(null, buffer, createPrivateKey(privateKeyPem)).toString('base64');

  return {
    algorithm: SIGNING_ALGORITHM,
    fingerprint: settings.signing.fingerprint || fingerprintOf(settings.signing.publicKey),
    value,
    signedAt: new Date(),
  };
}

/**
 * The same check the client's `openssl` performs, for our own tests and for the register's own use.
 *
 * Worth having on this side as well: a signature that verifies here and not there is a bug in the
 * instructions, and one that verifies in neither is a bug in the signing. Being able to tell those
 * apart is the difference between an afternoon and a week.
 */
export function verifyBytes(buffer, signatureBase64, publicKeyPem) {
  try {
    return cryptoVerify(
      null,
      buffer,
      createPublicKey(publicKeyPem),
      Buffer.from(String(signatureBase64 ?? ''), 'base64')
    );
  } catch {
    /* A malformed key or signature is a failed verification, not a crash. */
    return false;
  }
}

/**
 * The note that travels with the pair, written for somebody who has never heard of this app.
 *
 * Plain text on purpose. It goes in an email beside two attachments, and the one thing it must not
 * do is require the reader to open a web page to find out how to check a file they were sent.
 *
 * The fingerprint is stated twice over: in the note, and implicitly in the key file they verify
 * with. That is what makes the out-of-band step meaningful — read the fingerprint off a phone call
 * once, and every note after this one can be checked against the key you already trust.
 */
export function verificationNote({ filename, digest, signature, publicKey, firm = '' }) {
  const signatureFile = `${filename}.sig`;
  const who = firm ? `${firm} ` : '';

  return [
    `How to check that ${filename} is the file ${who}sent, unaltered`,
    '',
    'Three files are involved:',
    '',
    `  ${filename}`,
    `  ${signatureFile}          the signature over that file`,
    `  ${PUBLIC_KEY_FILENAME}    the public key, which is not secret`,
    '',
    'With OpenSSL 3 (macOS, Linux, or Windows with Git installed):',
    '',
    `  openssl pkeyutl -verify -pubin -inkey ${PUBLIC_KEY_FILENAME} \\`,
    `    -rawin -in "${filename}" -sigfile "${signatureFile}"`,
    '',
    'It prints "Signature Verified Successfully" and nothing else. Any other answer means the',
    'file is not the one that was signed: assume it has been altered in transit and ask for it',
    'again, by a different route.',
    '',
    'To check the file is the one recorded as sent, without the signature:',
    '',
    `  sha256sum "${filename}"`,
    `  ${digest}`,
    '',
    'About the key',
    '',
    `  Algorithm    Ed25519`,
    `  Fingerprint  ${signature.fingerprint}`,
    '',
    'The fingerprint is worth confirming once by a route that is not email: read it back on a',
    'phone call, or from a letterhead. After that the same key checks every document you are ever',
    'sent from here, and nobody who does not hold the private half can produce a signature it',
    'accepts.',
    '',
    '--- public key, safe to share ---',
    String(publicKey ?? '').trim(),
    '',
  ].join('\n');
}

export default { generateSigningKey, signBytes, verifyBytes, signingConfigured, verificationNote };
