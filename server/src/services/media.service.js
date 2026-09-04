/**
 * Evidence storage.
 *
 * Screenshots used to be pasted into rich text as `data:` URIs, which put the
 * bytes inside the engagement document itself. That works until it doesn't:
 * MongoDB caps a single document at 16 MB, base64 inflates by a third, and every
 * finding, note and section of an engagement lives in that one document. Four
 * screenshots at the editor's 4 MB limit and the save fails outright — mid
 * engagement, with the evidence already pasted in and nowhere to put it.
 *
 * Images now go to GridFS, which chunks them across a separate collection, and
 * the HTML keeps only a `/api/media/<id>` reference. The engagement document
 * holds text, so it stays kilobytes whatever the evidence weighs, and total
 * evidence per engagement is bounded by disk rather than by 16 MB.
 *
 * Content-addressed: the same screenshot pasted into five findings is stored once.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';

import { badRequest, notFound } from '../utils/http-error.js';
import { log } from '../utils/logger.js';

export const MEDIA_BUCKET = 'media';

/** What the editor may upload. Anything else is not evidence, it is a payload. */
export const ALLOWED_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/**
 * Per-file ceiling. Generous — a 4K screenshot is a few megabytes — and no longer
 * doing double duty as a per-engagement limit, which is the point of all this.
 */
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

let bucket = null;

/** The bucket, created lazily so importing this module never needs a live DB. */
export function mediaBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    if (!mongoose.connection.db) throw new Error('Database is not connected');
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: MEDIA_BUCKET });
  }
  return bucket;
}

const filesCollection = () => mongoose.connection.db.collection(`${MEDIA_BUCKET}.files`);

/* -------------------------------------------------------------------------- */
/* References inside HTML                                                     */
/* -------------------------------------------------------------------------- */

/** How a stored image is referenced from editor HTML. */
export const mediaUrl = (id) => `/api/media/${id}`;

/**
 * Matches our own references only — an absolute URL to somebody else's
 * `/api/media/…` must not be treated as local.
 */
const MEDIA_REF = /(?:^|["'\s(])\/api\/media\/([0-9a-f]{24})/gi;

/** Every media id referenced by a chunk of HTML, deduplicated. */
export function mediaIdsInHtml(html) {
  const ids = new Set();
  if (typeof html !== 'string') return ids;
  for (const match of html.matchAll(MEDIA_REF)) ids.add(match[1].toLowerCase());
  return ids;
}

/**
 * Rich text with every image taken out, and how many were removed.
 *
 * Evidence belongs to the engagement it was captured on. When a write-up is lifted out of
 * one — into the library, or into a duplicate for the next job — its screenshots must not
 * come along: they are one client's data, and a library entry carrying them would put an
 * Acme screenshot into Northwind's report. Data URIs go too; a pasted screenshot is still a
 * screenshot.
 *
 * The surrounding `<figure>`/`<figcaption>` is left alone deliberately: an empty caption is
 * a visible reminder that a screenshot needs retaking, which is better than silently
 * tidying away the fact that there was one.
 */
export function stripImages(html) {
  if (typeof html !== 'string') return { html: '', removed: 0 };
  let removed = 0;
  const cleaned = html.replace(/<img[\s>][^>]*>|<img\/?>/gi, () => {
    removed += 1;
    return '';
  });
  return { html: cleaned, removed };
}

/**
 * Points every reference to one stored image at another one, across a whole engagement.
 *
 * Deliberately a *rewrite* rather than replacing the bytes behind the id. Stored images are
 * deduplicated by SHA-256 — the same screenshot pasted into two engagements is one object —
 * so overwriting the file would change another client's report, quietly, from inside an
 * engagement that has nothing to do with it. Repointing this engagement's references cannot
 * do that, and it leaves the old file to be collected once nothing needs it.
 *
 * Every field is walked, so one retaken screenshot lands everywhere it appeared: findings,
 * narrative sections and notes alike. Captions and alt text are attributes of the reference,
 * not the file, so they survive untouched.
 *
 * @returns {number} how many references changed
 */
export function repointMedia(audit, fromId, toId) {
  const from = String(fromId ?? '').toLowerCase();
  if (!from || !mongoose.isValidObjectId(from)) return 0;
  let changed = 0;

  // Matches the id anywhere a src can hold it, without touching a neighbouring id that
  // merely starts with the same characters.
  const pattern = new RegExp(`/api/media/${from}(?![0-9a-f])`, 'gi');
  const swap = (html) => {
    if (typeof html !== 'string' || !html) return html;
    return html.replace(pattern, () => {
      changed += 1;
      return `/api/media/${toId}`;
    });
  };

  for (const finding of audit.findings ?? []) {
    for (const field of ['description', 'observation', 'remediation', 'poc', 'scope']) {
      finding[field] = swap(finding[field]);
    }
  }
  for (const section of audit.sections ?? []) section.text = swap(section.text);
  for (const note of audit.notes ?? []) note.content = swap(note.content);
  for (const field of audit.customFields ?? []) {
    if (typeof field.value === 'string') field.value = swap(field.value);
  }

  return changed;
}

/** Every media id referenced anywhere in an engagement. */
export function mediaIdsInAudit(audit, { enumerationHtml = [] } = {}) {
  const ids = new Set();
  const scan = (html) => {
    for (const id of mediaIdsInHtml(html)) ids.add(id);
  };

  /*
   * Enumeration write-ups, handed in rather than read off the audit.
   *
   * They live in `EnumerationBody`, one document per step, because a step's text would otherwise
   * push the engagement document at MongoDB's 16MB ceiling. That put them out of reach of this
   * function, and being out of reach here has two consequences, both bad: a screenshot pasted into
   * a step never reached the report, and `collectOrphanMedia` counted it as referenced by nothing.
   *
   * A caller that has the bodies passes their HTML. A caller that does not gets the old answer,
   * which is why every caller that can reach them now does.
   */
  for (const html of enumerationHtml) scan(html);

  for (const finding of audit?.findings ?? []) {
    scan(finding.description);
    scan(finding.observation);
    scan(finding.remediation);
    scan(finding.poc);
    scan(finding.scope);
    for (const field of finding.customFields ?? []) scan(field.value);
  }
  for (const section of audit?.sections ?? []) {
    scan(section.text);
    for (const field of section.customFields ?? []) scan(field.value);
  }
  for (const note of audit?.notes ?? []) scan(note.content);
  for (const field of audit?.customFields ?? []) scan(field.value);

  return ids;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the bytes actually are, from their magic number.
 *
 * The declared content type is whatever the client chose to send, so it cannot be
 * trusted to decide what gets stored: without this, any payload uploads happily as
 * `image/png` and is then served back under an image content type.
 *
 * @returns {string|null} the sniffed extension, or null if it is not an image
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  // SVG is text, so there is no magic number — look for the root element near the
  // start, past any XML declaration, comment or byte-order mark.
  const head = buffer.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|﻿)*<svg[\s>]/i.test(head)) return 'svg';

  return null;
}

/** Reads the pixel dimensions out of the header bytes, where we know the format. */
function readDimensions(buffer, ext) {
  try {
    if (ext === 'png' && buffer.length > 24 && buffer.readUInt32BE(12) === 0x49484452) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (ext === 'gif' && buffer.length > 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (ext === 'jpg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    /* a truncated or unusual header is not worth failing an upload over */
  }
  return { width: null, height: null };
}

/**
 * Stores one image, reusing an identical upload if it is already there.
 *
 * @param {{buffer: Buffer, contentType: string, filename?: string,
 *   uploader?: any, audit?: any}} input
 * @returns {Promise<{id: string, url: string, bytes: number, width: number|null,
 *   height: number|null, contentType: string, deduplicated: boolean}>}
 */
export async function saveMedia({ buffer, contentType, filename, uploader, audit }) {
  const declared = ALLOWED_IMAGE_TYPES[contentType];
  if (!declared) throw badRequest(`${contentType || 'That file type'} is not an image we can store`);
  if (!buffer?.length) throw badRequest('That file is empty');
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw badRequest(`Images are limited to ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB each`);
  }

  // The content decides, not the header the client sent. A shell script announced
  // as image/png is not evidence, and would be served back with an image type.
  const sniffed = sniffImageType(buffer);
  if (!sniffed) throw badRequest('That file is not an image we recognise');

  // A jpg announced as png is a harmless mix-up; store it as what it is.
  const ext = sniffed;
  const resolvedType =
    Object.entries(ALLOWED_IMAGE_TYPES).find(([, value]) => value === ext)?.[0] ?? contentType;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // The same screenshot in several findings is one stored object.
  const existing = await filesCollection().findOne({ 'metadata.sha256': sha256 });
  if (existing) {
    return {
      id: existing._id.toString(),
      url: mediaUrl(existing._id.toString()),
      bytes: existing.length,
      width: existing.metadata?.width ?? null,
      height: existing.metadata?.height ?? null,
      contentType: existing.metadata?.contentType ?? resolvedType,
      deduplicated: true,
    };
  }

  const { width, height } = readDimensions(buffer, ext);
  const safeName = String(filename ?? `evidence.${ext}`)
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 120);

  const id = await new Promise((resolve, reject) => {
    const stream = mediaBucket().openUploadStream(safeName, {
      contentType: resolvedType,
      metadata: {
        contentType: resolvedType,
        sha256,
        width,
        height,
        ext,
        uploader: uploader?._id ?? uploader ?? null,
        /*
         * As an ObjectId whenever it is one. The route hands over `req.body.audit`, which is a
         * string, and a string never matches a query built from an id — the evidence bin came back
         * empty for uploads that were sitting right there. Older rows hold both shapes, which is
         * why the read still matches either.
         */
        audit: asObjectId(audit?._id ?? audit) ?? null,
      },
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });

  return {
    id: id.toString(),
    url: mediaUrl(id.toString()),
    bytes: buffer.length,
    width,
    height,
    contentType: resolvedType,
    deduplicated: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const toObjectId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('No such image');
  return new mongoose.Types.ObjectId(String(id));
};

/** The same coercion, for metadata that is allowed to be absent. */
const asObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;
};

/** Metadata only, for conditional responses. */
/**
 * What a set of images weighs, and which of them are bigger than a page can print.
 *
 * The report embeds screenshots at their stored size, so this *is* the size of the deliverable to
 * within the text around it — and the deliverable now goes out by email, where 25 MB is the common
 * ceiling. Answered from the stored metadata rather than by reading any bytes: `saveMedia` already
 * recorded the dimensions and the length when the file arrived.
 *
 * @param {string[]} ids
 * @param {{printableWidth?: number}} [options] the widest a picture can usefully be, in pixels
 */
export async function mediaWeight(ids, { printableWidth = 1600 } = {}) {
  const list = [...new Set((ids ?? []).map(String).filter(Boolean))];
  if (!list.length) return { count: 0, bytes: 0, oversized: [], largest: null };

  const rows = await filesCollection()
    .find({ _id: { $in: list.map((id) => toObjectId(id)).filter(Boolean) } })
    .project({ length: 1, filename: 1, 'metadata.width': 1, 'metadata.height': 1 })
    .toArray();

  let bytes = 0;
  const oversized = [];
  let largest = null;
  for (const row of rows) {
    const width = row.metadata?.width ?? null;
    const entry = {
      id: String(row._id),
      filename: row.filename ?? '',
      bytes: row.length ?? 0,
      width,
      height: row.metadata?.height ?? null,
    };
    bytes += entry.bytes;
    if (!largest || entry.bytes > largest.bytes) largest = entry;
    /*
     * Wider than the column, *and* heavy with it. A 4000-pixel-wide screenshot that somehow
     * weighs 80 KB is nobody's problem, and naming it would train people to ignore the list.
     */
    if (width && width > printableWidth * 1.25 && entry.bytes > 400 * 1024) oversized.push(entry);
  }

  oversized.sort((a, b) => b.bytes - a.bytes);
  return { count: rows.length, bytes, oversized, largest };
}

export async function mediaInfo(id) {
  const file = await filesCollection().findOne({ _id: toObjectId(id) });
  if (!file) throw notFound('No such image');
  return file;
}

/** A read stream, for serving. Never buffers the whole image in the API process. */
export function mediaStream(id) {
  return mediaBucket().openDownloadStream(toObjectId(id));
}

/**
 * The whole image as a Buffer.
 *
 * Only for report generation, which has to embed the bytes. Serving uses
 * `mediaStream` so a 30 MB screenshot is not held in memory per request.
 */
/* -------------------------------------------------------------------------- */
/* The bytes, kept for a moment                                               */
/* -------------------------------------------------------------------------- */

/**
 * Evidence, cached in memory between renders.
 *
 * A thirty-screenshot report pulled all thirty out of GridFS every time it was generated — and the
 * per-finding preview pulled the same handful again on every keystroke-triggered render. The bytes
 * are the slow part of a render that is otherwise string work.
 *
 * Safe to cache by id because media is **content-addressed**: `saveMedia` hashes every upload and
 * returns the existing object when the hash matches, so one id always means one sequence of bytes.
 * Replacing a screenshot creates a *new* id and repoints the HTML at it — see `repointMedia` — so
 * there is no version of this where an id's contents change under the cache.
 *
 * Bounded by total bytes rather than by entry count, because the whole risk here is a report full
 * of 4 MB screenshots. Least-recently-used goes first, which for a team working through one
 * engagement at a time is the right thing to keep.
 */
const MEDIA_CACHE_BYTES = Number(process.env.MEDIA_CACHE_BYTES ?? 96 * 1024 * 1024);

/** Insertion order is the LRU order: a hit deletes and re-sets to move the entry to the end. */
const mediaCache = new Map();
let mediaCacheBytes = 0;
const mediaCacheStats = { hits: 0, misses: 0, evictions: 0 };

function cacheGet(id) {
  const entry = mediaCache.get(id);
  if (!entry) {
    mediaCacheStats.misses += 1;
    return null;
  }
  mediaCache.delete(id);
  mediaCache.set(id, entry);
  mediaCacheStats.hits += 1;
  return entry;
}

function cacheSet(id, entry) {
  const size = entry?.buffer?.length ?? 0;
  /*
   * An image bigger than the whole budget is not cached at all rather than evicting everything to
   * make room for something that will be evicted next.
   */
  if (!size || size > MEDIA_CACHE_BYTES / 2) return entry;
  if (mediaCache.has(id)) mediaCacheBytes -= mediaCache.get(id).buffer.length;
  mediaCache.set(id, entry);
  mediaCacheBytes += size;

  while (mediaCacheBytes > MEDIA_CACHE_BYTES && mediaCache.size > 1) {
    const [oldest] = mediaCache.keys();
    mediaCacheBytes -= mediaCache.get(oldest).buffer.length;
    mediaCache.delete(oldest);
    mediaCacheStats.evictions += 1;
  }
  return entry;
}

/**
 * Forgets one image, or all of them.
 *
 * Called when media is deleted, so a purge does not leave bytes alive in memory. Not needed for
 * correctness of a render — the ids are content-addressed — but holding a deleted client's
 * screenshot in memory after it was purged is not a thing this app should do.
 */
export function forgetMedia(id = null) {
  if (id === null) {
    mediaCache.clear();
    mediaCacheBytes = 0;
    return;
  }
  const entry = mediaCache.get(String(id));
  if (!entry) return;
  mediaCacheBytes -= entry.buffer.length;
  mediaCache.delete(String(id));
}

/** For the smoke test and anybody wondering whether the cache is doing anything. */
export const mediaCacheReport = () => ({
  entries: mediaCache.size,
  bytes: mediaCacheBytes,
  limit: MEDIA_CACHE_BYTES,
  ...mediaCacheStats,
});

export async function loadMediaBuffer(id) {
  const chunks = [];
  for await (const chunk of mediaStream(id)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Loads every image an engagement references, keyed by id.
 *
 * Report rendering is synchronous once it starts — docxtemplater walks the tree
 * and calls the HTML converter inline — so the bytes have to be in hand before
 * the first tag is resolved. Missing ids resolve to null rather than throwing: a
 * report with one broken image beats no report at all.
 *
 * @param {Iterable<string>} ids
 * @returns {Promise<Map<string, {buffer: Buffer, contentType: string, ext: string,
 *   width: number|null, height: number|null}>>}
 */
export async function loadMediaMap(ids) {
  const map = new Map();
  const unique = [...new Set([...ids])];
  if (unique.length === 0) return map;

  const files = await filesCollection()
    .find({ _id: { $in: unique.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) } })
    .toArray();
  const byId = new Map(files.map((file) => [file._id.toString(), file]));

  await Promise.all(
    unique.map(async (id) => {
      const file = byId.get(id);
      if (!file) {
        log.warn(`Report references image ${id}, which is not in storage`);
        map.set(id, null);
        return;
      }
      try {
        /*
         * The cache is only consulted for the *bytes*. The metadata comes from the query above
         * either way, which costs one round trip for the whole set and keeps a renamed or
         * re-measured file honest.
         */
        const cached = cacheGet(id);
        const buffer = cached?.buffer ?? (await loadMediaBuffer(id));
        if (!cached) cacheSet(id, { buffer });
        map.set(id, {
          buffer,
          contentType: file.metadata?.contentType ?? file.contentType ?? 'image/png',
          ext: file.metadata?.ext ?? 'png',
          width: file.metadata?.width ?? null,
          height: file.metadata?.height ?? null,
        });
      } catch (error) {
        log.warn(`Could not read image ${id}: ${error.message}`);
        map.set(id, null);
      }
    })
  );

  return map;
}

/**
 * Rewrites `/api/media/<id>` references into `data:` URIs.
 *
 * For the HTML report only, and deliberately: that output is a deliverable. A
 * client opens it from an email, or prints it to PDF, with no session and no
 * server — so the bytes have to travel with it. The 16 MB limit that drove images
 * out of the engagement document does not apply to an HTTP response.
 *
 * @param {string} html rendered report HTML
 * @param {Map<string, {buffer: Buffer, contentType: string}|null>} media
 */
export function inlineMediaInHtml(html, media) {
  if (typeof html !== 'string' || !media?.size) return html;

  return html.replace(/\/api\/media\/([0-9a-f]{24})/gi, (whole, id) => {
    const entry = media.get(id.toLowerCase());
    if (!entry) return whole;
    return `data:${entry.contentType};base64,${entry.buffer.toString('base64')}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/** Total bytes stored, for the storage readout. */
export async function mediaUsage() {
  const [summary] = await filesCollection()
    .aggregate([{ $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: '$length' } } }])
    .toArray();
  return { files: summary?.files ?? 0, bytes: summary?.bytes ?? 0 };
}

export async function deleteMedia(id) {
  try {
    await mediaBucket().delete(toObjectId(id));
    /* Out of memory as well as out of storage: a purged client's screenshot must not outlive it. */
    forgetMedia(id);
    return true;
  } catch {
    // Already gone is the desired end state either way.
    return false;
  }
}

/**
 * Deletes stored images that nothing references any more.
 *
 * Deliberately *not* called when a finding is deleted: the same image may be
 * referenced from another finding, an undo may be seconds away, and an engagement
 * in the trash still needs its evidence if it is restored. Orphans are cheap to
 * keep and expensive to lose, so collecting them is a periodic sweep with a grace
 * period rather than a live cascade.
 *
 * @param {{graceMs?: number, dryRun?: boolean}} [options]
 */
/**
 * The evidence bin: everything uploaded against one engagement that nothing references yet.
 *
 * Testing and writing up are not the same activity and rarely happen in the same hour. Evidence
 * could only ever be attached to a finding that already existed, so a tester with a screenshot and
 * no write-up had two options: invent an empty finding to park it in, or keep it on the desktop and
 * hope to remember. The second is what people did, which is how evidence goes missing.
 *
 * So an upload can belong to the engagement rather than to a finding, and this is what is sitting
 * there waiting to be used. "Unreferenced" is computed rather than stored — a flag would have to be
 * cleared by whoever inserts the image, from any of the five rich fields, the sections, the notes
 * and the custom fields, and the first place that forgot would strand it here forever.
 *
 * @param {string} auditId
 * @returns {Promise<Array<{id: string, url: string, filename: string, bytes: number, width: number|null, height: number|null, caption: string, uploadedAt: Date, uploader: string|null}>>}
 */
export async function auditEvidenceBin(auditId) {
  const { Audit } = await import('../models/audit.model.js');

  const audit = await Audit.findById(auditId)
    .select('findings sections notes customFields')
    .lean();
  /* A screenshot in a step's write-up is in use, and must not be offered as spare. */
  const { EnumerationBody } = await import('../models/enumeration-body.model.js');
  const bodies = await EnumerationBody.find({ audit: auditId }).select('content').lean();
  const used = new Set(
    audit ? mediaIdsInAudit(audit, { enumerationHtml: bodies.map((b) => b.content) }) : []
  );

  // Either shape: uploads made before this was normalised stored the id as a string.
  const files = await filesCollection()
    .find({ 'metadata.audit': { $in: [toObjectId(auditId), String(auditId)] } })
    .sort({ uploadDate: -1 })
    .toArray();

  return files
    .filter((file) => !used.has(file._id.toString()))
    .map((file) => ({
      id: file._id.toString(),
      url: mediaUrl(file._id.toString()),
      filename: file.filename ?? '',
      bytes: file.length ?? 0,
      width: file.metadata?.width ?? null,
      height: file.metadata?.height ?? null,
      /** What it shows, written when it was captured rather than reconstructed later. */
      caption: file.metadata?.caption ?? '',
      uploadedAt: file.uploadDate ?? null,
      uploader: file.metadata?.uploader ? String(file.metadata.uploader) : null,
    }));
}

/** Which engagement an upload was captured for, and what it is captioned. */
export async function mediaMetadata(id) {
  const file = await filesCollection().findOne({ _id: toObjectId(id) });
  if (!file) throw notFound('No such image');
  return {
    id: file._id.toString(),
    audit: file.metadata?.audit ? String(file.metadata.audit) : null,
    caption: file.metadata?.caption ?? '',
    uploader: file.metadata?.uploader ? String(file.metadata.uploader) : null,
  };
}

/** Renames what a piece of evidence shows. */
export async function setMediaCaption(id, caption) {
  const value = String(caption ?? '').slice(0, 300);
  await filesCollection().updateOne(
    { _id: toObjectId(id) },
    { $set: { 'metadata.caption': value } }
  );
  return value;
}

export async function collectOrphanMedia({ graceMs = 24 * 60 * 60 * 1000, dryRun = false } = {}) {
  const { Audit } = await import('../models/audit.model.js');
  const { Vulnerability } = await import('../models/vulnerability.model.js');

  const referenced = new Set();
  // Includes trashed engagements on purpose — restoring one must not find holes.
  for await (const audit of Audit.find().select('findings sections notes customFields').lean()) {
    for (const id of mediaIdsInAudit(audit)) referenced.add(id);
  }
  /*
   * Enumeration write-ups, which live in their own collection.
   *
   * Without this the sweep would delete every screenshot pasted into an enumeration step — files
   * that are referenced, in use, and about to be printed. Streamed and projected to content alone:
   * this walks every engagement that has ever existed.
   */
  const { EnumerationBody } = await import('../models/enumeration-body.model.js');
  for await (const body of EnumerationBody.find().select('content').lean()) {
    for (const id of mediaIdsInHtml(body.content)) referenced.add(id);
  }
  // Deleted-but-restorable findings count as references: sweeping their screenshots
  // would turn a restore into a finding with holes where the evidence used to be.
  const { DeletedFinding } = await import('../models/deleted-finding.model.js');
  for await (const row of DeletedFinding.find().select('finding').lean()) {
    for (const id of mediaIdsInAudit({ findings: [row.finding] })) referenced.add(id);
  }
  for await (const entry of Vulnerability.find().select('details').lean()) {
    for (const detail of entry.details ?? []) {
      for (const field of ['description', 'observation', 'remediation', 'poc']) {
        for (const id of mediaIdsInHtml(detail?.[field])) referenced.add(id);
      }
    }
  }

  const cutoff = new Date(Date.now() - graceMs);
  const candidates = await filesCollection()
    .find({ uploadDate: { $lte: cutoff } })
    .project({ _id: 1, length: 1, filename: 1 })
    .toArray();

  const orphans = candidates.filter((file) => !referenced.has(file._id.toString()));
  const bytes = orphans.reduce((sum, file) => sum + (file.length ?? 0), 0);

  if (!dryRun) {
    for (const orphan of orphans) await deleteMedia(orphan._id.toString());
  }

  return { referenced: referenced.size, orphans, bytes, dryRun };
}

export default saveMedia;
