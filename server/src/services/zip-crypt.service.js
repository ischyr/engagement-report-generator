import crypto from 'node:crypto';

/**
 * A report, in a zip nobody can open without the password.
 *
 * A pentest report is the most sensitive document a client receives all year, and it left here as a
 * plain attachment on a plain mail. This wraps it instead: **AES-256, in the WinZip AE-2 format**,
 * which is the one encrypted-archive format that every recipient can already open — 7-Zip and
 * WinRAR on Windows, Archive Utility on macOS, `7z` and most `unzip` builds on Linux. No plugin, no
 * key exchange, no software the client has to be talked into installing.
 *
 * ## Why this is written out by hand
 *
 * Because the alternatives are worse rather than because it is fun. The zip library already in this
 * project — pizzip, which docxtemplater brings — cannot encrypt at all. The *legacy* ZipCrypto that
 * some tools offer is broken to the point of being a lie in a security product: a known-plaintext
 * attack recovers the contents of a zip like this one in seconds, and a docx has a great deal of
 * known plaintext at the front of it. And a password passed to LibreOffice's PDF exporter arrives
 * as a command-line argument, which means it is in `ps` output for every account on the machine.
 *
 * So: the container is assembled here. A zip holding one stored file is a small, completely
 * specified format — a local header, the bytes, a central directory, an end record — and the
 * encryption is four primitives Node ships. What is *not* hand-rolled is any cryptography: the key
 * derivation, the cipher and the MAC are all `node:crypto`, used the way the WinZip specification
 * says. `npm run test:zipcrypt` proves the result against a real 7-Zip rather than against my own
 * reading of the spec, which is the only assurance worth having here.
 *
 * ## What AE-2 is, in the four lines that matter
 *
 * - The key comes from PBKDF2-HMAC-SHA1 over the password, 1000 iterations, with a random salt.
 *   66 bytes of it: 32 to encrypt, 32 to authenticate, and 2 stored in the clear so a wrong
 *   password is rejected immediately rather than by handing back rubbish.
 * - The bytes are AES-256 in counter mode. The counter is **little-endian and starts at one**,
 *   which is the detail that makes this incompatible with `aes-256-ctr` as Node exposes it — hence
 *   the keystream being generated a block at a time below.
 * - The ciphertext is authenticated with HMAC-SHA1, truncated to 10 bytes, appended after the data.
 * - AE-2 stores a CRC of zero on purpose. The HMAC is the integrity check, and a CRC of the
 *   plaintext in the header would be a checksum of the secret sitting outside the encryption.
 */

/** AES-256: sixteen bytes of salt, per the specification's table of strengths. */
const SALT_BYTES = 16;
/** Not a choice — 1000 is what the format specifies, and a reader will use 1000 to open it. */
const PBKDF2_ITERATIONS = 1000;
/** Truncated to this by the format. The full digest is not stored. */
const AUTH_CODE_BYTES = 10;
/** `3` is AES-256 in the AES extra field. */
const AES_STRENGTH_256 = 3;
/** The method a reader finds in the header, telling it the entry is AES-encrypted. */
const METHOD_AES = 99;
/** Stored, not deflated: a .docx is a zip and a .pdf is compressed, so there is nothing to gain. */
const METHOD_STORE = 0;
/**
 * Bit 0 says encrypted; bit 11 says the filename is UTF-8.
 *
 * The second one is not optional here, and the test is what found that out. Without it a reader is
 * entitled to read the name as CP437 — so "Northwind Logistics — report.pdf" came out of a real
 * 7-Zip with the em-dash mangled, and any client whose name carries an accent would have received a
 * file named wrongly. The bytes were always fine; the label on them was not.
 */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;
const FLAGS = FLAG_ENCRYPTED | FLAG_UTF8_NAME;

/**
 * The keystream for one AES-CTR-as-WinZip-does-it run.
 *
 * ECB over a counter block we build ourselves, because the counter is little-endian in the low
 * eight bytes and starts at one. Node's `aes-256-ctr` counts big-endian across the whole block, so
 * using it directly produces an archive that every reader rejects — and it fails in a way that
 * looks like a wrong password, which is the worst possible symptom to debug.
 */
function encryptCtr(key, plaintext) {
  const out = Buffer.allocUnsafe(plaintext.length);
  const block = Buffer.alloc(16);
  const cipher = () => {
    const ecb = crypto.createCipheriv('aes-256-ecb', key, Buffer.alloc(0));
    ecb.setAutoPadding(false);
    return Buffer.concat([ecb.update(block), ecb.final()]);
  };

  let counter = 1n;
  for (let at = 0; at < plaintext.length; at += 16) {
    block.fill(0);
    block.writeBigUInt64LE(counter, 0);
    const keystream = cipher();
    const span = Math.min(16, plaintext.length - at);
    for (let index = 0; index < span; index += 1) {
      out[at + index] = plaintext[at + index] ^ keystream[index];
    }
    counter += 1n;
  }
  return out;
}

/** MS-DOS time and date, which is what a zip header carries. Two-second resolution, as designed. */
function dosStamp(when = new Date()) {
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date =
    ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * The 0x9901 extra field: what kind of AES, and what the method would have been.
 *
 * A reader needs the second part because the method field in the header says 99 — the real
 * compression is recorded here instead.
 */
function aesExtraField(actualMethod) {
  const field = Buffer.alloc(11);
  field.writeUInt16LE(0x9901, 0); // header id
  field.writeUInt16LE(7, 2); // the seven bytes that follow
  field.writeUInt16LE(2, 4); // AE-2
  field.write('AE', 6, 'latin1'); // vendor
  field.writeUInt8(AES_STRENGTH_256, 8);
  field.writeUInt16LE(actualMethod, 9);
  return field;
}

/**
 * One file, encrypted, as a complete zip archive.
 *
 * @param {object} input
 * @param {string} input.filename what the file is called inside the archive
 * @param {Buffer} input.bytes the file itself
 * @param {string} input.password
 * @param {Date} [input.when] the timestamp to record, for a reproducible archive in tests
 * @returns {Buffer} the archive
 */
export function encryptedZip({ filename, bytes, password, when }) {
  const name = String(filename ?? '').trim();
  if (!name) throw new Error('An encrypted archive needs a filename for what is inside it.');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('There is nothing to put in the archive.');
  }
  if (!password) throw new Error('There is no password to encrypt with.');

  const salt = crypto.randomBytes(SALT_BYTES);
  /*
   * 66 bytes in one derivation, split three ways. Deriving them separately would mean three
   * passes over the password and a different answer from every other implementation.
   */
  const derived = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    32 + 32 + 2,
    'sha1'
  );
  const encKey = derived.subarray(0, 32);
  const authKey = derived.subarray(32, 64);
  const passwordVerification = derived.subarray(64, 66);

  const ciphertext = encryptCtr(encKey, bytes);
  const authCode = crypto
    .createHmac('sha1', authKey)
    .update(ciphertext)
    .digest()
    .subarray(0, AUTH_CODE_BYTES);

  const payload = Buffer.concat([salt, passwordVerification, ciphertext, authCode]);
  const nameBytes = Buffer.from(name, 'utf8');
  const extra = aesExtraField(METHOD_STORE);
  const { time, date } = dosStamp(when instanceof Date ? when : new Date());

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(51, 4); // 5.1 — the version that understands AES
  localHeader.writeUInt16LE(FLAGS, 6);
  localHeader.writeUInt16LE(METHOD_AES, 8);
  localHeader.writeUInt16LE(time, 10);
  localHeader.writeUInt16LE(date, 12);
  localHeader.writeUInt32LE(0, 14); // CRC — zero, by AE-2
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(bytes.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(extra.length, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(51, 4); // made by
  central.writeUInt16LE(51, 6); // needed to extract
  central.writeUInt16LE(FLAGS, 8);
  central.writeUInt16LE(METHOD_AES, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(0, 42); // offset of the local header — first entry, so zero

  const localPart = Buffer.concat([localHeader, nameBytes, extra, payload]);
  const centralPart = Buffer.concat([central, nameBytes, extra]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // the disk with the central directory
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries in total
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([localPart, centralPart, end]);
}

/**
 * A passphrase worth using, for the button that offers one.
 *
 * Words rather than characters, because this password's whole life is being read off one screen and
 * typed into another — or dictated over a telephone. `Tz9$kQ2v` is unreadable aloud and gets
 * transcribed wrongly; four words from a list of this size carry more entropy than eight random
 * characters and survive the journey. Hyphenated so it is obvious where the breaks are, and drawn
 * with `randomInt` so the choice is uniform rather than modulo-biased.
 */
const WORDS = [
  'anchor', 'ballast', 'beacon', 'bishop', 'bramble', 'bridle', 'cactus', 'cadence',
  'canyon', 'cargo', 'cavern', 'cinder', 'cobalt', 'compass', 'copper', 'coral',
  'cypress', 'dagger', 'dolphin', 'ember', 'falcon', 'fathom', 'ferry', 'flint',
  'fossil', 'gable', 'gallon', 'granite', 'harbour', 'hazel', 'hollow', 'ingot',
  'ivory', 'jasper', 'kestrel', 'lantern', 'ledger', 'lichen', 'lumber', 'marble',
  'meadow', 'mercury', 'mosaic', 'nectar', 'nickel', 'nomad', 'onyx', 'orchid',
  'osprey', 'pebble', 'pewter', 'pigment', 'plover', 'quarry', 'quiver', 'ripple',
  'saffron', 'sandbar', 'sapling', 'sextant', 'shale', 'sorrel', 'spruce', 'stirrup',
  'sumac', 'talon', 'tandem', 'thicket', 'timber', 'tundra', 'turret', 'valley',
  'vellum', 'verdict', 'vessel', 'walnut', 'warden', 'willow', 'window', 'zephyr',
];

/** @param {number} [words] how many, defaulting to four */
export function suggestPassphrase(words = 4) {
  const count = Math.min(Math.max(Math.trunc(words) || 4, 3), 8);
  return Array.from({ length: count }, () => WORDS[crypto.randomInt(WORDS.length)]).join('-');
}

/** For the settings page and the docs: what a reader needs, said once, in one place. */
export const OPENED_WITH =
  '7-Zip or WinRAR on Windows, Archive Utility on macOS, or `7z x` on Linux. ' +
  "Windows Explorer's own zip support cannot open AES archives.";

export default encryptedZip;
