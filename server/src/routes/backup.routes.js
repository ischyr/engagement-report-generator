import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { z } from 'zod';

import env from '../config/env.js';
import { Settings } from '../models/settings.model.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden } from '../utils/http-error.js';
import { log } from '../utils/logger.js';
import { MEDIA_BUCKET } from '../services/media.service.js';
import { readManifest, restoreBackup, writeBackup } from '../services/backup/index.js';
import { recordSettingsChange } from '../services/settings-audit.service.js';

/**
 * Taking a backup, and putting one back, from the Settings page.
 *
 * `npm run backup` is still the one that belongs in cron — a scheduled job should not depend on a
 * browser being open. This is the other half: the administrator who wants a copy *now*, before
 * upgrading or before letting somebody loose on the instance, and the one restoring onto a fresh
 * machine at eight in the morning with no shell to hand.
 *
 * ## Both of these need a second factor
 *
 * Not because an administrator could not already read all of it — they could, one page at a time —
 * but because of what these two do in one request. A backup is every finding, every credential
 * ciphertext and every screenshot in a single file; a restore replaces the entire instance. The
 * reasoning is already written down in `classification.service.js` for restricted engagements and
 * applies here with more force: *an account that can read every engagement in the instance is
 * exactly the one whose password should not be sufficient on its own.*
 *
 * ## Restoring is two requests, deliberately
 *
 * The archive is uploaded and **checked** first: every entry verified against the manifest, and the
 * summary — when it was taken, from which database, how much is in it — handed back for somebody to
 * read. Only a second call, quoting the database name from that summary, applies it. A single
 * button that replaces a firm's entire history on one click is not a button, it is a trap.
 */

const router = Router();

/* Everything here is an administrator's, and every route says so again below. */
router.use(requireRole('admin'));

/**
 * The bar for both operations.
 *
 * Enrolment rather than a fresh challenge, which is the same bar this codebase already sets for
 * opening a restricted engagement — consistency matters more here than a marginally stronger
 * gate nobody else in the app applies.
 */
function assertSecondFactor(user) {
  if (user?.totpEnabled) return;
  throw forbidden(
    'This needs two-factor authentication on your account. Set it up on your profile, sign in ' +
      'again, and come back — a backup is every finding and every screenshot in one file, and a ' +
      'restore replaces all of it.'
  );
}

/** Uploaded archives land on disk: an instance's whole history does not belong in memory. */
const archiveUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, next) => {
      fsp
        .mkdir(env.storage.tmp, { recursive: true })
        .then(() => next(null, env.storage.tmp))
        .catch(next);
    },
    filename: (_req, _file, next) =>
      next(null, `restore-${crypto.randomBytes(8).toString('hex')}.tar.gz`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
});

/** A staged upload's handle, which is a filename and nothing else. */
const STAGED = /^restore-[0-9a-f]{16}\.tar\.gz$/;
const stagedPath = (id) => {
  if (!STAGED.test(String(id ?? ''))) throw badRequest('That upload is not one of ours.');
  return path.join(env.storage.tmp, id);
};

/** Anything staged and forgotten. An abandoned upload is somebody's whole database on our disk. */
async function sweepStaged({ olderThanMs = 6 * 60 * 60 * 1000 } = {}) {
  const names = await fsp.readdir(env.storage.tmp).catch(() => []);
  for (const name of names) {
    if (!STAGED.test(name)) continue;
    const full = path.join(env.storage.tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > olderThanMs) {
      await fsp.rm(full, { force: true }).catch(() => {});
    }
  }
}

/**
 * What a backup would contain, and when the last one was taken.
 *
 * The counts are live rather than remembered: the useful thing on the card is *what you are about
 * to copy*, and an instance that has grown since the last backup is exactly what somebody needs to
 * see. Cheap — a count per collection, no documents read.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = mongoose.connection.db;
    const names = (await db.listCollections().toArray())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('system.'))
      .filter((name) => name !== `${MEDIA_BUCKET}.chunks`);

    let documents = 0;
    let collections = 0;
    let media = 0;
    for (const name of names) {
      const count = await db.collection(name).estimatedDocumentCount().catch(() => 0);
      if (name === `${MEDIA_BUCKET}.files`) {
        media = count;
        continue;
      }
      if (name === 'sessions') continue;
      collections += 1;
      documents += count;
    }
    const templates = (await fsp.readdir(env.storage.templates).catch(() => [])).length;

    const stored = (await Settings.getSettings()).toObject().backup ?? {};
    res.json({
      now: { documents, collections, media, templates },
      last: stored.lastAt
        ? { at: stored.lastAt, bytes: stored.bytes ?? 0, by: stored.byName ?? '', counts: stored.counts ?? null }
        : null,
      /* So the card can explain the refusal before somebody presses the button. */
      secondFactor: Boolean(req.user?.totpEnabled),
    });
  })
);

/**
 * Builds a backup and sends it.
 *
 * Written to disk first and streamed from there rather than assembled in memory: on an instance
 * with recordings in it this file is measured in gigabytes, and the whole design of the service
 * below is about never holding one.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    assertSecondFactor(req.user);
    await sweepStaged();

    /*
     * Made sure of first. `writeBackup` tells "a directory to name a file in" from "the filename to
     * use" by asking the filesystem — so on an instance that has never staged anything, a missing
     * tmp directory would be taken for a filename and the backup written *as* `storage/tmp`.
     */
    await fsp.mkdir(env.storage.tmp, { recursive: true });
    const result = await writeBackup({ out: env.storage.tmp });
    const name = path.basename(result.file);

    /*
     * Recorded before it is sent, because the interesting fact is that a backup was *made* — if the
     * download fails halfway the file still existed and the next one should not claim to be the
     * first. The Settings page shows it as "last taken".
     */
    const settings = await Settings.getSettings();
    settings.backup = {
      lastAt: new Date(),
      bytes: result.bytes,
      byName: [req.user.firstname, req.user.lastname].filter(Boolean).join(' ') || req.user.username,
      counts: {
        documents: result.documents,
        collections: result.collections,
        media: result.media,
        templates: result.templates,
      },
    };
    settings.markModified('backup');
    await settings.save();

    await recordSettingsChange({
      actor: req.user,
      before: {},
      after: { backup: { taken: true } },
      req,
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', result.bytes);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);

    const stream = fs.createReadStream(result.file);
    stream.pipe(res);
    /* Ours only for as long as it takes to send. */
    const done = () => fsp.rm(result.file, { force: true }).catch(() => {});
    stream.on('close', done);
    stream.on('error', (error) => {
      log.warn(`Sending the backup failed: ${error.message}`);
      done();
    });
  })
);

/**
 * Reads an uploaded archive, verifies it, and says what is in it. Writes nothing.
 *
 * The same work `npm run restore -- --check` does, which is the step worth doing on the day a
 * backup is taken rather than the day it is needed — so the page offers it on its own, without a
 * restore attached.
 */
router.post(
  '/inspect',
  archiveUpload.single('archive'),
  asyncHandler(async (req, res) => {
    assertSecondFactor(req.user);
    if (!req.file) throw badRequest('No archive was uploaded.');

    try {
      const manifest = await readManifest(req.file.path);
      const checked = await restoreBackup(req.file.path, { dryRun: true });
      res.json({
        /* The handle for the second call. It is a filename in our own staging directory. */
        id: path.basename(req.file.path),
        bytes: req.file.size,
        entriesChecked: checked.checked,
        manifest: {
          format: manifest.format,
          createdAt: manifest.createdAt,
          database: manifest.database,
          skipped: manifest.skipped ?? [],
          counts: manifest.counts ?? null,
        },
      });
    } catch (error) {
      /* A file that cannot be read is not kept: it is either damaged or not a backup. */
      await fsp.rm(req.file.path, { force: true }).catch(() => {});
      throw badRequest(error.message);
    }
  })
);

/**
 * Applies an archive that has already been inspected.
 *
 * `confirm` has to be the database name out of the manifest the previous call returned. Not a
 * checkbox and not the word "yes": the point is to make somebody read what they are about to
 * replace, and a phrase they have to find in the summary is the only confirmation that proves it.
 */
router.post(
  '/restore',
  validate(
    z.object({
      id: z.string().max(80),
      confirm: z.string().max(200),
    })
  ),
  asyncHandler(async (req, res) => {
    assertSecondFactor(req.user);

    const file = stagedPath(req.body.id);
    if (!fs.existsSync(file)) {
      throw badRequest('That upload is no longer here. Upload the archive again.');
    }

    const manifest = await readManifest(file);
    if (String(req.body.confirm).trim() !== String(manifest.database)) {
      throw badRequest(
        `To confirm, type the database name from the summary: "${manifest.database}".`
      );
    }

    log.warn(
      `Restore starting: ${req.user.username} is replacing this instance from a backup taken ${manifest.createdAt}`
    );

    try {
      const result = await restoreBackup(file, { force: true });
      log.warn(
        `Restore finished: ${result.documents} documents, ${result.media} evidence file(s), ${result.templates} template(s)`
      );
      res.json({
        restored: {
          documents: result.documents,
          collections: result.collections,
          media: result.media,
          templates: result.templates,
        },
        /*
         * Said plainly, because it is about to happen to the person reading it: the users collection
         * has just been replaced, so their account is whatever the backup says it is and their
         * session is not in it. Everybody signs in again.
         */
        signedOut: true,
      });
    } finally {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  })
);

/** Throws an inspected archive away without applying it. */
router.delete(
  '/staged/:id',
  asyncHandler(async (req, res) => {
    await fsp.rm(stagedPath(req.params.id), { force: true }).catch(() => {});
    res.json({ discarded: true });
  })
);

export default router;
