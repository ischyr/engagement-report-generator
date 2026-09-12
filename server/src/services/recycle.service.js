/**
 * Putting back what somebody just deleted.
 *
 * One mechanism for every row inside an engagement, because the alternative was fourteen delete
 * routes each deciding for itself whether a mistake was recoverable — and the answer, everywhere
 * except findings, was no.
 *
 * The shape is deliberately dumb. A delete calls `remember()` with the subdocument it is about to
 * drop and says which list it came out of; `restore()` looks the kind up in `RESTORERS` and puts it
 * back where it was. Nothing here knows what a credential or a test check contains, which is what
 * keeps it from needing a change every time one of them gains a field.
 *
 * Two rules worth stating, because both were tempting to break:
 *
 *   - **Restore is not create.** The record goes back with its own `_id`, so anything that pointed
 *     at it still does: a finding that cites an enumeration step, a note that names a credential.
 *     Re-creating it under a new id would look identical and quietly break every reference.
 *   - **Position is part of the record.** A step put back at the end of the list is not the step
 *     that was deleted, it is a similar one in the wrong place — and for enumeration, where the
 *     array *is* the reading order of a report chapter, that is a silent corruption.
 */
import { Recycled } from '../models/recycled.model.js';
import { Credential } from '../models/credential.model.js';
import { DetectionEvent } from '../models/detection-event.model.js';
import { EnumerationBody } from '../models/enumeration-body.model.js';
import { KitItem } from '../models/kit-item.model.js';
import { PhishingTarget } from '../models/phishing-target.model.js';
import { ScopeChange } from '../models/scope-change.model.js';
import { TimeEntry } from '../models/time-entry.model.js';
import { Scratch } from '../models/scratch.model.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { log } from '../utils/logger.js';

/**
 * How long an undo stays available.
 *
 * Ten minutes, against the toast's twelve seconds. The toast is the offer; this is the window in
 * which the offer can still be taken, and they are not the same number — somebody who deletes a
 * step, notices two minutes later and goes looking for the way back should find one. Long enough
 * to be useful, short enough that this never becomes a store of deleted client data.
 */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/** A restorer for an ordinary array of subdocuments on the audit. */
const intoList = (path) => ({
  async restore(audit, entry) {
    const list = audit[path];
    if (!Array.isArray(list)) throw badRequest('That list no longer exists on this engagement.');
    if (list.some((row) => String(row._id) === String(entry.payload?._id))) {
      throw badRequest('It is already back.');
    }
    const at = Number.isInteger(entry.index) ? Math.min(entry.index, list.length) : list.length;
    list.splice(at, 0, entry.payload);
    audit.markModified(path);
  },
});

/**
 * A restorer for a row that lives in its own collection rather than inside the engagement.
 *
 * Half of what an engagement holds is a subdocument and half is a document — a credential, a kit
 * item, a phishing recipient — and the difference matters here only in how it goes back. Insert
 * rather than create, so it returns under the id it had, which is the rule at the top of this file.
 */
const intoCollection = (Model) => ({
  async restore(audit, entry) {
    const id = entry.payload?._id;
    if (id && (await Model.exists({ _id: id }))) throw badRequest('It is already back.');
    await Model.create({ ...entry.payload, audit: audit._id });
  },
});

/**
 * A restorer for a record that belongs to a person, not to an engagement.
 *
 * No `audit` is touched — these go back exactly as they were, which for a scratchpad note means
 * under its own id so a link to it still works. `scope: 'free'` is what sends it through
 * `restoreOwned` and keeps `restore` from being handed one it cannot place.
 */
const intoOwnCollection = (Model) => ({
  scope: 'free',
  async restore(_audit, entry) {
    const id = entry.payload?._id;
    if (id && (await Model.exists({ _id: id }))) throw badRequest('It is already back.');
    await Model.create(entry.payload);
  },
});

/** The same, for a list that hangs off another subdocument — a note on an enumeration step. */
const intoNested = (path, childPath) => ({
  async restore(audit, entry) {
    const parent = audit[path]?.id?.(entry.parent);
    if (!parent) throw badRequest('The row it belonged to has been deleted too.');
    const list = parent[childPath];
    if (list.some((row) => String(row._id) === String(entry.payload?._id))) {
      throw badRequest('It is already back.');
    }
    const at = Number.isInteger(entry.index) ? Math.min(entry.index, list.length) : list.length;
    list.splice(at, 0, entry.payload);
    audit.markModified(path);
  },
});

/**
 * What each kind is called, and how it goes back.
 *
 * `noun` is what the toast says. It is here rather than at the call site so that "Enumeration step
 * deleted" reads the same wherever the delete happened to be triggered from.
 */
export const RESTORERS = {
  'enumeration-step': {
    noun: 'Enumeration step',
    /**
     * A branch, not a row — and its text, which lives in another collection.
     *
     * Deleting a section takes its tool runs with it, so the undo has to bring all of them back
     * together or the tree comes back missing its middle.
     */
    async restore(audit, entry) {
      const steps = Array.isArray(entry.payload) ? entry.payload : [entry.payload];
      const present = new Set((audit.enumeration ?? []).map((row) => String(row._id)));
      const missing = steps.filter((step) => !present.has(String(step._id)));
      if (!missing.length) throw badRequest('It is already back.');

      const at = Number.isInteger(entry.index)
        ? Math.min(entry.index, audit.enumeration.length)
        : audit.enumeration.length;
      audit.enumeration.splice(at, 0, ...missing);
      audit.markModified('enumeration');

      /* The bodies were deleted after the steps, so they go back before them — same reasoning. */
      const bodies = entry.extra?.bodies ?? [];
      if (bodies.length) {
        await EnumerationBody.insertMany(
          bodies.map((body) => ({ ...body, audit: audit._id })),
          { ordered: false }
        ).catch((error) => {
          /* The steps are what matter; a body that refuses to come back is worth saying, not throwing. */
          log.warn(`Could not restore enumeration text: ${error.message}`);
        });
      }
    },
  },
  note: { noun: 'Note', ...intoList('notes') },
  section: { noun: 'Section', ...intoList('sections') },
  'test-check': { noun: 'Test check', ...intoList('testChecks') },
  credential: { noun: 'Credential', ...intoCollection(Credential) },
  'kit-item': { noun: 'Kit item', ...intoCollection(KitItem) },
  'phishing-target': { noun: 'Recipient', ...intoCollection(PhishingTarget) },
  detection: { noun: 'Detection event', ...intoCollection(DetectionEvent) },
  'scope-change': { noun: 'Scope change', ...intoCollection(ScopeChange) },
  handover: { noun: 'Handover note', ...intoList('handovers') },
  question: { noun: 'Question', ...intoList('questions') },
  'step-note': { noun: 'Output note', ...intoNested('enumeration', 'notes') },
  /* Hours logged against an engagement: a row somebody deletes when they meant to edit it, and
     until now the only way back was to remember what it said. */
  'time-entry': { noun: 'Time entry', ...intoCollection(TimeEntry) },
  /* And the first thing here that belongs to a person rather than to a job. */
  scratch: { noun: 'Note', ...intoOwnCollection(Scratch) },
};

/**
 * Remembers a row that is about to be deleted.
 *
 * Never throws. A delete that failed because its undo could not be written would be a worse
 * outcome than a delete with no undo, and the caller has usually already saved by the time this
 * runs.
 *
 * @returns {Promise<{id: string, kind: string, noun: string, label: string}|null>}
 */
export async function remember({
  audit = null,
  owner = null,
  kind,
  payload,
  label = '',
  index = null,
  parent = '',
  extra = null,
  actor = null,
}) {
  if (!RESTORERS[kind]) {
    log.warn(`Nothing knows how to restore a "${kind}", so it was not remembered.`);
    return null;
  }
  /*
   * One or the other, and the restorer decides which.
   *
   * An entry with neither could never be found again — `restore` looks it up by the engagement and
   * `restoreOwned` by the person, so a row with no owner of either sort is a leak with a TTL on it
   * rather than an undo. Refused here rather than at the query, where it would read as "there is
   * nothing to put back" and be indistinguishable from an expired window.
   */
  const free = RESTORERS[kind].scope === 'free';
  if (free ? !owner : !audit) {
    log.warn(`A "${kind}" was not remembered: it needs ${free ? 'an owner' : 'an engagement'}.`);
    return null;
  }
  try {
    const row = await Recycled.create({
      audit: audit ? (audit._id ?? audit) : null,
      owner: owner ? (owner._id ?? owner) : null,
      kind,
      label: String(label ?? '').slice(0, 200),
      payload,
      index,
      parent: String(parent ?? ''),
      extra,
      deletedBy: actor?._id ?? null,
      expiresAt: new Date(Date.now() + UNDO_WINDOW_MS),
    });
    return { id: String(row._id), kind, noun: RESTORERS[kind].noun, label: row.label };
  } catch (error) {
    log.warn(`Could not remember a deleted ${kind}: ${error.message}`);
    return null;
  }
}

/**
 * Puts one back.
 *
 * The entry is consumed whether or not the caller goes on to save successfully — an undo offered
 * twice is an undo that can duplicate a row, and the restorers guard against that too.
 *
 * @param {object} audit the engagement, loaded and about to be saved by the caller
 * @param {string} entryId
 * @returns {Promise<{kind: string, noun: string, label: string}>}
 */
export async function restore(audit, entryId) {
  const entry = await Recycled.findOne({ _id: entryId, audit: audit._id, owner: null });
  if (!entry) {
    throw notFound(
      'There is nothing left to put back — an undo is only offered for a few minutes.'
    );
  }
  const restorer = RESTORERS[entry.kind];
  if (!restorer) throw badRequest(`Nothing knows how to restore a "${entry.kind}".`);

  await restorer.restore(audit, entry.toObject());
  await Recycled.deleteOne({ _id: entry._id });
  return { kind: entry.kind, noun: restorer.noun, label: entry.label };
}

/**
 * Puts back something that belonged to a person rather than to an engagement.
 *
 * The same contract with a different key. Scoped by `owner` and not merely checked against it: a
 * lookup by id alone, verified afterwards, is a way of confirming that somebody else's entry exists
 * — and the id is in a URL that somebody could have been sent.
 *
 * No `audit` is passed to the restorer, which is why these kinds are marked `scope: 'free'`: one
 * that expected an engagement would be handed `null` and fail in a way that reads like data loss.
 *
 * @param {object} user whoever is asking
 * @param {string} entryId
 */
export async function restoreOwned(user, entryId) {
  const entry = await Recycled.findOne({ _id: entryId, owner: user._id ?? user });
  if (!entry) {
    throw notFound(
      'There is nothing left to put back — an undo is only offered for a few minutes.'
    );
  }
  const restorer = RESTORERS[entry.kind];
  if (!restorer) throw badRequest(`Nothing knows how to restore a "${entry.kind}".`);
  if (restorer.scope !== 'free') {
    throw badRequest('That one belongs to an engagement, and goes back through it.');
  }

  await restorer.restore(null, entry.toObject());
  await Recycled.deleteOne({ _id: entry._id });
  return { kind: entry.kind, noun: restorer.noun, label: entry.label };
}

export default { remember, restore, restoreOwned, RESTORERS, UNDO_WINDOW_MS };
