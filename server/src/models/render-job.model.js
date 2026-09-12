import mongoose from 'mongoose';

/**
 * A report someone asked for, and how far along it is.
 *
 * Generating used to happen inside the GET that asked for it: the browser held a request open for
 * tens of seconds while the template was filled, every figure renumbered and every screenshot
 * inlined, and the documentation carried a note telling operators to raise their proxy timeout.
 * That note is the shape of the problem — a feature whose instructions include "reconfigure your
 * reverse proxy" is a feature that has told you where it is wrong.
 *
 * The request now records one of these and returns. A worker takes them one at a time, the browser
 * asks how it is going, and the bytes wait here until somebody collects them. Three things follow
 * that could not be had before: the page can say what it is doing rather than spinning, the tab can
 * be closed and the document collected later, and two people generating at once queue instead of
 * competing for the same single-threaded process.
 *
 * **What this does not fix**, and the honest note belongs in the model rather than the release
 * notes: assembling the document is synchronous CPU work, so while it runs it still occupies the
 * event loop. Moving that into a worker thread is a separate job. What has changed is that nobody
 * is holding a socket open waiting for it.
 */

/** How a job can go. `cancelled` is only reachable from `queued` — see the service. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

/**
 * How long a finished job's bytes are kept.
 *
 * Long enough to survive a laptop closing, a meeting, and somebody coming back to it after lunch.
 * Not so long that an instance accumulates a Word document for every render anybody ever asked for
 * — the render *record* is the permanent history, and it is deliberately only metadata.
 */
export const JOB_TTL_HOURS = 12;

const renderJobSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    /** What was asked for. Only `report` today; named so a PDF or a marked set can join later. */
    kind: { type: String, default: 'report' },
    /** The engagement as it was named when this was asked for, so a rename does not orphan it. */
    subject: { type: String, default: '', maxlength: 300 },

    status: { type: String, enum: JOB_STATUSES, default: 'queued', index: true },
    /**
     * What it is doing, in the words the person waiting would use.
     *
     * "Fetching the evidence" rather than "loadMediaMap": this string is shown, not logged, and a
     * progress message that names an internal function tells the reader only that nobody thought
     * they would see it.
     */
    stage: { type: String, default: 'Waiting for the one in front', maxlength: 120 },
    /** 0–100. Approximate on purpose: the assembly step cannot report from inside itself. */
    progress: { type: Number, default: 0, min: 0, max: 100 },

    /** What to render: the template to use, and whether it is somebody's own marked copy. */
    options: { type: mongoose.Schema.Types.Mixed, default: null },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    requestedByName: { type: String, default: '', maxlength: 160 },

    /**
     * The produced file, in GridFS.
     *
     * Its own bucket rather than the media one: evidence is garbage-collected against the
     * engagements that reference it, and a render nobody has collected yet is referenced by
     * nothing. Sharing the bucket would mean the sweeper and this model arguing about whose file
     * it is, and the sweeper would win.
     */
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    filename: { type: String, default: '', maxlength: 300 },
    size: { type: Number, default: 0 },
    outputHash: { type: String, default: '' },
    /** The RenderRecord this produced, so the job links to the permanent history. */
    renderId: { type: String, default: '' },

    /** Why it failed, in the same words the old synchronous route would have put in the response. */
    error: { type: String, default: '', maxlength: 2000 },

    /**
     * How many times this has been picked up.
     *
     * A process that dies mid-render leaves a job marked `running` with nobody running it. Boot
     * puts those back in the queue — but only once: a render that reliably kills the process would
     * otherwise be picked up, crash, and be picked up again by the next boot, forever.
     */
    attempts: { type: Number, default: 0 },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    /** When the bytes stop being available. The job row outlives them by nothing. */
    expiresAt: { type: Date, default: null, index: true },
    /** Set the first time the file is collected, so the list can say what is still waiting. */
    collectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** The worker's own query: the oldest thing still waiting. */
renderJobSchema.index({ status: 1, createdAt: 1 });
/** And the page's: what has this engagement got in flight. */
renderJobSchema.index({ audit: 1, createdAt: -1 });

export const RenderJob = mongoose.model('RenderJob', renderJobSchema);
export default RenderJob;
