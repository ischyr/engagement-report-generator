/**
 * Moves enumeration text out of the engagement documents that still carry it.
 *
 * Runs once at boot, like `backfillRedTeamKind`. An install that predates the split has `output`,
 * `previousOutput` and `content` sitting inside `audit.enumeration[]`, which is the thing the split
 * exists to stop — so leaving them there would mean the 16MB ceiling had merely been postponed for
 * anybody who had already used the feature.
 *
 * Read through the raw driver rather than through Mongoose, deliberately. Those three fields are no
 * longer in `enumerationStepSchema`, and a Mongoose read would hand back documents with the text
 * already stripped — the migration would report success over data it never saw.
 *
 * Idempotent, and safe to interrupt. Each engagement is finished before the next is started, the
 * body is written before the fields are unset, and an engagement with nothing left inline is skipped
 * on the next boot. A crash between the two writes leaves a duplicated body, which the next boot
 * overwrites with the same content.
 */
import { Audit } from '../models/audit.model.js';
import { EnumerationBody } from '../models/enumeration-body.model.js';
import { bodySummary } from './enumeration-body.service.js';
import { htmlHasContent } from './ooxml/html-parser.js';
import { resolveOutputNotes } from './enumeration-notes.service.js';
import logger from '../utils/logger.js';

/** The fields that used to live on a step and now live in their own document. */
const MOVED = ['output', 'previousOutput', 'content'];

const hasInlineText = (step) =>
  MOVED.some((field) => typeof step?.[field] === 'string' && step[field].length > 0);

export async function moveEnumerationText() {
  const audits = Audit.collection;

  /*
   * Only engagements that still have text inline. `$elemMatch` with `$ne: ''` on any of the three,
   * so a tree of steps that were only ever titles is not rewritten for nothing.
   */
  const candidates = await audits
    .find(
      {
        enumeration: {
          $elemMatch: {
            $or: MOVED.map((field) => ({ [field]: { $exists: true, $nin: ['', null] } })),
          },
        },
      },
      { projection: { enumeration: 1 } }
    )
    .toArray();

  if (!candidates.length) return { audits: 0, steps: 0 };

  let movedSteps = 0;

  for (const audit of candidates) {
    const steps = (audit.enumeration ?? []).filter(hasInlineText);
    if (!steps.length) continue;

    /* One upsert per step, then one write to strip the fields from the whole tree. */
    const writes = steps.map((step) => {
      const output = String(step.output ?? '');
      const content = String(step.content ?? '');
      return {
        updateOne: {
          filter: { audit: audit._id, step: step._id },
          update: {
            $set: {
              audit: audit._id,
              step: step._id,
              output,
              content,
              previousOutput: String(step.previousOutput ?? ''),
              previousOutputAt: step.previousOutputAt ?? null,
              /*
               * The best available answer, not an invention. A step that predates the split has no
               * record of when its output was pasted, so its last edit is the closest thing to it —
               * and `null` would make every existing step look as though it had never been run.
               */
              outputAt: step.previousOutputAt ?? step.updatedAt ?? null,
            },
          },
          upsert: true,
        },
      };
    });
    // eslint-disable-next-line no-await-in-loop
    await EnumerationBody.bulkWrite(writes, { ordered: false });

    /*
     * The summary fields the tree now reads, and the marked lines re-anchored, computed from the
     * text as it was found. Written in the same update as the `$unset`, so no boot ever sees a tree
     * whose counts say zero over steps that have output.
     */
    const set = {};
    const unset = {};
    (audit.enumeration ?? []).forEach((step, index) => {
      const summary = bodySummary({ output: step.output, content: step.content, tool: step.tool });
      set[`enumeration.${index}.outputLines`] = summary.outputLines;
      set[`enumeration.${index}.outputBytes`] = summary.outputBytes;
      set[`enumeration.${index}.outputPreview`] = summary.outputPreview;
      set[`enumeration.${index}.tableRows`] = summary.tableRows;
      set[`enumeration.${index}.hasContent`] = summary.hasContent;
      set[`enumeration.${index}.hasPreviousOutput`] =
        String(step.previousOutput ?? '').trim().length > 0;
      set[`enumeration.${index}.outputAt`] = step.previousOutputAt ?? step.updatedAt ?? null;

      if ((step.notes ?? []).length) {
        const resolved = resolveOutputNotes(step.output, step.notes);
        set[`enumeration.${index}.notes`] = step.notes.map((note) => {
          const now = resolved.find((entry) => String(entry._id) === String(note._id));
          return { ...note, line: now?.line ?? note.line, stale: Boolean(now?.stale) };
        });
      }

      for (const field of MOVED) unset[`enumeration.${index}.${field}`] = '';
    });

    // eslint-disable-next-line no-await-in-loop
    await audits.updateOne({ _id: audit._id }, { $set: set, $unset: unset });
    movedSteps += steps.length;
  }

  logger.info(
    `Moved the text of ${movedSteps} enumeration step(s) out of ${candidates.length} engagement(s)`
  );
  return { audits: candidates.length, steps: movedSteps };
}

/**
 * Corrects steps whose `hasContent` was decided by the old rule.
 *
 * That rule asked whether the write-up had any *text*, which is false for a write-up that is one
 * screenshot — and a screenshot with nothing written round it is the ordinary case in an
 * enumeration. Templates guard the write-up with `{{#hasContent}}`, so those steps printed their
 * command and then nothing, with the picture sitting in the database.
 *
 * The report works this out for itself on every render, so this is only about the flag the *tree*
 * reads. Cheap and idempotent: the write-ups are projected to their content, and an engagement is
 * only written to when a step actually disagrees.
 */
export async function repairContentFlags() {
  const bodies = await EnumerationBody.find({ content: { $ne: '' } })
    .select('audit step content')
    .lean();
  if (!bodies.length) return { steps: 0 };

  /* Grouped, so an engagement with a dozen affected steps is one write rather than a dozen. */
  const byAudit = new Map();
  for (const body of bodies) {
    const key = String(body.audit);
    if (!byAudit.has(key)) byAudit.set(key, []);
    byAudit.get(key).push(body);
  }

  let fixed = 0;
  for (const [auditId, rows] of byAudit) {
    // eslint-disable-next-line no-await-in-loop
    const audit = await Audit.findById(auditId).select('enumeration').lean();
    if (!audit) continue;

    const set = {};
    (audit.enumeration ?? []).forEach((step, index) => {
      const body = rows.find((r) => String(r.step) === String(step._id));
      if (!body) return;
      const should = htmlHasContent(body.content);
      if (Boolean(step.hasContent) === should) return;
      set[`enumeration.${index}.hasContent`] = should;
      fixed += 1;
    });

    if (Object.keys(set).length) {
      // eslint-disable-next-line no-await-in-loop
      await Audit.collection.updateOne({ _id: audit._id }, { $set: set });
    }
  }

  if (fixed) logger.info(`Corrected the write-up flag on ${fixed} enumeration step(s)`);
  return { steps: fixed };
}

/**
 * How much text is still sitting in engagement documents, for a health check to report.
 *
 * Cheap: an aggregation over the field sizes rather than a read of the text itself.
 */
export async function inlineEnumerationBytes() {
  const [row] = await Audit.collection
    .aggregate([
      { $match: { 'enumeration.0': { $exists: true } } },
      { $project: { bytes: { $bsonSize: '$$ROOT' } } },
      { $group: { _id: null, largest: { $max: '$bytes' }, total: { $sum: '$bytes' } } },
    ])
    .toArray();
  return {
    largestAuditBytes: row?.largest ?? 0,
    /* The ceiling this whole change exists to stay under. */
    limitBytes: 16 * 1024 * 1024,
  };
}

export default moveEnumerationText;
