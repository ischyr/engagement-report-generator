/**
 * Checks the TOTP implementation against the RFC test vectors and exercises the
 * replay and drift rules. Run with `npm run test:totp`.
 *
 * Getting this subtly wrong would mean codes that never validate — or worse, a
 * replay window an attacker can use — so it is worth pinning to the published
 * vectors rather than to "it worked when I tried it".
 */

import {
  base32Encode,
  base32Decode,
  generateCodeForStep,
  generateCode,
  generateSecret,
  stepFor,
  verifyCode,
  buildOtpauthUri,
  TOTP_PERIOD,
} from '../services/totp.js';

let pass = 0;
let fail = 0;
const check = (label, ok, got, want) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

/* ----------------------------- base32 round trip --------------------------- */
console.log('base32 (RFC 4648 test vectors):');
const B32 = [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
];
for (const [plain, encoded] of B32) {
  const got = base32Encode(Buffer.from(plain, 'ascii'));
  check(`encode ${JSON.stringify(plain)}`, got === encoded, got, encoded);
}
for (const [plain, encoded] of B32) {
  if (!encoded) continue;
  const got = base32Decode(encoded).toString('ascii');
  check(`decode ${encoded}`, got === plain, got, plain);
}

/* --------------------------- RFC 6238 TOTP vectors ------------------------- */
// The RFC's SHA-1 seed is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
console.log(`\nRFC 6238 SHA-1 vectors (secret ${RFC_SECRET}):`);
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [seconds, expected8] of VECTORS) {
  // The RFC publishes 8-digit values; ours are the low 6 digits of the same HOTP.
  const want = expected8.slice(-6);
  const got = generateCodeForStep(RFC_SECRET, Math.floor(seconds / TOTP_PERIOD));
  check(`t=${seconds}s`, got === want, got, want);
}

/* --------------------------------- behaviour ------------------------------- */
console.log('\nverification behaviour:');
const secret = generateSecret();
const now = Date.now();

check('accepts the current code', verifyCode(secret, generateCode(secret, now), { when: now }).valid);

check(
  'accepts the previous step (clock drift)',
  verifyCode(secret, generateCode(secret, now - TOTP_PERIOD * 1000), { when: now }).valid
);
check(
  'accepts the next step (clock drift)',
  verifyCode(secret, generateCode(secret, now + TOTP_PERIOD * 1000), { when: now }).valid
);
check(
  'rejects two steps in the past',
  verifyCode(secret, generateCode(secret, now - TOTP_PERIOD * 2000), { when: now }).valid === false
);

check('rejects a wrong code', verifyCode(secret, '000000', { when: now }).valid === false);
check(
  'rejects a non-numeric code',
  verifyCode(secret, 'abcdef', { when: now }).reason === 'format',
  verifyCode(secret, 'abcdef', { when: now }).reason,
  'format'
);
check(
  'rejects a short code',
  verifyCode(secret, '12345', { when: now }).reason === 'format'
);
check('tolerates spaces in what the user typed', verifyCode(secret, ` ${generateCode(secret, now)} `, { when: now }).valid);

// Replay: the same code must not work twice.
const step = stepFor(now);
const code = generateCode(secret, now);
check('first use of a code is accepted', verifyCode(secret, code, { when: now, lastUsedStep: null }).valid);
const replay = verifyCode(secret, code, { when: now, lastUsedStep: step });
check('same code rejected as replay', replay.valid === false && replay.reason === 'replay', replay.reason, 'replay');
check(
  'an older step is also rejected once a newer one was used',
  verifyCode(secret, generateCode(secret, now - TOTP_PERIOD * 1000), { when: now, lastUsedStep: step }).valid === false
);

check('missing secret fails closed', verifyCode('', '123456', { when: now }).valid === false);
check('two secrets do not validate each other', verifyCode(generateSecret(), generateCode(secret, now), { when: now }).valid === false);

/* ---------------------------------- URI ----------------------------------- */
console.log('\notpauth URI:');
const uri = buildOtpauthUri({ secret: 'ABCDEFGH', account: 'iulian@example.com', issuer: 'Engy Report' });
check('scheme and type', uri.startsWith('otpauth://totp/'), uri.slice(0, 20));
check('issuer prefix is encoded in the label', uri.includes('Engy%20Report%3Aiulian%40example.com'), uri);
check('carries the secret', uri.includes('secret=ABCDEFGH'));
check('declares SHA1 / 6 / 30', uri.includes('algorithm=SHA1') && uri.includes('digits=6') && uri.includes('period=30'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
