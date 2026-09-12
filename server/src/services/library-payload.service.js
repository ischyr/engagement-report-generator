/**
 * The vulnerability library, shaped for a list.
 *
 * `GET /vulnerabilities` answered with every entry in full: each locale's description, impact and
 * remediation, as stored, with whatever screenshots are in them — up to two thousand entries of it,
 * to draw a table of titles. Three callers did that: the library page, the picker inside a
 * finding, and the dashboard, which fetched the whole library to render the number of entries in
 * it.
 *
 * The rule is the one `audit-payload.service.js` and the enumeration tree already follow: a list
 * carries what it draws, and the bodies are fetched one at a time by whoever opens one. The
 * difference here is where the summary is computed.
 *
 * **The snippet is stored, not derived per request.** Summarising a 500-entry library — two
 * locales, three bodies each — measured at 1.18 seconds of CPU, because turning HTML into text is
 * a parse per field and there are three thousand of them. Doing that on every page load would
 * trade bytes on the wire for a second of server time, which is not a trade. So it is written
 * once, when the entry is written, exactly as an enumeration step stores `outputPreview` rather
 * than making the tree derive it from output it deliberately does not send.
 *
 * That means the bodies never leave Mongo for a list: `LIST_PROJECTION` excludes them, so the
 * 9.88MB measured for that same library is read by nobody.
 */

import { htmlToPlainText } from './ooxml/html-parser.js';

/** The fields a library entry writes prose into, per locale. */
export const LIBRARY_BODIES = ['description', 'observation', 'remediation'];

/**
 * How much of a description goes with a row.
 *
 * Two hundred characters, the same as a finding's snippet in `audit-payload.service.js`, because
 * it is drawn in the same place for the same reason: one truncated line under the title.
 */
export const SNIPPET_LIMIT = 200;

/** The stored bodies, excluded. Custom field values go too — only the editor reads them. */
export const LIST_PROJECTION = LIBRARY_BODIES.map((field) => `-details.${field}`)
  .concat('-details.customFields')
  .join(' ');

/** One description as a line of text. */
export function snippetOf(html) {
  const text = htmlToPlainText(html ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text;
}

/**
 * An entry on its way into the database, with each locale's snippet filled in.
 *
 * Applied at every write rather than in a `pre('save')` hook: the routes create, update, import
 * and bulk-update, and only two of those go through `save`. One function called at four call
 * sites in one file is greppable; four hooks, two of which have to unpick a `$set`, are not.
 * `library-test.js` asserts the result of every one of those paths, which is what stops the fifth
 * writer from forgetting.
 */
export function withSnippets(entry) {
  if (!entry || !Array.isArray(entry.details)) return entry;
  return {
    ...entry,
    details: entry.details.map((detail) => ({
      ...detail,
      snippet: snippetOf(detail?.description),
    })),
  };
}

export default { withSnippets, snippetOf, LIST_PROJECTION, LIBRARY_BODIES, SNIPPET_LIMIT };
