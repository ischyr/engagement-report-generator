/**
 * Changing one piece of text everywhere it appears in an engagement.
 *
 * The client renames the staging host on day four. It is in six findings, two write-ups and a
 * section, and until now the way to fix that was to open each one and retype it — so people either
 * spent twenty minutes on it or shipped a report naming a host that no longer exists.
 *
 * There is a precedent for this shape of operation and it is worth following closely.
 * `media.service.js` repoints every reference to one screenshot across a whole engagement, and it
 * argues that a *rewrite of references* beats overwriting the thing itself. The same instinct
 * applies here, and it draws a line that matters more than anything else in this file:
 *
 * ## What it will not touch, and why
 *
 * **Tool output.** Never. The output is what the tool printed; rewriting a hostname inside it does
 * not correct a record, it falsifies one. A report whose appendix has been quietly edited to agree
 * with its prose is worse than a report whose prose is out of date, because the second is a mistake
 * and the first is a lie. `enumeration-notes.service.js` already treats output as immutable enough
 * to reconcile notes against rather than move them.
 *
 * **Commands.** Same argument, one step weaker: a command is *"the exact invocation, so somebody can
 * run it again and get the same answer"*, and the answer it produced is in the output beside it.
 *
 * **The scope list.** Structured data with its own editor, its own statuses and its own history. A
 * host is renamed there, deliberately, once — not as a side effect of tidying prose.
 *
 * **Anything inside a tag.** Replacement happens in the text between tags and nowhere else, so a
 * needle that happens to occur in a `src`, a `class` or an attribute name cannot corrupt the markup
 * or repoint a stored image. The visible consequence is that link *text* changes and link *targets*
 * do not, which the preview makes plain by counting only what it will actually change.
 *
 * ## Why a preview, and why it is the only safety
 *
 * Deleting a row is undoable in this app because `remember()` can hold a subdocument. A text
 * substitution across forty fields is not that shape: the undo would be a second substitution,
 * which is not the same thing when the replacement text already occurred somewhere. So instead of
 * pretending it is reversible, this is honest about being a commitment — you see every hit, in
 * context, with its field named, before anything is written.
 */
import { htmlToPlainText } from './ooxml/html-parser.js';

/** Prose fields on a finding, in the order the report prints them. */
export const FINDING_FIELDS = ['description', 'scope', 'poc', 'observation', 'remediation'];

/** How much of the line to show either side of a hit. Enough to recognise, not enough to read. */
const CONTEXT = 60;

/** Literal, not a pattern: somebody renaming `api.acme.example` did not write a regex. */
const literal = (needle, matchCase) =>
  new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');

/**
 * Replaces inside the text between tags, and nowhere else.
 *
 * The OOXML layer has an HTML parser and no writer — see `figures.service.js` on why that means
 * string surgery rather than a round trip. This is the narrowest possible version of it: every tag
 * is passed through byte for byte, and only the runs of text between them are considered.
 */
export function replaceInHtml(html, regex, replacement) {
  let count = 0;
  const out = String(html ?? '').replace(/<[^>]*>|[^<]+/g, (chunk) => {
    if (chunk.startsWith('<')) return chunk;
    return chunk.replace(regex, () => {
      count += 1;
      return replacement;
    });
  });
  return { text: out, count };
}

/** The same, for a field that is plain text — a title, a one-line summary. */
export function replaceInText(value, regex, replacement) {
  let count = 0;
  const out = String(value ?? '').replace(regex, () => {
    count += 1;
    return replacement;
  });
  return { text: out, count };
}

/** One hit, with enough either side of it to be recognised. */
function excerpts(value, needle, matchCase, isHtml) {
  const plain = isHtml ? htmlToPlainText(String(value ?? '')) : String(value ?? '');
  const hay = matchCase ? plain : plain.toLowerCase();
  const pin = matchCase ? needle : needle.toLowerCase();
  const found = [];
  let at = hay.indexOf(pin);
  while (at !== -1 && found.length < 3) {
    const from = Math.max(0, at - CONTEXT);
    const to = Math.min(plain.length, at + pin.length + CONTEXT);
    found.push(
      `${from > 0 ? '…' : ''}${plain.slice(from, to).replace(/\s+/g, ' ').trim()}${
        to < plain.length ? '…' : ''
      }`
    );
    at = hay.indexOf(pin, at + pin.length);
  }
  return found;
}

/**
 * Every place in the engagement that carries the needle, and what it would become.
 *
 * @param {object} audit a loaded engagement document
 * @param {Array<{step: object, content: string}>} bodies enumeration write-ups, already fetched —
 *   the tool output beside them is deliberately not passed in
 * @param {{find: string, matchCase?: boolean}} options
 */
export function findEverywhere(audit, bodies, { find, matchCase = true }) {
  const regex = literal(find, matchCase);
  const hits = [];

  const add = (where, label, value, isHtml, extra = {}) => {
    const { count } = isHtml
      ? replaceInHtml(value, new RegExp(regex.source, regex.flags), '')
      : replaceInText(value, new RegExp(regex.source, regex.flags), '');
    if (!count) return;
    hits.push({ where, label, count, excerpts: excerpts(value, find, matchCase, isHtml), ...extra });
  };

  for (const finding of audit.findings ?? []) {
    const name = `${finding.identifier ? `#${finding.identifier} ` : ''}${finding.title || 'Untitled finding'}`;
    add('finding.title', `${name} — title`, finding.title, false, { findingId: String(finding._id) });
    for (const field of FINDING_FIELDS) {
      add(`finding.${field}`, `${name} — ${field}`, finding[field], true, {
        findingId: String(finding._id),
      });
    }
  }

  for (const section of audit.sections ?? []) {
    add('section.text', `${section.name || section.field} — section`, section.text, true, {
      sectionId: String(section._id),
    });
  }

  for (const note of audit.notes ?? []) {
    add('note.content', `${note.title || 'A note'} — note`, note.content, true, {
      noteId: String(note._id),
    });
  }

  for (const step of audit.enumeration ?? []) {
    const name = step.title || 'Untitled step';
    add('step.title', `${name} — step title`, step.title, false, { stepId: String(step._id) });
    add('step.summary', `${name} — one-line summary`, step.summary, false, {
      stepId: String(step._id),
    });
  }

  for (const { step, content } of bodies) {
    add('step.content', `${step?.title || 'Untitled step'} — write-up`, content, true, {
      stepId: String(step?._id ?? ''),
    });
  }

  return { hits, total: hits.reduce((sum, hit) => sum + hit.count, 0) };
}

/**
 * Does it, in place, on the loaded document — the caller saves.
 *
 * Findings somebody else holds are skipped rather than refused: on the last afternoon of a test
 * one locked finding must not stop the other thirty-nine being corrected, and a rename that
 * silently ignored the lock would write over exactly the paragraph the lock exists to protect.
 * The skipped ones come back by name so the person can go and ask.
 *
 * @returns {{changed: number, skipped: string[], bodies: Array<{step: string, content: string}>}}
 */
export function replaceEverywhere(audit, bodies, { find, replace, matchCase = true, user, holder }) {
  const regex = () => literal(find, matchCase);
  let changed = 0;
  const skipped = [];
  const touchedBodies = [];

  const swap = (target, field, isHtml) => {
    const worker = isHtml ? replaceInHtml : replaceInText;
    const { text, count } = worker(target[field], regex(), replace);
    if (!count) return 0;
    target[field] = text;
    changed += count;
    return count;
  };

  for (const finding of audit.findings ?? []) {
    const heldByAnotherPerson =
      finding.lockedBy && String(finding.lockedBy?._id ?? finding.lockedBy) !== String(user._id);
    if (heldByAnotherPerson) {
      const wouldChange =
        replaceInText(finding.title, regex(), replace).count ||
        FINDING_FIELDS.some((field) => replaceInHtml(finding[field], regex(), replace).count);
      if (wouldChange) skipped.push(finding.title || 'Untitled finding');
      continue;
    }

    let touched = swap(finding, 'title', false);
    for (const field of FINDING_FIELDS) touched += swap(finding, field, true);
    if (touched) finding.updatedBy = user._id;
  }

  for (const section of audit.sections ?? []) swap(section, 'text', true);
  for (const note of audit.notes ?? []) swap(note, 'content', true);
  for (const step of audit.enumeration ?? []) {
    const touched = swap(step, 'title', false) + swap(step, 'summary', false);
    if (touched) step.updatedBy = user._id;
  }

  for (const { step, content } of bodies) {
    const { text, count } = replaceInHtml(content, regex(), replace);
    if (!count) continue;
    changed += count;
    touchedBodies.push({ step: String(step?._id ?? ''), content: text });
  }

  void holder;
  return { changed, skipped, bodies: touchedBodies };
}

export default { findEverywhere, replaceEverywhere, replaceInHtml, replaceInText, FINDING_FIELDS };
