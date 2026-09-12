/**
 * One report at a time, and nobody holding a socket open while it happens.
 *
 * Generating a report is seconds of one Node thread — the template filled, every figure
 * renumbered, every screenshot inlined — and it used to happen inside the GET that asked for it.
 * The operations notes carried a warning telling people to raise their proxy timeout, which is a
 * feature telling you where it is wrong.
 *
 * So the request records a job and returns. This takes them one at a time, reports which part it
 * is on, and leaves the bytes in GridFS until somebody collects them. The browser can be closed
 * and the document picked up afterwards, two people generating at once queue rather than compete,
 * and the page can say "assembling the document" instead of spinning.
 *
 * ## Where the renderer comes from
 *
 * It is handed in, not imported. Building a report needs a dozen helpers that live in
 * `audits.routes.js` — the enumeration bodies, the finding history, the effort, the deliveries,
 * the scope changes, the detection log — and importing a route module from a service would be a
 * cycle, since the route has to import this one to enqueue anything. `registerReportRenderer` is
 * the seam: this file knows it is given an async function that produces bytes, and nothing else.
 *
 * ## Concurrency
 *
 * One. Not a tuning decision — the expensive part is synchronous, so a second worker in the same
 * process would interleave with the first and finish both later. Claiming is still done with an
 * atomic `findOneAndUpdate`, so two processes pointed at one database cannot take the same job.
 */

import mongoose from 'mongoose';
import { GridFSBucket, ObjectId } from 'mongodb';

import { RenderJob, JOB_TTL_HOURS } from '../models/render-job.model.js';
import log from '../utils/logger.js';

const BUCKET = 'renderjobs';
/** How often to clear out collected and expired documents. */
const SWEEP_EVERY_MS = 15 * 60 * 1000;
/** A job picked up this many times and still not finished is not going to finish. */
const MAX_ATTEMPTS = 2;

let bucket = null;
/** Lazily, and re-made if the connection was replaced — the same rule the media bucket follows. */
function files() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  }
  return bucket;
}

/* -------------------------------------------------------------------------- */
/* The renderer, handed in                                                    */
/* -------------------------------------------------------------------------- */

let renderer = null;

/**
 * @param {(job: {auditId: string, userId: string, options: object, onProgress: Function}) =>
 *   Promise<{buffer: Buffer, filename: string, provenance: object}>} fn
 */
export function registerReportRenderer(fn) {
  renderer = fn;
}

/* -------------------------------------------------------------------------- */
/* Asking for one                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Puts a report in the queue and returns immediately.
 *
 * Authorisation is the caller's job and has already happened — but it is checked *again* when the
 * job runs, which is deliberate: a queue introduces a gap between asking and doing, and somebody
 * removed from an engagement in that gap must not be handed its report.
 */
export async function enqueueRender({ audit, user, options = {} }) {
  const job = await RenderJob.create({
    audit: audit._id,
    kind: 'report',
    subject: [audit.name, audit.reference].filter(Boolean).join(' · '),
    options,
    requestedBy: user?._id ?? null,
    requestedByName: [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || '',
    expiresAt: new Date(Date.now() + JOB_TTL_HOURS * 3600 * 1000),
  });

  /* Not awaited: the point of the queue is that the caller does not wait for the render. */
  void pump();
  return job;
}

/** How many are in front of this one, so the page can say so rather than only "waiting". */
export async function positionInQueue(job) {
  if (job.status !== 'queued') return 0;
  return RenderJob.countDocuments({ status: 'queued', createdAt: { $lt: job.createdAt } });
}

/* -------------------------------------------------------------------------- */
/* Doing them                                                                 */
/* -------------------------------------------------------------------------- */

let pumping = false;

/**
 * Takes the oldest waiting job and marks it ours, atomically.
 *
 * `findOneAndUpdate` rather than find-then-save because the check and the claim have to be one
 * operation: two processes reading "queued" at the same moment would otherwise both render it,
 * and the second would overwrite the first's file with identical bytes and a different render id.
 */
async function claimNext() {
  return RenderJob.findOneAndUpdate(
    { status: 'queued' },
    {
      $set: { status: 'running', startedAt: new Date(), stage: 'Starting', progress: 1 },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, new: true }
  );
}

/** Progress, written straight to the row: the page is polling it and nothing else reads it. */
const report = (job) => async (stage, progress) => {
  await RenderJob.updateOne(
    { _id: job._id, status: 'running' },
    { $set: { stage, progress: Math.max(0, Math.min(100, Math.round(progress))) } }
  ).catch(() => {
    /* A progress update is not worth failing a render over. */
  });
};

/** The produced bytes into GridFS, returning the id to collect them by. */
function store(filename, buffer) {
  return new Promise((resolve, reject) => {
    const stream = files().openUploadStream(filename, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
}

/** The file for a finished job, as a stream. */
export function openJobFile(job) {
  return files().openDownloadStream(new ObjectId(String(job.fileId)));
}

async function runJob(job) {
  if (!renderer) {
    throw new Error('No renderer registered — installRenderQueue() runs before the routes load');
  }
  const onProgress = report(job);
  await onProgress('Reading the engagement', 5);

  const { buffer, filename, provenance } = await renderer({
    auditId: String(job.audit),
    userId: String(job.requestedBy ?? ''),
    options: job.options ?? {},
    onProgress,
  });

  await onProgress('Storing the document', 97);
  const fileId = await store(filename, buffer);

  await RenderJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: 'done',
        stage: 'Ready',
        progress: 100,
        fileId,
        filename,
        size: buffer.length,
        outputHash: provenance?.outputHash ?? '',
        renderId: provenance?.renderId ?? '',
        finishedAt: new Date(),
        /* The clock on the bytes starts when they exist, not when they were asked for. */
        expiresAt: new Date(Date.now() + JOB_TTL_HOURS * 3600 * 1000),
      },
    }
  );
}

/**
 * Works the queue until it is empty.
 *
 * Re-entrant by a flag rather than a lock: every path that adds work calls this, and the second
 * caller only needs to know that somebody is already working.
 */
export async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = await claimNext();
      if (!job) return;
      try {
        await runJob(job);
      } catch (error) {
        log.warn(`Render job ${job._id} failed: ${error.message}`);
        await RenderJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              stage: 'Failed',
              /* The message the synchronous route would have put in the response body. A render
                 fails for reasons the person can act on — no template, a broken tag — so it is
                 shown rather than swallowed into a log they cannot read. */
              error: String(error.message ?? error).slice(0, 2000),
              finishedAt: new Date(),
            },
          }
        ).catch(() => {});
      }
    }
  } finally {
    pumping = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Jobs left marked `running` by a process that is no longer running.
 *
 * Put back in the queue, once. A render that reliably kills the process would otherwise be picked
 * up by every boot forever, and an instance that will not start is a worse outcome than a report
 * somebody has to ask for again.
 */
export async function recoverOrphans() {
  const retry = await RenderJob.updateMany(
    { status: 'running', attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: 'queued', stage: 'Waiting for the one in front', progress: 0 } }
  );
  const gaveUp = await RenderJob.updateMany(
    { status: 'running', attempts: { $gte: MAX_ATTEMPTS } },
    {
      $set: {
        status: 'failed',
        stage: 'Failed',
        error: 'The server restarted while this was being generated. Ask for it again.',
        finishedAt: new Date(),
      },
    }
  );
  if (retry.modifiedCount || gaveUp.modifiedCount) {
    log.info(
      `Render queue: ${retry.modifiedCount} job(s) requeued after a restart, ${gaveUp.modifiedCount} abandoned`
    );
  }
}

/**
 * Expired documents, and the rows that pointed at them.
 *
 * The file first: a row deleted before its bytes leaves a file in GridFS that nothing references
 * and nothing will ever look for again. In the other order, a crash between the two leaves a row
 * whose file is missing, which the download route reports honestly and the next sweep tidies.
 */
export async function sweepExpired(now = new Date()) {
  const stale = await RenderJob.find({ expiresAt: { $lt: now } }).select('_id fileId');
  for (const job of stale) {
    if (job.fileId) {
      await files()
        .delete(new ObjectId(String(job.fileId)))
        .catch(() => {
          /* Already gone, which is the state we were aiming for. */
        });
    }
  }
  if (stale.length) {
    await RenderJob.deleteMany({ _id: { $in: stale.map((job) => job._id) } });
    log.info(`Render queue: cleared ${stale.length} expired document(s)`);
  }
  return stale.length;
}

let sweeper = null;

/**
 * Starts the worker.
 *
 * Called from the boot sequence beside the mail and the webhooks, and for the same reason: a script
 * that imports the models to read data should not acquire a background worker by accident.
 */
export function installRenderQueue() {
  void recoverOrphans()
    .then(() => pump())
    .catch((error) => log.warn(`Render queue could not start: ${error.message}`));

  sweeper = setInterval(() => {
    void sweepExpired().catch((error) => log.warn(`Render sweep failed: ${error.message}`));
  }, SWEEP_EVERY_MS);
  /* So a finished test process is not held open by a timer it forgot about. */
  sweeper.unref?.();
}

export function stopRenderQueue() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

export default installRenderQueue;
