/**
 * The engagement, shaped for the browser.
 *
 * `GET /audits/:id` used to answer with `audit.toObject()`: every finding's description, impact,
 * remediation and proof of concept, every note's body, and the whole enumeration tree — on every
 * page load, and again after most saves, to render a tab bar. On a real engagement that is
 * megabytes crossing the wire so that a list can show forty titles.
 *
 * The pattern here is not new to this codebase. An enumeration row already carries `outputPreview`
 * rather than its output, and the reason written beside it is exactly this one: *"the alternative
 * was sending 1.44MB so that a text box could search it"*. This applies the same rule to the
 * engagement itself.
 *
 * What a caller loses and what it gets back:
 *
 *   - a finding keeps everything short — title, rating, status, assets, timestamps — and trades its
 *     four HTML bodies for `snippet`, four `has*` flags and `searchText`
 *   - a note keeps its title and trades its body for the same two
 *   - the enumeration is dropped entirely, because the tab that draws it fetches its own, and only
 *     the count was ever read from here
 *
 * `?full=1` opts out of all of it, and one finding in full is a route of its own. Nothing here
 * changes what the server itself works with: `loadAudit` still returns the whole document, and the
 * report, preflight and every other reader are untouched.
 */
import { htmlHasContent, htmlToPlainText } from './ooxml/html-parser.js';

/** The fields a finding writes prose into. */
export const FINDING_BODIES = ['description', 'observation', 'remediation', 'poc'];

/**
 * How much text goes with a record so that searching still works without it.
 *
 * Two thousand characters is about a screenful of prose per finding: enough that the in-engagement
 * search finds a hostname somebody mentioned in a proof of concept, and small enough that a hundred
 * findings cost a couple of hundred kilobytes rather than tens of megabytes. A search that misses
 * something on the fourth page of a write-up is a fair trade for a page that loads.
 */
const SEARCH_LIMIT = 2000;
const SNIPPET_LIMIT = 200;

const plain = (html) => htmlToPlainText(html ?? '').replace(/\s+/g, ' ').trim();

const summarise = (values) => {
  const text = values.map((value) => plain(value)).filter(Boolean).join(' · ');
  return text.length > SEARCH_LIMIT ? `${text.slice(0, SEARCH_LIMIT)}…` : text;
};

/** One finding, without its prose but still answering everything a list asks. */
export function lightFinding(finding) {
  const row = { ...finding };
  const bodies = FINDING_BODIES.map((field) => finding[field] ?? '');

  for (const field of FINDING_BODIES) {
    delete row[field];
    /*
     * `htmlHasContent` rather than a length check, because a proof of concept that is one
     * screenshot has no text in it at all — and a list that called that finding empty would be
     * telling somebody their evidence is missing.
     */
    row[`has${field[0].toUpperCase()}${field.slice(1)}`] = htmlHasContent(finding[field]);
  }

  const description = plain(finding.description);
  row.snippet =
    description.length > SNIPPET_LIMIT ? `${description.slice(0, SNIPPET_LIMIT)}…` : description;
  row.searchText = summarise(bodies);
  return row;
}

/** One note, the same way. */
export function lightNote(note) {
  const row = { ...note };
  delete row.content;
  const text = plain(note.content);
  row.snippet = text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text;
  row.searchText = summarise([note.content ?? '']);
  row.hasContent = htmlHasContent(note.content);
  return row;
}

/**
 * The whole engagement, lightened.
 *
 * @param {object} audit a plain object — `toObject()` has already been called
 * @returns {object} the same shape, minus the bodies, plus the counts a caller used to derive
 */
export function lightenAudit(audit) {
  const out = { ...audit };
  out.findings = (audit.findings ?? []).map(lightFinding);
  out.notes = (audit.notes ?? []).map(lightNote);

  /*
   * The tree goes entirely. The Enumeration tab has its own endpoint and always did; the only
   * thing ever read from this copy was whether it was empty, so that is what is left behind.
   */
  out.enumerationCount = (audit.enumeration ?? []).length;
  delete out.enumeration;

  return out;
}

export default { lightenAudit, lightFinding, lightNote, FINDING_BODIES };
