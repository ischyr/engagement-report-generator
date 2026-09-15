/**
 * Checklists in and out, as JSON.
 *
 * The paste box beside this already takes a methodology out of a document — a line per check, a
 * heading ending in a colon — and it is the right tool for that job. What it cannot do is carry a
 * check's *description*, and it cannot round-trip: what comes out of this app is not something the
 * app can read back in. So a methodology curated over two years lives in one instance and is
 * retyped into the next one.
 *
 * This is the other half. One file, readable by a person, editable in any text editor, and
 * accepted back by any instance.
 *
 * ## What the file deliberately does not carry
 *
 * Ids, slugs, `builtin`, who made it, and when. Every one of those is a fact about *this*
 * installation rather than about the methodology, and carrying them is how an import goes wrong in
 * ways nobody notices:
 *
 *   - an `_id` would either collide or be ignored, and both are worse than not having it
 *   - a `slug` is how the seeder recognises a shipped methodology, so an imported file claiming
 *     `slug: "web"` would quietly become the thing the next seed overwrites
 *   - `builtin` is a label saying "this came with the app", and a file that could set it would let
 *     anybody's list wear that badge
 *   - `createdBy` is a user id from another instance, where it means somebody else entirely
 *
 * So the file holds a methodology and the importer supplies the provenance: created by whoever
 * imported it, here, now.
 *
 * ## And it reads what it can
 *
 * The same line the nmap and phishing importers take, for the same reason: this file will be
 * hand-edited, and a strict parser is correct and useless. It accepts the shape it exports, a bare
 * list of checklists, a single checklist, and a bare list of checks — then says exactly what it
 * understood and what it could not use.
 */

/** What the file says it is, so a reader can tell it from any other JSON. */
export const FORMAT = 'engy.checklist';
/** Bumped only for a change that an older reader would misread rather than merely ignore. */
export const VERSION = 1;

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 2000;
const CATEGORY_MAX = 120;
const NAME_MAX = 160;
const LIST_DESCRIPTION_MAX = 1000;

/** How many checks one file may bring in, per checklist. A methodology, not a database. */
export const MAX_CHECKS = 2000;
/** And how many checklists. */
export const MAX_LISTS = 50;

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * One checklist as it goes out.
 *
 * Order is the array's, not a number. A file people edit by hand should let them move a line and
 * have that mean something — an `order: 7` left behind after a cut and paste is a file that
 * imports in an order nobody chose.
 */
export function forExport(checklist) {
  return {
    name: checklist.name,
    description: checklist.description ?? '',
    checks: [...(checklist.checks ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((check) => ({
        title: check.title,
        ...(check.description ? { description: check.description } : {}),
        ...(check.category ? { category: check.category } : {}),
      })),
  };
}

/** The whole file, for one checklist or many. */
export function exportFile(checklists) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    checklists: checklists.map(forExport),
  };
}

/** A filename somebody can find again, from the name they gave the list. */
export function exportFilename(checklist) {
  const stem = checklist
    ? String(checklist.name ?? 'checklist')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'checklist'
    : 'checklists';
  return `${stem}.checklist.json`;
}

/**
 * One check, or a reason it could not be used.
 *
 * A string is accepted as well as an object: a hand-written file listing titles is a reasonable
 * thing for somebody to produce, and refusing it would be pedantry.
 */
function readCheck(raw, index, problems) {
  if (typeof raw === 'string') {
    const title = text(raw, TITLE_MAX);
    if (!title) {
      problems.push(`check ${index + 1}: empty`);
      return null;
    }
    return { title, description: '', category: '' };
  }

  if (!raw || typeof raw !== 'object') {
    problems.push(`check ${index + 1}: not a check`);
    return null;
  }

  /* `name` as well as `title`, because half the tools in this trade call it that. */
  const title = text(raw.title ?? raw.name ?? '', TITLE_MAX);
  if (!title) {
    problems.push(`check ${index + 1}: no title`);
    return null;
  }

  return {
    title,
    /* Not collapsed to one line: a description is prose and may legitimately have paragraphs. */
    description: String(raw.description ?? raw.detail ?? '')
      .trim()
      .slice(0, DESCRIPTION_MAX),
    category: text(raw.category ?? raw.group ?? '', CATEGORY_MAX),
  };
}

/** One checklist, or a reason it could not be used. */
function readList(raw, index, problems) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`checklist ${index + 1}: not a checklist`);
    return null;
  }

  const name = text(raw.name ?? raw.title ?? '', NAME_MAX);
  if (!name) {
    problems.push(`checklist ${index + 1}: no name`);
    return null;
  }

  const rawChecks = Array.isArray(raw.checks) ? raw.checks : Array.isArray(raw.items) ? raw.items : [];
  const checks = [];
  for (const [at, entry] of rawChecks.slice(0, MAX_CHECKS).entries()) {
    const check = readCheck(entry, at, problems);
    if (check) checks.push(check);
  }
  if (rawChecks.length > MAX_CHECKS) {
    problems.push(`"${name}": only the first ${MAX_CHECKS} checks were read`);
  }

  return {
    name,
    description: String(raw.description ?? '').trim().slice(0, LIST_DESCRIPTION_MAX),
    checks,
  };
}

/**
 * What a file contains, whatever shape somebody wrote it in.
 *
 * Four accepted shapes, and the order they are tried in matters: the exported envelope first,
 * because it is unambiguous, then a bare array of checklists, then one checklist, and last a bare
 * array of checks — which is the only one that has to be guessed at, so it is the only one that is
 * decided by looking at what the entries hold.
 *
 * @returns {{checklists: Array, problems: string[], shape: string}}
 */
export function readFile(input) {
  const problems = [];

  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return { checklists: [], problems: [`That is not JSON: ${error.message}`], shape: 'none' };
    }
  }

  if (!data || typeof data !== 'object') {
    return { checklists: [], problems: ['There is nothing in that file.'], shape: 'none' };
  }

  /* The envelope this app writes. */
  if (!Array.isArray(data) && Array.isArray(data.checklists)) {
    if (data.format && data.format !== FORMAT) {
      problems.push(`The file says it is "${data.format}", which is not a checklist file.`);
    }
    if (Number(data.version) > VERSION) {
      /* Read it anyway: a newer file is more likely to have added a field than changed one. */
      problems.push(
        `The file was written by a newer version (${data.version}). Anything it added has been ignored.`
      );
    }
    const lists = data.checklists
      .slice(0, MAX_LISTS)
      .map((entry, index) => readList(entry, index, problems))
      .filter(Boolean);
    return { checklists: lists, problems, shape: 'file' };
  }

  if (Array.isArray(data)) {
    /*
     * A bare array is either checklists or checks, and the difference is whether the entries carry
     * their own checks. Strings are always checks: nobody writes a checklist as a bare string.
     */
    const looksLikeChecklists = data.some(
      (entry) => entry && typeof entry === 'object' && (Array.isArray(entry.checks) || Array.isArray(entry.items))
    );

    if (looksLikeChecklists) {
      const lists = data
        .slice(0, MAX_LISTS)
        .map((entry, index) => readList(entry, index, problems))
        .filter(Boolean);
      return { checklists: lists, problems, shape: 'checklists' };
    }

    const checks = [];
    for (const [at, entry] of data.slice(0, MAX_CHECKS).entries()) {
      const check = readCheck(entry, at, problems);
      if (check) checks.push(check);
    }
    return {
      checklists: checks.length ? [{ name: '', description: '', checks }] : [],
      problems,
      shape: 'checks',
    };
  }

  /* One checklist on its own. */
  const single = readList(data, 0, problems);
  return { checklists: single ? [single] : [], problems, shape: 'checklist' };
}

/**
 * Adds checks to a list, skipping the ones already on it.
 *
 * The same key the paste importer uses — category and title, case-insensitively — so importing a
 * file you have already imported adds nothing, and importing a file that overlaps another adds the
 * difference. Dedupe rather than replace: somebody's own wording on a check they have edited is
 * worth more than a fresh copy of the original.
 */
export function mergeChecks(checklist, checks) {
  const seen = new Set(
    (checklist.checks ?? []).map((check) => `${check.category ?? ''}|${check.title}`.toLowerCase())
  );

  let added = 0;
  let skipped = 0;
  for (const check of checks) {
    const key = `${check.category}|${check.title}`.toLowerCase();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    checklist.checks.push({ ...check, order: checklist.checks.length });
    added += 1;
  }
  return { added, skipped };
}

export default { exportFile, forExport, readFile, mergeChecks };
