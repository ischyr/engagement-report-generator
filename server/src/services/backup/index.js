import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { EJSON } from 'bson';

import env from '../../config/env.js';
import { log } from '../../utils/logger.js';
import { MEDIA_BUCKET } from '../media.service.js';
import { TarWriter, readTar } from './tar.js';

/**
 * Everything this instance holds, as one file — and the way back.
 *
 * The instance keeps other firms' penetration test reports, their evidence, their credentials and
 * the record of what was told to whom. All of it lives in one MongoDB, evidence included, and until
 * now there was no way to take a copy of it or to put one back. That is the gap a firm's own auditor
 * asks about, and the one that turns a disk failure into an apology.
 *
 * ## What is in it
 *
 * ```
 * manifest.json          what this is, when, from which build, and a digest per entry
 * db/<collection>.jsonl  every document, one per line, as MongoDB extended JSON
 * media/index.jsonl      the evidence catalogue: ids, filenames, lengths, metadata
 * media/<id>             the evidence itself, straight out of GridFS
 * templates/<file>       the .docx templates, which live on disk rather than in the database
 * ```
 *
 * **Extended JSON, not JSON.** An `ObjectId` is not a string and a `Date` is not a number, and a
 * backup that flattened them would restore a database that looked right and joined to nothing. This
 * is the format `mongoexport` uses for the same reason.
 *
 * **Evidence ids are preserved.** A finding's HTML points at `/api/media/<id>`, so restoring a
 * screenshot under a new id would leave every report full of broken pictures. GridFS is written back
 * with the ids it had.
 *
 * ## What is deliberately left out
 *
 * Sessions. They are the one collection whose contents are worthless a moment later, and restoring
 * them would put revoked tokens back into circulation. Everybody signs in again, which is the
 * correct outcome of a restore anyway.
 *
 * ## Why this is a command and not a button
 *
 * A backup belongs in cron or a systemd timer, not in a request: it can run for minutes, it is
 * bounded by nothing a reverse proxy will tolerate, and an HTTP endpoint that streams the entire
 * database is a hole nobody needs. `npm run backup` writes a file; where that file then goes —
 * another disk, another building — is a decision this application should not be making.
 */

/** Bumped only when the archive layout changes in a way a reader must know about. */
export const BACKUP_FORMAT = 1;

/** Worthless a moment after it is written, and actively unhelpful to restore. */
const SKIP_COLLECTIONS = new Set(['sessions']);

/** How many documents to hold in memory while dumping one collection. */
const DUMP_BATCH = 500;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** `engy-backup-2026-09-09T10-30-00.tar.gz` — sorts correctly and says what it is. */
export const defaultBackupName = () => `engy-backup-${stamp()}.tar.gz`;

function bucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: MEDIA_BUCKET });
}

/**
 * Writes a backup to `out`.
 *
 * @param {object} [options]
 * @param {string} [options.out] where to write; a directory gets a dated filename
 * @param {(line: string) => void} [options.onProgress]
 * @returns {Promise<{file: string, bytes: number, collections: number, documents: number, media: number, templates: number}>}
 */
export async function writeBackup({ out, onProgress = () => {} } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected to a database.');

  let target = out ?? path.join(process.cwd(), defaultBackupName());
  const asDirectory = await fsp
    .stat(target)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (asDirectory) target = path.join(target, defaultBackupName());
  await fsp.mkdir(path.dirname(target), { recursive: true });

  /*
   * The staging directory exists for one reason: a tar header states an entry's length before its
   * bytes, and a collection's dump has no length until it has been written. Evidence and templates
   * are not staged — their lengths are known, so they stream straight through, which is what keeps
   * a backup of forty gigabytes of screenshots from needing forty gigabytes of scratch space.
   */
  const staging = path.join(env.storage.tmp, `backup-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(staging, { recursive: true });

  const gzip = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(target);
  const done = pipeline(gzip, file);
  const tar = new TarWriter(gzip);

  const counts = { collections: 0, documents: 0, media: 0, templates: 0 };

  try {
    /* ------------------------------------------------------------- the database */
    const collections = (await db.listCollections().toArray())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('system.'))
      /*
       * GridFS is backed up through its own bucket rather than as two ordinary collections: the
       * chunks collection is the evidence itself, and reading it as documents would mean holding a
       * 60 MB recording in memory as base64 inside a JSON line.
       */
      .filter((name) => name !== `${MEDIA_BUCKET}.files` && name !== `${MEDIA_BUCKET}.chunks`)
      .filter((name) => !SKIP_COLLECTIONS.has(name))
      .sort();

    for (const name of collections) {
      const staged = path.join(staging, `${name}.jsonl`);
      const handle = await fsp.open(staged, 'w');
      let documents = 0;
      try {
        const cursor = db.collection(name).find({}, { batchSize: DUMP_BATCH });
        let lines = [];
        for await (const document of cursor) {
          lines.push(EJSON.stringify(document, { relaxed: false }));
          documents += 1;
          if (lines.length >= DUMP_BATCH) {
            await handle.write(`${lines.join('\n')}\n`);
            lines = [];
          }
        }
        if (lines.length) await handle.write(`${lines.join('\n')}\n`);
      } finally {
        await handle.close();
      }

      const { size } = await fsp.stat(staged);
      await tar.addStream(`db/${name}.jsonl`, size, fs.createReadStream(staged));
      await fsp.rm(staged, { force: true });

      counts.collections += 1;
      counts.documents += documents;
      onProgress(`  ${name}: ${documents} document${documents === 1 ? '' : 's'}`);
    }

    /* -------------------------------------------------------------- the evidence */
    const files = await bucket().find({}).toArray();
    const catalogue = files.map((entry) => EJSON.stringify(entry, { relaxed: false })).join('\n');
    await tar.addBuffer('media/index.jsonl', Buffer.from(catalogue ? `${catalogue}\n` : '', 'utf8'));

    for (const entry of files) {
      /*
       * `length` from the catalogue, which is what makes this a straight stream rather than a
       * staged copy. GridFS records it when the object is written and it cannot drift.
       */
      await tar.addStream(
        `media/${String(entry._id)}`,
        entry.length,
        bucket().openDownloadStream(entry._id)
      );
      counts.media += 1;
    }
    onProgress(`  evidence: ${counts.media} file${counts.media === 1 ? '' : 's'}`);

    /* ------------------------------------------------------------- the templates */
    const templates = await fsp.readdir(env.storage.templates).catch(() => []);
    for (const name of templates) {
      const full = path.join(env.storage.templates, name);
      const entry = await fsp.stat(full);
      if (!entry.isFile()) continue;
      await tar.addStream(`templates/${name}`, entry.size, fs.createReadStream(full));
      counts.templates += 1;
    }
    onProgress(`  templates: ${counts.templates} file${counts.templates === 1 ? '' : 's'}`);

    /* --------------------------------------------------------------- the manifest */
    /*
     * Last, because it carries a digest of every entry before it — which is what lets a restore say
     * "this file is not the one that was backed up" instead of writing damaged bytes into a fresh
     * database and finding out months later.
     */
    await tar.addBuffer(
      'manifest.json',
      Buffer.from(
        `${JSON.stringify(
          {
            format: BACKUP_FORMAT,
            createdAt: new Date().toISOString(),
            database: db.databaseName,
            skipped: [...SKIP_COLLECTIONS],
            counts,
            entries: tar.entries,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    );

    await tar.finish();
    gzip.end();
    await done;
  } catch (error) {
    gzip.destroy();
    await fsp.rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  const { size } = await fsp.stat(target);
  return { file: target, bytes: size, ...counts };
}

/** Reads an archive's manifest without restoring anything. */
export async function readManifest(file) {
  const source = fs.createReadStream(file).pipe(zlib.createGunzip());
  for await (const entry of readTar(source)) {
    if (entry.name === 'manifest.json') return JSON.parse(entry.bytes.toString('utf8'));
  }
  throw new Error('That file has no manifest — it is not a backup written by this application.');
}

/**
 * Puts a backup back.
 *
 * @param {string} file
 * @param {object} [options]
 * @param {boolean} [options.force] replace a database that already has data in it
 * @param {boolean} [options.dryRun] read and check the archive, write nothing
 * @param {(line: string) => void} [options.onProgress]
 */
export async function restoreBackup(file, { force = false, dryRun = false, onProgress = () => {} } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected to a database.');

  const manifest = await readManifest(file);
  if (manifest.format > BACKUP_FORMAT) {
    throw new Error(
      `That backup was written by a newer version of this application (format ${manifest.format}, this one reads ${BACKUP_FORMAT}). Upgrade before restoring.`
    );
  }
  const digests = new Map((manifest.entries ?? []).map((entry) => [entry.name, entry.sha256]));

  /*
   * A restore into a database that already holds work is how somebody loses a week. The check is on
   * *content* rather than on the collections existing, because a booted instance has created its
   * settings document and its indexes without anybody having done anything yet.
   */
  const existing = await db.collection('audits').countDocuments().catch(() => 0);
  if (existing > 0 && !force && !dryRun) {
    throw new Error(
      `This database already holds ${existing} engagement(s). Restoring would replace them. Pass --force if that is what you mean.`
    );
  }

  const counts = { collections: 0, documents: 0, media: 0, templates: 0, checked: 0 };
  const bucketOf = () => bucket();
  /**
   * The evidence catalogue, read before the evidence.
   *
   * GridFS writes its own `files` row as each object is uploaded, so the archived one is not
   * inserted — but everything on it except the chunk bookkeeping still matters: the filename the
   * download route puts in a Content-Disposition, the content type, and the sha256 in the metadata
   * that makes a screenshot content-addressed in the first place. Uploading without them restores
   * the picture and loses what the app knows about it.
   *
   * The archive is written with the catalogue ahead of the files it describes, which is what makes
   * one pass enough. An entry that arrives without its row is still restored, just plainly.
   */
  const catalogue = new Map();

  const source = fs.createReadStream(file).pipe(zlib.createGunzip());
  for await (const entry of readTar(source)) {
    /* Every entry is checked against the manifest, whether or not it is being written. */
    const expected = digests.get(entry.name);
    if (expected) {
      const actual = crypto.createHash('sha256').update(entry.bytes).digest('hex');
      if (actual !== expected) {
        throw new Error(`"${entry.name}" in this backup is damaged: its contents do not match the manifest.`);
      }
      counts.checked += 1;
    }

    if (dryRun) continue;

    if (entry.name.startsWith('db/') && entry.name.endsWith('.jsonl')) {
      const name = entry.name.slice(3, -6);
      const documents = entry.bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => EJSON.parse(line, { relaxed: false }));

      await db.collection(name).deleteMany({});
      for (let at = 0; at < documents.length; at += DUMP_BATCH) {
        const slice = documents.slice(at, at + DUMP_BATCH);
        if (slice.length) await db.collection(name).insertMany(slice, { ordered: false });
      }
      counts.collections += 1;
      counts.documents += documents.length;
      onProgress(`  ${name}: ${documents.length} document${documents.length === 1 ? '' : 's'}`);
      continue;
    }

    if (entry.name === 'media/index.jsonl') {
      /*
       * Kept, not inserted. GridFS writes its own `files` entry as each object is uploaded below,
       * and inserting both would leave two rows describing one object — one of them with chunk
       * bookkeeping that does not match.
       */
      for (const line of entry.bytes.toString('utf8').split('\n').filter(Boolean)) {
        const row = EJSON.parse(line, { relaxed: false });
        catalogue.set(String(row._id), row);
      }
      await bucketOf()
        .drop()
        .catch(() => {});
      continue;
    }

    if (entry.name.startsWith('media/')) {
      const id = entry.name.slice(6);
      const row = catalogue.get(id);
      /*
       * With the id it had. A finding's HTML points at `/api/media/<id>`, so a screenshot restored
       * under a fresh id is a report full of broken pictures — and nothing would say so until
       * somebody opened one.
       */
      await pipeline(
        Readable.from([entry.bytes]),
        bucketOf().openUploadStreamWithId(EJSON.parse(`{"$oid":"${id}"}`), row?.filename ?? id, {
          ...(row?.metadata ? { metadata: row.metadata } : {}),
          ...(row?.contentType ? { contentType: row.contentType } : {}),
          ...(row?.chunkSizeBytes ? { chunkSizeBytes: row.chunkSizeBytes } : {}),
        })
      );
      counts.media += 1;
      continue;
    }

    if (entry.name.startsWith('templates/')) {
      const name = entry.name.slice(10);
      await fsp.mkdir(env.storage.templates, { recursive: true });
      await fsp.writeFile(path.join(env.storage.templates, name), entry.bytes);
      counts.templates += 1;
      continue;
    }
  }

  if (!dryRun) {
    /*
     * The indexes are the models' business, not the archive's — a backup carries data, and the
     * shape of the collections belongs to whichever version of the app is reading it. Without this
     * a restored instance runs without any of them, which is slow in a way nobody can attribute.
     */
    onProgress('  rebuilding indexes from the models…');
    for (const model of Object.values(mongoose.models)) {
      await model.syncIndexes().catch((error) => {
        log.warn(`Could not sync indexes on ${model.modelName}: ${error.message}`);
      });
    }
  }

  return { manifest, ...counts };
}

export default writeBackup;
