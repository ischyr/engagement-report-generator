/**
 * Checks the encrypted archive against a real reader.
 *
 *   npm run test:zipcrypt
 *
 * This is the one test in the project where checking my own arithmetic would be worthless. An
 * archive format is a promise to somebody else's software: the only question that matters is
 * whether the client double-clicking the file gets their report out, and no amount of decrypting it
 * with the same code that encrypted it can answer that. So the assertions that count run **7-Zip**,
 * and the structural ones only explain a failure when 7-Zip is unhappy.
 *
 * If 7-Zip is not installed, those blocks are skipped **loudly**. A test that quietly passes because
 * it did nothing is worse than one that says it was not run — and here it would be worse than no
 * test at all, because it would look like interoperability had been proved.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encryptedZip, suggestPassphrase } from '../services/zip-crypt.service.js';

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

/** Wherever 7-Zip is, if it is anywhere. */
function findSevenZip() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '7z',
    '7za',
    '7zz',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['i'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* Not this one. */
    }
  }
  return null;
}

const sevenZip = findSevenZip();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engy-zipcrypt-'));

/* Something with structure to it, so a partial or shifted decryption is obvious rather than subtle. */
const CONTENT = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'ascii'),
  crypto.randomBytes(3000),
  Buffer.from('\n%%EOF\n', 'ascii'),
]);
const PASSWORD = 'harbour-lichen-sextant-quarry';

/* -------------------------------------------------------------------------- */
/* The shape of it                                                            */
/* -------------------------------------------------------------------------- */
console.log('\nThe archive it writes:');
const archive = encryptedZip({
  filename: 'Northwind Logistics — report.pdf',
  bytes: CONTENT,
  password: PASSWORD,
  when: new Date('2026-09-09T10:30:00Z'),
});
{
  check('starts with a local file header', archive.readUInt32LE(0) === 0x04034b50);
  check(
    'says the entry is encrypted',
    (archive.readUInt16LE(6) & 0x0001) === 0x0001,
    `flags ${archive.readUInt16LE(6)}`
  );
  check('and that the method is AES', archive.readUInt16LE(8) === 99, String(archive.readUInt16LE(8)));
  check(
    'carries a CRC of zero, which is what AE-2 means',
    archive.readUInt32LE(14) === 0,
    String(archive.readUInt32LE(14))
  );

  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const extra = archive.subarray(30 + nameLength, 30 + nameLength + extraLength);
  check('with an AES extra field', extra.readUInt16LE(0) === 0x9901, extra.readUInt16LE(0).toString(16));
  check('declaring AE-2', extra.readUInt16LE(4) === 2, String(extra.readUInt16LE(4)));
  check('from the vendor the spec names', extra.toString('latin1', 6, 8) === 'AE');
  check('at 256 bits', extra.readUInt8(8) === 3, String(extra.readUInt8(8)));
  check(
    'over stored bytes, because a report is already compressed',
    extra.readUInt16LE(9) === 0,
    String(extra.readUInt16LE(9))
  );

  /* salt + two verification bytes + the data + ten bytes of MAC. */
  check(
    'and the payload is the right length for its parts',
    archive.readUInt32LE(18) === 16 + 2 + CONTENT.length + 10,
    `${archive.readUInt32LE(18)} for ${CONTENT.length} bytes of report`
  );
  check(
    'while the uncompressed size is the file itself',
    archive.readUInt32LE(22) === CONTENT.length,
    String(archive.readUInt32LE(22))
  );
  check(
    'the name survives its non-ASCII characters',
    archive.toString('utf8', 30, 30 + nameLength).includes('Northwind Logistics — report.pdf'),
    archive.toString('utf8', 30, 30 + nameLength)
  );
  check('and it ends with an end-of-central-directory record', archive.readUInt32LE(archive.length - 22) === 0x06054b50);

  /* The plaintext must not be in there anywhere. Cheap to check and catastrophic to get wrong. */
  check(
    'the report itself does not appear in the archive',
    !archive.includes(CONTENT.subarray(20, 120)),
    'a run of the plaintext is sitting in the ciphertext'
  );
}

console.log('\nAnd two archives of the same file:');
{
  const twice = encryptedZip({ filename: 'r.pdf', bytes: CONTENT, password: PASSWORD });
  const thrice = encryptedZip({ filename: 'r.pdf', bytes: CONTENT, password: PASSWORD });
  check(
    'differ, because the salt is fresh each time',
    !twice.equals(thrice),
    'the same bytes came out twice — the salt is not random'
  );
}

/* -------------------------------------------------------------------------- */
/* What a real reader makes of it                                             */
/* -------------------------------------------------------------------------- */
console.log('\nWhat 7-Zip makes of it:');
if (!sevenZip) {
  skipped += 3;
  console.log('  SKIPPED — no 7-Zip on this machine, so interoperability is UNPROVEN here.');
  console.log('            Install 7-Zip and run this again before trusting the format.');
} else {
  const file = path.join(scratch, 'report.zip');
  fs.writeFileSync(file, archive);

  /*
   * Listed without a password: the names are not secret, only the contents. `-slt` because the
   * default listing puts the method in a fixed-width column that elides it — the first version of
   * this test read the short listing and reported a missing AES-256 that was there all along.
   */
  const listing = execFileSync(sevenZip, ['l', '-slt', file], { encoding: 'utf8' });
  check(
    'it reads the archive and names what is inside',
    listing.includes('report.pdf'),
    listing.split('\n').slice(-6).join(' | ')
  );
  check('and reports it as AES-256', /Method = AES-256/i.test(listing), 'no AES-256 in the listing');
  check(
    'as a WinZip-encrypted entry',
    /WzAES/i.test(listing),
    listing.split('\n').find((line) => line.startsWith('Characteristics')) ?? 'none listed'
  );

  /* The whole point. */
  const out = path.join(scratch, 'out');
  execFileSync(sevenZip, ['x', file, `-p${PASSWORD}`, `-o${out}`, '-y'], { stdio: 'ignore' });
  /*
   * Whatever it decided to call the file, rather than what we asked for — and then checked. Reading
   * back the name we *sent* would have hidden the bug this found: without the UTF-8 flag set in the
   * header a reader may read the name as CP437, and the em-dash came out mangled.
   */
  const written = fs.readdirSync(out);
  check('it writes exactly one file out', written.length === 1, JSON.stringify(written));
  check(
    'named as we named it, em-dash and all',
    written[0] === 'Northwind Logistics — report.pdf',
    JSON.stringify(written[0])
  );
  const extracted = fs.readFileSync(path.join(out, written[0]));
  check(
    'with the password, it extracts the report byte for byte',
    extracted.equals(CONTENT),
    `${extracted.length} bytes out of ${CONTENT.length}`
  );

  /* And with the wrong one, it must fail rather than hand back rubbish. */
  let refused = false;
  try {
    execFileSync(sevenZip, ['x', file, '-pnot-the-password', `-o${path.join(scratch, 'wrong')}`, '-y'], {
      stdio: 'ignore',
    });
  } catch {
    refused = true;
  }
  check('and with the wrong one it refuses', refused, '7-Zip extracted it with a wrong password');
}

console.log('\nWhat `unzip` makes of it:');
{
  /*
   * A plain `unzip` cannot decrypt AES — that is a fact about `unzip`, not a fault here — but it
   * must still be able to *read the container*, because an archive that a common tool calls corrupt
   * is an archive a client will not trust however well it decrypts elsewhere.
   */
  try {
    execFileSync('unzip', ['-l', path.join(scratch, 'report.zip')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(scratch, 'report.zip'), archive);
    const listed = execFileSync('unzip', ['-l', path.join(scratch, 'report.zip')], {
      encoding: 'utf8',
    });
    check(
      'it lists the entry rather than calling the file corrupt',
      listed.includes('report.pdf'),
      listed.split('\n').slice(0, 4).join(' | ')
    );
  } catch (error) {
    skipped += 1;
    console.log(`  SKIPPED — no usable \`unzip\` here (${error.code ?? error.message}).`);
  }
}

/* -------------------------------------------------------------------------- */
/* The passphrase it offers                                                   */
/* -------------------------------------------------------------------------- */
console.log('\nThe passphrase on the button:');
{
  const one = suggestPassphrase();
  check('four words by default', one.split('-').length === 4, one);
  check('all lower case and hyphenated, so it can be dictated', /^[a-z]+(-[a-z]+){3}$/.test(one), one);

  const many = new Set(Array.from({ length: 200 }, () => suggestPassphrase()));
  check('and a different one every time', many.size === 200, `${many.size} distinct out of 200`);

  check('a longer one if asked', suggestPassphrase(6).split('-').length === 6);
  check('and never fewer than three words, whatever is asked', suggestPassphrase(1).split('-').length === 3);
}

console.log('\nAnd what it refuses:');
{
  const fails = (input) => {
    try {
      encryptedZip(input);
      return false;
    } catch {
      return true;
    }
  };
  check('no password', fails({ filename: 'a.pdf', bytes: CONTENT, password: '' }));
  check('nothing to encrypt', fails({ filename: 'a.pdf', bytes: Buffer.alloc(0), password: 'x' }));
  check('no name for what is inside', fails({ filename: '  ', bytes: CONTENT, password: 'x' }));
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log(
  `\nRESULT: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} SKIPPED` : ''}`
);
process.exit(failed ? 1 : 0);
