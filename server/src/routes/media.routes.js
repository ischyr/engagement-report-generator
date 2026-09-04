/**
 * Evidence upload and delivery.
 *
 * Images are stored in GridFS rather than inside the engagement document — see
 * `media.service.js` for why — and referenced from editor HTML as
 * `/api/media/<id>`.
 *
 * Mounted *before* the global `requireAuth` gate, because the GET route needs its
 * own authentication: an `<img>` tag cannot send an Authorization header, so it
 * accepts the media cookie as well as a bearer token.
 */

import { Router } from 'express';
import multer from 'multer';

import {
  ALLOWED_IMAGE_TYPES,
  MAX_MEDIA_BYTES,
  auditEvidenceBin,
  deleteMedia,
  mediaInfo,
  mediaMetadata,
  mediaStream,
  mediaUsage,
  saveMedia,
  setMediaCaption,
} from '../services/media.service.js';
import { requireAuth, requireMediaAuth, requireWrite } from '../middleware/auth.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { Audit } from '../models/audit.model.js';
import { assertMayOpen } from '../services/classification.service.js';
import { log } from '../utils/logger.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(badRequest(`${file.mimetype || 'That file'} is not an image we can store`));
    }
    return cb(null, true);
  },
}).single('file');

/** Stores a pasted or dropped screenshot and returns the URL to reference it by. */
router.post(
  '/',
  requireAuth,
  requireWrite,
  upload,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file was uploaded');

    const result = await saveMedia({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      filename: req.file.originalname,
      uploader: req.user,
      audit: req.body?.audit,
    });

    res.status(201).json(result);
  })
);

/** How much evidence is stored, for the storage readout on the Data page. */
router.get(
  '/usage',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await mediaUsage());
  })
);

/**
 * Loads an engagement and refuses if this person may not see it.
 *
 * Evidence follows the engagement it was captured for: a screenshot of a client's admin panel is
 * exactly as restricted as the finding it is destined for, and the bin must not be the way around
 * a restriction the findings enforce.
 */
async function assertMayUseBin(auditId, user) {
  const audit = await Audit.findById(auditId).select('creator collaborators reviewers classification classifiedBy deletedAt');
  if (!audit) throw notFound('Engagement not found');
  assertMayOpen(audit, user);
  return audit;
}

/**
 * What has been captured for this engagement and not used yet.
 *
 * Ordered newest first, because the thing you are looking for is nearly always the thing you just
 * took a picture of.
 */
router.get(
  '/bin/:auditId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertMayUseBin(req.params.auditId, req.user);
    res.json({ items: await auditEvidenceBin(req.params.auditId) });
  })
);

/** What a piece of evidence shows, so the bin is not a wall of identical thumbnails. */
router.patch(
  '/:id/caption',
  requireAuth,
  requireWrite,
  asyncHandler(async (req, res) => {
    const meta = await mediaMetadata(req.params.id);
    if (!meta.audit) throw badRequest('That image is not attached to an engagement');
    await assertMayUseBin(meta.audit, req.user);
    res.json({ caption: await setMediaCaption(req.params.id, req.body?.caption) });
  })
);

/**
 * Throws away a capture nobody needs.
 *
 * Only while it is still in the bin: once an image is referenced somewhere, deleting it would leave
 * a hole in a finding, and the periodic orphan sweep is the right way to reclaim anything that
 * later stops being used.
 */
router.delete(
  '/:id',
  requireAuth,
  requireWrite,
  asyncHandler(async (req, res) => {
    const meta = await mediaMetadata(req.params.id);
    if (!meta.audit) throw badRequest('That image is not attached to an engagement');
    await assertMayUseBin(meta.audit, req.user);

    const bin = await auditEvidenceBin(meta.audit);
    if (!bin.some((item) => item.id === req.params.id)) {
      throw badRequest('That image is used in the report — remove it there first');
    }
    await deleteMedia(req.params.id);
    res.json({ ok: true });
  })
);

/**
 * Serves one image.
 *
 * Streamed, so a 30 MB screenshot is never held in memory here, and cached hard:
 * ids are content-addressed, so a given id always returns the same bytes. Private,
 * because this is client evidence and must not sit in a shared proxy.
 */
router.get(
  '/:id',
  requireMediaAuth,
  asyncHandler(async (req, res) => {
    const file = await mediaInfo(req.params.id);
    const etag = `"${file.metadata?.sha256 ?? file._id}"`;

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', file.metadata?.contentType ?? file.contentType ?? 'image/png');
    res.setHeader('Content-Length', file.length);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Evidence is displayed, never executed — an uploaded SVG must not run script.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');

    const stream = mediaStream(req.params.id);
    stream.on('error', (error) => {
      log.warn(`Streaming image ${req.params.id} failed: ${error.message}`);
      if (!res.headersSent) res.status(404).json({ error: 'No such image' });
      else res.destroy();
    });
    stream.pipe(res);
  })
);

export default router;
