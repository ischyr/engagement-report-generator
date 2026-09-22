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
  MAX_MEDIA_BYTES,
  auditEvidenceBin,
  ALLOWED_UPLOAD_TYPES,
  MAX_VIDEO_BYTES,
  unsupportedTypeMessage,
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
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { Audit } from '../models/audit.model.js';
import { assertMayOpen } from '../services/classification.service.js';
import { membershipExpired } from '../utils/audit-scope.js';
import { log } from '../utils/logger.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  /*
   * The larger of the two ceilings here, and the real one per kind in `saveMedia`.
   *
   * Multer decides before it knows what the file is, so a single limit would either refuse a
   * recording at the image ceiling or let a 64 MB "screenshot" through. The service checks the
   * one that applies, where the message can say which.
   */
  limits: { fileSize: Math.max(MAX_MEDIA_BYTES, MAX_VIDEO_BYTES), files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_TYPES[file.mimetype]) {
      /*
       * The same sentence the service would have written. Multer refuses on the declared type
       * before `saveMedia` ever sees the bytes, so without this the useful message — "export it
       * as MP4" — was one nobody could reach.
       */
      return cb(badRequest(unsupportedTypeMessage(file.mimetype)));
    }
    return cb(null, true);
  },
}).single('file');

/** Stores a pasted or dropped screenshot — or a recording — and returns the URL to reference it by. */
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
      /*
       * The still frame, for a recording: an image id uploaded a moment earlier by the same
       * browser. Passed rather than derived, because taking a frame server-side would put a video
       * decoder in the dependency list of a reporting tool.
       */
      poster: req.body?.poster,
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
  const audit = await Audit.findById(auditId).select(
    'creator collaborators reviewers classification classifiedBy deletedAt memberUntil'
  );
  if (!audit) throw notFound('Engagement not found');
  assertMayOpen(audit, user);
  /*
   * And whether they are on it at all.
   *
   * `assertMayOpen` enforces exactly one rule — a restricted engagement needs two-factor
   * authentication — and returns immediately for everything else. It was the only check here, so
   * the bin, the caption and the delete answered to any signed-in account that knew an engagement
   * id. The fields were even projected for it and never read.
   */
  assertMember(audit, user);
  return audit;
}

/**
 * Whether this person is on this engagement, and still is.
 *
 * The same rule `loadAudit` applies to everything under `/audits/:id` — creator, collaborator or
 * reviewer, and not past their end date. Written out here rather than imported from the routes
 * file, which is nine thousand lines and would drag the whole of it in for one comparison.
 */
function assertMember(audit, user) {
  if (user.role === 'admin') return;
  const uid = String(user._id);
  const allowed = [
    audit.creator?._id?.toString() ?? audit.creator?.toString(),
    ...(audit.collaborators ?? []).map((c) => c._id?.toString() ?? c.toString()),
    ...(audit.reviewers ?? []).map((r) => r._id?.toString() ?? r.toString()),
  ];
  if (!allowed.includes(uid)) throw forbidden('You do not have access to this engagement');
  if (membershipExpired(audit, user)) {
    throw forbidden('Your access to this engagement ended. Ask whoever runs it to extend it.');
  }
}

/**
 * Whether this person may read these bytes.
 *
 * **The gap this closes.** `requireMediaAuth` proves who you are and nothing else, and the route
 * below never loaded an engagement — so any signed-in account that had a media id could fetch any
 * engagement's evidence, a restricted engagement's included, with no two-factor and no membership.
 * Ids are ObjectIds rather than guessable, but they travel in report HTML and in links.
 *
 * Read against `metadata.audits`, the set of engagements these bytes belong to, because
 * deduplication means one object can legitimately be in two reports. Membership of any one of them
 * is enough, and that is sound: somebody on either engagement already has the bytes through their
 * own, so reading them through the object reveals nothing about the other.
 *
 * **A file with no engagement on it stays readable to any signed-in account.** Those are the
 * pictures the app composes rather than evidence — a logo, a signature, a chart — plus anything
 * uploaded before the engagement was recorded. Refusing them would break the branding on every
 * page to close nothing: they are not client evidence.
 */
async function assertMayReadMedia(file, user) {
  const owners = [
    ...(file.metadata?.audits ?? []),
    ...(file.metadata?.audit ? [file.metadata.audit] : []),
  ].map(String);
  if (!owners.length) return;
  if (user.role === 'admin') return;

  const audits = await Audit.find({ _id: { $in: [...new Set(owners)] } }).select(
    'creator collaborators reviewers classification classifiedBy deletedAt memberUntil'
  );
  /*
   * Any one of them is enough, and every refusal is collected rather than thrown at the first.
   * A restricted engagement in the list must not be the reason somebody is refused a picture they
   * can reach through an ordinary one they are on.
   */
  for (const audit of audits) {
    try {
      assertMayOpen(audit, user);
      assertMember(audit, user);
      return;
    } catch {
      /* Try the next engagement that holds these bytes. */
    }
  }
  throw forbidden('That evidence belongs to an engagement you are not on.');
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
    /* Before the ETag: a 304 is an answer, and must not be one this person may not have. */
    await assertMayReadMedia(file, req.user);
    const etag = `"${file.metadata?.sha256 ?? file._id}"`;

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', file.metadata?.contentType ?? file.contentType ?? 'image/png');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Evidence is displayed, never executed — an uploaded SVG must not run script.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');

    /*
     * Byte ranges, which recordings need and images never use.
     *
     * A `<video>` element asks for a range as soon as somebody drags the scrubber, and a server
     * that answers 200 with the whole file every time gives you a recording that plays from the
     * start and cannot be moved through — which for evidence of a specific moment is most of the
     * value gone. GridFS can open a stream at an offset, so this costs one header and a slice.
     */
    const total = file.length;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let start = 0;
    let end = total - 1;
    if (range) {
      const from = range[1] === '' ? null : Number(range[1]);
      const to = range[2] === '' ? null : Number(range[2]);
      /* `bytes=-500` means the last 500, which is how some players read a container's index. */
      if (from === null && to !== null) start = Math.max(0, total - to);
      else {
        start = from ?? 0;
        if (to !== null) end = Math.min(to, total - 1);
      }
      if (start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        res.status(416).end();
        return;
      }
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    if (range) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.status(206);
    }

    /* `end` is exclusive in GridFS and inclusive in an HTTP range. */
    const stream = mediaStream(req.params.id, { start, end: end + 1 });
    stream.on('error', (error) => {
      log.warn(`Streaming image ${req.params.id} failed: ${error.message}`);
      if (!res.headersSent) res.status(404).json({ error: 'No such image' });
      else res.destroy();
    });
    stream.pipe(res);
  })
);

export default router;
