/**
 * Reading and writing the text of an enumeration step.
 *
 * The one door to `EnumerationBody`. Everything that touches a step's output goes through here, and
 * that is the point rather than tidiness: the tree draws line counts and table row counts from small
 * fields kept on the step itself, and a denormalised count is only trustworthy while exactly one
 * piece of code can change the thing it counts.
 *
 * So `saveEnumerationBody` does three things at once, and they cannot be separated:
 *
 *   1. writes the body to its own collection
 *   2. updates the step's summary fields — `outputLines`, `outputPreview`, `tableRows`, `hasContent`
 *   3. re-resolves the step's marked lines against the new output
 *
 * Anything that skipped it would leave a tree saying "400 lines" over an empty step.
 */
import { EnumerationBody } from '../models/enumeration-body.model.js';
import { parseToolOutput } from './enumeration-table.service.js';
import { resolveOutputNotes } from './enumeration-notes.service.js';
import { htmlHasContent } from './ooxml/html-parser.js';

/** How much of the output the tree carries, for the filter's text box. */
const PREVIEW_CHARS = 240;

/** A step with nothing in it yet, so callers never have to guard on null. */
export const EMPTY_BODY = Object.freeze({
  output: '',
  previousOutput: '',
  previousOutputAt: null,
  outputAt: null,
  content: '',
});

const trimEnd = (value) => String(value ?? '').replace(/\s+$/, '');

/**
 * The facts about a body that are small enough to live on the step.
 *
 * Everything the tree draws, and nothing else. Computed on write so that listing sixty steps is one
 * read of the audit document rather than sixty-one.
 */
export function bodySummary({ output, content, tool }) {
  const text = trimEnd(output);
  const table = parseToolOutput(tool, output);
  return {
    outputLines: text ? text.split(/\r?\n/).length : 0,
    outputBytes: text.length,
    outputPreview: text.slice(0, PREVIEW_CHARS),
    tableRows: table?.rows?.length ?? 0,
    /* The same rule the report uses, so the page and the document cannot disagree. */
    hasContent: htmlHasContent(content),
  };
}

/** Every step's body for one engagement, keyed by step id. For the report, which needs all of it. */
export async function loadEnumerationBodies(auditId) {
  const rows = await EnumerationBody.find({ audit: auditId }).lean();
  return new Map(rows.map((row) => [String(row.step), row]));
}

/** One step's body, for the detail endpoint. Never null — an unwritten step reads as empty. */
export async function loadEnumerationBody(auditId, stepId) {
  const row = await EnumerationBody.findOne({ audit: auditId, step: stepId }).lean();
  return row ?? { ...EMPTY_BODY };
}

/**
 * Writes a step's text, and brings the step in the audit document into line with it.
 *
 * Mutates `step` in memory — the caller is expected to be holding an audit it is about to save, so
 * the summary and the notes travel with whatever else that save was carrying. Only the keys present
 * in `patch` are touched, which is what lets a title-only save leave last week's sweep alone.
 *
 * @param {object} audit the engagement, already loaded
 * @param {object} step  the step subdocument, mutated in place
 * @param {object} patch any of `output`, `content`
 * @returns {Promise<object>} the body as it now stands
 */
export async function saveEnumerationBody(audit, step, patch = {}) {
  const current = await EnumerationBody.findOne({ audit: audit._id, step: step._id });
  const before = current ?? { ...EMPTY_BODY };

  const next = {
    output: 'output' in patch ? String(patch.output ?? '') : String(before.output ?? ''),
    content: 'content' in patch ? String(patch.content ?? '') : String(before.content ?? ''),
    previousOutput: String(before.previousOutput ?? ''),
    previousOutputAt: before.previousOutputAt ?? null,
    outputAt: before.outputAt ?? null,
  };

  const outputChanged = 'output' in patch && next.output !== String(before.output ?? '');
  if (outputChanged) {
    /*
     * Re-running a sweep is the normal case, and "what is different now" is the only question
     * anybody asks about it. Snapshot the outgoing output — but only when there was one, so saving
     * a title cannot throw away last week's run.
     */
    if (String(before.output ?? '').trim()) {
      next.previousOutput = String(before.output ?? '');
      next.previousOutputAt = new Date();
    }
    next.outputAt = new Date();
  }

  const saved = await EnumerationBody.findOneAndUpdate(
    { audit: audit._id, step: step._id },
    { $set: { ...next, audit: audit._id, step: step._id } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  applyBodyToStep(step, saved);
  return saved;
}

/**
 * Puts a body's small facts onto its step, and re-anchors the marked lines.
 *
 * Separate from the write above because the backfill needs it too, over documents it is moving
 * rather than saving through the same path.
 */
export function applyBodyToStep(step, body) {
  const summary = bodySummary({ output: body.output, content: body.content, tool: step.tool });
  step.set({
    ...summary,
    outputAt: body.outputAt ?? null,
    previousOutputAt: body.previousOutputAt ?? null,
    hasPreviousOutput: String(body.previousOutput ?? '').trim().length > 0,
  });

  /*
   * The marked lines, against the output as it now reads.
   *
   * Stored so the tree can say "one of these is stale" without reading the output it would need to
   * work that out. The detail endpoint resolves them live and is the authority; this is the same
   * answer, cached at the one moment it can change.
   */
  if ((step.notes ?? []).length) {
    const resolved = resolveOutputNotes(body.output, step.notes);
    const byId = new Map(resolved.map((note) => [String(note._id), note]));
    for (const note of step.notes) {
      const now = byId.get(String(note._id));
      if (!now) continue;
      /*
       * `moved` accumulates: a note that followed its line last week and sits still this week has
       * still moved, and the page says so until somebody edits it. Only an edit — where the person
       * is looking at where it sits now — clears it.
       */
      if (now.moved) note.moved = true;
      note.line = now.line;
      note.stale = Boolean(now.stale);
    }
  }
}

/** Removes the bodies of steps that no longer exist — a deleted step, or a deleted branch. */
export async function deleteEnumerationBodies(auditId, stepIds) {
  const ids = [...new Set((stepIds ?? []).map(String))];
  if (!ids.length) return 0;
  const { deletedCount } = await EnumerationBody.deleteMany({ audit: auditId, step: { $in: ids } });
  return deletedCount ?? 0;
}

/** Everything belonging to an engagement being destroyed for good. */
export async function deleteAllEnumerationBodies(auditId) {
  const { deletedCount } = await EnumerationBody.deleteMany({ audit: auditId });
  return deletedCount ?? 0;
}

export default saveEnumerationBody;
