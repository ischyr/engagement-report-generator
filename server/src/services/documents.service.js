/**
 * Storing the files a client sends us.
 *
 * A separate GridFS bucket from evidence, and separate rules, because these are not the same kind
 * of thing. Evidence is ours, it is always an image, and it gets rendered into a report. A client
 * document is arbitrary bytes somebody emailed us — a signed PDF, a spreadsheet, occasionally a
 * zip — and it never gets rendered anywhere.
 *
 * That difference is the whole security argument here. Evidence can be served inline because it is
 * known to be an image. A document must never be: a file the client named `scope.html`, served
 * back from this origin with the type they claimed, is stored cross-site scripting dressed as
 * paperwork. So the download route decides the type, always says `attachment`, and tells the
 * browser not to sniff.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';

import { badRequest, notFound } from '../utils/http-error.js';
import { log } from '../utils/logger.js';

export const DOCUMENT_BUCKET = 'documents';

/**
 * Per-file ceiling.
 *
 * Larger than evidence, because a client's asset spreadsheet or a scanned contract legitimately
 * is: 64 MB is generous enough that nobody has to zip a PDF, and small enough that one careless
 * upload cannot fill a disk.
 */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

let bucket = null;

/** The bucket, created lazily so importing this module never needs a live DB. */
export function documentBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    if (!mongoose.connection.db) throw new Error('Database is not connected');
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: DOCUMENT_BUCKET });
  }
  return bucket;
}

/**
 * The name a download arrives under.
 *
 * Stripped of directories and of anything that could steer a path, because the value came from a
 * client's mail client and ends up in a `Content-Disposition` header and then on somebody's disk.
 */
export function safeFilename(name) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .trim();
  /*
   * Control characters and header punctuation go, spaces stay — a document is allowed to be
   * called "Scope v2 signed.pdf". A quote or a semicolon would end the filename in a
   * `Content-Disposition` header and begin a new directive.
   *
   * A codepoint test rather than a regular expression, because every way of writing "control
   * characters" as a character class got normalised into a literal range that also ate spaces.
   */
  // Backslashes are already gone: the split above takes the last path segment.
  const DENY = new Set(['"', "'", ';']);
  const cleaned = Array.from(base)
    .filter((character) => {
      const code = character.codePointAt(0);
      // Control characters and DEL: never in a real filename, always trouble in a header.
      if (code < 0x20 || code === 0x7f) return false;
      return !DENY.has(character);
    })
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned || 'document';
}

/**
 * Content types we are willing to hand back as themselves.
 *
 * Everything else is served as a binary stream. The test is not "is this file dangerous" — it is
 * "would a browser render this if we named it", and only types that render as inert content or
 * not at all are on the list. Notably absent: `text/html`, `image/svg+xml`, anything XML.
 */
const SERVEABLE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** What to send in `Content-Type`, which is our decision rather than the uploader's. */
export const serveableType = (declared) =>
  SERVEABLE_TYPES.has(String(declared ?? '').toLowerCase())
    ? String(declared).toLowerCase()
    : 'application/octet-stream';

/**
 * Writes a file and hands back what the metadata record needs.
 *
 * Not content-addressed, unlike evidence. Two clients sending the identical blank template are
 * two documents with two histories, and deduplicating them would mean deleting one engagement's
 * paperwork removed another's.
 */
/**
 * @param {object}  args
 * @param {Buffer}  args.buffer
 * @param {string}  args.filename
 * @param {string}  [args.contentType]  what the uploader claimed; never what we serve back
 * @param {*}       [args.auditId]      the engagement it belongs to, if it is one
 * @param {*}       [args.proposalId]   the proposal it belongs to, if it is one
 * @param {*}       [args.uploadedBy]
 *
 * Proposal paperwork shares this bucket with a client's engagement documents rather than
 * getting one of its own, and that is deliberate: they are the same kind of thing under the
 * same rule — arbitrary bytes that must never be served inline. One bucket means one set of
 * security decisions to keep right, where two means two that can drift apart.
 */
export async function storeDocument({
  buffer,
  filename,
  contentType,
  auditId,
  proposalId,
  uploadedBy,
}) {
  if (!buffer?.length) throw badRequest('That file is empty');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw badRequest(
      `Documents are limited to ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB each`
    );
  }

  const name = safeFilename(filename);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const stream = documentBucket().openUploadStream(name, {
    metadata: {
      // Whichever it belongs to. Only one is ever set; the other is absent rather than null,
      // so a query for one owner cannot match a file belonging to the other.
      ...(auditId ? { audit: auditId } : {}),
      ...(proposalId ? { proposal: proposalId } : {}),
      uploadedBy: uploadedBy ?? null,
      declaredType: contentType ?? '',
      sha256,
    },
  });

  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(buffer);
  });

  return { file: stream.id, bytes: buffer.length, sha256, filename: name };
}

/** The bytes back, as a stream. Throws rather than returning an empty response. */
export async function openDocument(fileId) {
  const files = await mongoose.connection.db
    .collection(`${DOCUMENT_BUCKET}.files`)
    .findOne({ _id: fileId });
  if (!files) throw notFound('That file is no longer in storage');
  return documentBucket().openDownloadStream(fileId);
}

/** Removes the bytes. Best-effort: a metadata row without its file is worse than an orphan. */
export async function deleteDocumentFile(fileId) {
  try {
    await documentBucket().delete(fileId);
    return true;
  } catch (error) {
    log.warn(`Could not delete document file ${fileId}: ${error.message}`);
    return false;
  }
}

export default storeDocument;
