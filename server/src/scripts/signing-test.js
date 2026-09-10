/**
 * Checks the delivery signature against the tool the client will actually use.
 *
 *   npm run test:signing
 *
 * The same argument as the encrypted archive: verifying a signature with the code that produced it
 * proves the arithmetic is self-consistent and nothing else. What matters is whether the four lines
 * of `openssl` printed in the verification note work when a stranger pastes them, so that is what
 * this runs — the exact command from `verificationNote`, extracted from the note itself rather than
 * retyped here, because a test that checks a copy of the instructions cannot catch the instructions
 * being wrong.
 *
 * Without OpenSSL those blocks are skipped **loudly**. A signature test that quietly passes for
 * want of a verifier is worse than no test: it looks like interoperability was proved.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PUBLIC_KEY_FILENAME,
  fingerprintOf,
  generateSigningKey,
  signBytes,
  signingConfigured,
  verificationNote,
  verifyBytes,
} from '../services/signing.service.js';
import { decryptSecret } from '../services/vault.service.js';

let passed = 0;
let failed = 0;
let skipped = 0;

const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};
const skip = (label, why) => {
  skipped += 1;
  console.log(`  SKIP  ${label} — ${why}`);
};

/*
 * A VAULT_KEY for the duration, because the private half is stored encrypted and generating a key
 * without one should fail rather than hand back something unstorable. Set here rather than read
 * from .env so the test is the same on a machine that has never configured one.
 */
process.env.VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');

console.log('\nA key:');
const key = generateSigningKey();
check('is Ed25519', key.algorithm === 'ed25519', key.algorithm);
check('has a public half in the clear', key.publicKey.includes('BEGIN PUBLIC KEY'), 'not a PEM');
check(
  'and a private half that is not',
  Boolean(key.privateKey.data) && !JSON.stringify(key.privateKey).includes('BEGIN PRIVATE KEY'),
  'the private key is not encrypted'
);
check(
  'which the vault can read back',
  decryptSecret(key.privateKey).includes('BEGIN PRIVATE KEY'),
  'the round trip through the vault failed'
);
check(
  'the fingerprint is the OpenSSH shape',
  /^SHA256:[A-Za-z0-9+/]{43}$/.test(key.fingerprint),
  key.fingerprint
);
check(
  'and is of the key rather than of its formatting',
  fingerprintOf(`${key.publicKey.trim()}\n`) === key.fingerprint,
  'a trailing newline changed the fingerprint'
);

/* The settings shape the rest of the app passes around. */
const settings = { signing: { ...key, enabled: true } };
check('an instance with a key can sign', signingConfigured(settings));
check('one without cannot', !signingConfigured({ signing: { enabled: true } }));
check('nor can one with the key switched off', !signingConfigured({ signing: { ...key, enabled: false } }));

console.log('\nA signature:');
/* Something the size and shape of a real report, and not compressible to nothing. */
const report = Buffer.concat([
  Buffer.from('PK\u0003\u0004'),
  crypto.randomBytes(64 * 1024),
]);
const signature = signBytes(report, settings);
check('is base64', /^[A-Za-z0-9+/]+={0,2}$/.test(signature.value), signature.value.slice(0, 24));
check('of 64 bytes, as Ed25519 always is', Buffer.from(signature.value, 'base64').length === 64);
check('carries the fingerprint of the key that made it', signature.fingerprint === key.fingerprint);
check('and verifies', verifyBytes(report, signature.value, key.publicKey));

console.log('\nAnd fails when it should:');
{
  const altered = Buffer.from(report);
  altered[altered.length - 1] ^= 0x01;
  check('one flipped bit in the file', !verifyBytes(altered, signature.value, key.publicKey));

  const wrong = generateSigningKey();
  check('the wrong public key', !verifyBytes(report, signature.value, wrong.publicKey));

  const tamperedSignature = Buffer.from(signature.value, 'base64');
  tamperedSignature[0] ^= 0x01;
  check(
    'a signature somebody edited',
    !verifyBytes(report, tamperedSignature.toString('base64'), key.publicKey)
  );
  check('a signature that is not base64 at all', !verifyBytes(report, 'not a signature', key.publicKey));
  check('an empty signature', !verifyBytes(report, '', key.publicKey));
  check('and a public key that is nonsense', !verifyBytes(report, signature.value, 'not a key'));
}

/* -------------------------------------------------------------------------- */
/* The instructions, run as written                                           */
/* -------------------------------------------------------------------------- */
console.log('\nThe note that goes to the client:');

const digest = crypto.createHash('sha256').update(report).digest('hex');
const filename = 'Northwind Logistics - Penetration Test Report.docx';
const note = verificationNote({
  filename,
  digest,
  signature,
  publicKey: key.publicKey,
  firm: 'Northwind Security',
});

check('names the file it is about', note.includes(filename));
check('states the digest the register holds', note.includes(digest));
check('states the fingerprint to confirm out of band', note.includes(key.fingerprint));
check('carries the public key itself', note.includes('BEGIN PUBLIC KEY'));
check('and never the private one', !note.includes('BEGIN PRIVATE KEY'));

/** OpenSSL, if this machine has one. */
const openssl = (() => {
  for (const candidate of ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try {
      const version = execFileSync(candidate, ['version'], { encoding: 'utf8' }).trim();
      return { command: candidate, version };
    } catch {
      /* try the next one */
    }
  }
  return null;
})();

if (!openssl) {
  skip('the command in the note verifies the file', 'no openssl on this machine');
  skip('and refuses an altered one', 'no openssl on this machine');
} else {
  console.log(`  with ${openssl.version}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engy-signing-'));
  try {
    /*
     * Written out exactly as a client would have them: the report, the .sig beside it, the public
     * key under the name the note uses. The filename has spaces in it on purpose, because the real
     * one does and a command that needs quoting is the commonest way instructions fail.
     */
    fs.writeFileSync(path.join(dir, filename), report);
    fs.writeFileSync(path.join(dir, `${filename}.sig`), Buffer.from(signature.value, 'base64'));
    fs.writeFileSync(path.join(dir, PUBLIC_KEY_FILENAME), key.publicKey);

    /*
     * The arguments are taken from the note rather than written again here. The point of this test
     * is that what the client is told to run is what works, so anything retyped from the note is a
     * second copy that can drift from it and pass anyway.
     */
    const printed = note
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('openssl ') || line.startsWith('-rawin'))
      .join(' ')
      .replace(/\\$/g, '')
      .trim();

    const args = [...printed.matchAll(/"([^"]+)"|(\S+)/g)]
      .map((match) => match[1] ?? match[2])
      .filter((argument) => argument !== 'openssl' && argument !== '\\');

    check('the note contains one runnable command', args.length >= 8, printed);

    const run = (cwd) =>
      execFileSync(openssl.command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    let threw = null;
    try {
      output = run(dir);
    } catch (error) {
      threw = error;
    }
    check(
      'and it verifies the file',
      !threw && /Signature Verified Successfully/i.test(output),
      threw ? String(threw.stderr ?? threw.message).trim().split('\n')[0] : output.trim()
    );

    /* The same command, against a file with one byte changed. */
    const altered = Buffer.from(report);
    altered[0] = altered[0] ^ 0xff;
    fs.writeFileSync(path.join(dir, filename), altered);
    let refused = false;
    try {
      run(dir);
    } catch {
      refused = true;
    }
    check('and refuses one that has been altered', refused);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  `\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`
);
process.exit(failed ? 1 : 0);
