import crypto from 'node:crypto';

/**
 * Just enough tar to write and read a backup.
 *
 * A backup has to be one file, and it has to be openable in ten years by somebody who does not have
 * this application — which rules out anything clever. `tar` is the format that satisfies both: it
 * streams, it has no size ceiling worth worrying about, and `tar -tzf` works everywhere including
 * on Windows since 2018. What it does not have is a Node implementation in this project's
 * dependencies, and a backup is the last place to add a dependency you have not read.
 *
 * So: the two hundred lines of it that a backup needs. ustar, one entry after another, no sparse
 * files, no hard links, no extended attributes. `npm run test:backup` checks the result against
 * **GNU tar** rather than against this file's own reader, because an archive format is a promise to
 * other software and self-consistency proves nothing about whether the promise was kept.
 *
 * ## The one thing that shapes the design
 *
 * A tar header states the size of the entry *before* its bytes. That single fact decides how the
 * backup is assembled: anything whose length is known up front — a file on disk, a GridFS object —
 * streams straight in, and anything generated as it goes is written to a staging file first so its
 * length can be measured. It is why `backup.service.js` stages the database dump and does not stage
 * the evidence, which is the part that could be gigabytes.
 */

/** Every field in a ustar header, at its offset, with the size the format gives it. */
const BLOCK = 512;

const octal = (value, width) =>
  `${value.toString(8).padStart(width - 1, '0')}\0`;

/**
 * A header for one entry.
 *
 * The checksum is the sum of every byte of the header with the checksum field itself treated as
 * spaces — a rule from 1979 that every reader still enforces, and the single most likely thing to
 * get wrong, because an archive with bad checksums looks fine until something tries to read it.
 */
export function tarHeader(name, size, { mtime = new Date(), mode = 0o644, type = '0' } = {}) {
  const header = Buffer.alloc(BLOCK);

  /*
   * Long paths go in the `prefix` field, which is what makes this ustar rather than the original
   * format. A name that will not fit either field is refused loudly: silently truncating the path
   * of a file inside somebody's backup is the kind of failure that is found out during a restore.
   */
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 100);
    if (cut <= 0) throw new Error(`Cannot store "${name}" in a tar entry: the name is too long.`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`Cannot store "${name}" in a tar entry: the name is too long.`);
    }
  }

  header.write(base, 0, 100, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii'); // uid
  header.write(octal(0, 8), 116, 8, 'ascii'); // gid
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum, as spaces while it is computed
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  if (prefix) header.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

/** The zeros that round an entry up to a block. Tar is a format of 512-byte blocks and nothing else. */
export function tarPadding(size) {
  const over = size % BLOCK;
  return over === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - over);
}

/** Two empty blocks, which is how a reader knows the archive ended rather than was truncated. */
export function tarEnd() {
  return Buffer.alloc(BLOCK * 2);
}

/**
 * Writes entries to a stream, hashing each one as it goes.
 *
 * The digests are what the manifest carries, so a restore can say *this evidence file is not the
 * one that was backed up* rather than writing corrupt bytes into a fresh database and finding out
 * later. Computed here because this is the only place every byte passes through.
 */
export class TarWriter {
  constructor(stream) {
    this.stream = stream;
    /** @type {Array<{name: string, size: number, sha256: string}>} */
    this.entries = [];
  }

  /** Waits for drain rather than ignoring it: a backup outruns a gzip stream easily. */
  #write(chunk) {
    return this.stream.write(chunk) ? Promise.resolve() : new Promise((resolve) => this.stream.once('drain', resolve));
  }

  /** @param {string} name @param {Buffer} bytes */
  async addBuffer(name, bytes, options) {
    await this.#write(tarHeader(name, bytes.length, options));
    await this.#write(bytes);
    await this.#write(tarPadding(bytes.length));
    this.entries.push({
      name,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }

  /**
   * @param {string} name
   * @param {number} size known in advance — see the note at the top of this file
   * @param {AsyncIterable<Buffer>} source
   */
  async addStream(name, size, source, options) {
    await this.#write(tarHeader(name, size, options));
    const hash = crypto.createHash('sha256');
    let written = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      written += bytes.length;
      await this.#write(bytes);
    }
    /*
     * A stream that did not deliver what its length promised has produced a corrupt archive: every
     * entry after this one is offset by the difference. Better to fail here, with the name in hand.
     */
    if (written !== size) {
      throw new Error(`"${name}" was declared as ${size} bytes and delivered ${written}.`);
    }
    await this.#write(tarPadding(size));
    this.entries.push({ name, size, sha256: hash.digest('hex') });
  }

  async finish() {
    await this.#write(tarEnd());
  }
}

/**
 * Reads an archive back, entry by entry.
 *
 * A reader as well as a writer so a restore needs nothing but Node — the moment somebody reaches
 * for this is the moment to depend on as little as possible. It is deliberately strict: a bad
 * checksum stops the restore rather than being skipped, because an archive that has rotted in one
 * place has probably rotted in others.
 *
 * @param {AsyncIterable<Buffer>} source
 * @returns {AsyncGenerator<{name: string, size: number, bytes: Buffer}>}
 */
export async function* readTar(source) {
  let buffer = Buffer.alloc(0);
  const iterator = source[Symbol.asyncIterator]();

  /** Pulls until at least `wanted` bytes are held, or the source ends. */
  const fill = async (wanted) => {
    while (buffer.length < wanted) {
      const next = await iterator.next();
      if (next.done) return false;
      buffer = Buffer.concat([buffer, Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)]);
    }
    return true;
  };

  const take = (count) => {
    const out = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    return out;
  };

  for (;;) {
    if (!(await fill(BLOCK))) return;
    const header = take(BLOCK);

    /* Two empty blocks end the archive; one is padding somebody's writer left behind. */
    if (header.every((byte) => byte === 0)) continue;

    const stated = parseInt(header.toString('ascii', 148, 154).trim(), 8);
    const zeroed = Buffer.from(header);
    zeroed.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const byte of zeroed) sum += byte;
    if (sum !== stated) {
      throw new Error('This archive is damaged: a header checksum does not match its contents.');
    }

    const base = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${base}` : base;
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const type = header.toString('ascii', 156, 157);

    if (!(await fill(size))) {
      throw new Error(`This archive is truncated: "${name}" is missing bytes.`);
    }
    const bytes = take(size);
    await fill(tarPadding(size).length);
    take(tarPadding(size).length);

    /* Directories and anything exotic are skipped: a backup written here contains only files. */
    if (type === '0' || type === '\0') yield { name, size, bytes };
  }
}
