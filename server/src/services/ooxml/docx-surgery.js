/**
 * Surgery on `word/document.xml`.
 *
 * Word does not store a visible string as one thing. "05.08.2025" can be four consecutive runs,
 * because a spell-check state or a revision id changed halfway through — so "replace this
 * sentence with a tag" means: find the run of runs whose combined text matches, put the
 * replacement in the first, and blank the rest. Getting that wrong produces a document that
 * opens fine and prints a tag as literal text, which is the failure nobody notices until a
 * client already has the report.
 *
 * Extracted so the tagging scripts share one copy. They tag different documents — one marked up
 * with yellow highlight, one written to a house style — but the mechanics of cutting into OOXML
 * are the same, and the copy that lives in only one of them is the copy that is subtly wrong in
 * the other.
 */

const RUN_RE = /<w:r\b(?![a-zA-Z])[^>]*>[\s\S]*?<\/w:r>/g;
const TEXT_RE = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const decodeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Visible text of an XML fragment. */
const textOf = (fragment) =>
  decodeXml([...fragment.matchAll(TEXT_RE)].map((m) => m[2]).join(''));

/** Replaces a run's text content, keeping its formatting. */
function setRunText(runXml, value) {
  let first = true;
  return runXml.replace(TEXT_RE, (whole, open, _body, close) => {
    if (!first) return `${open}${close}`;
    first = false;
    const openTag = open.includes('xml:space') ? open : open.replace('>', ' xml:space="preserve">');
    return `${openTag}${escapeXml(value)}${close}`;
  });
}

/** Strips highlight shading, so placeholders do not render highlighted. */
const dropHighlight = (xml) => xml.replace(/<w:highlight w:val="[^"]*"\s*\/>/g, '');

/** Splits a fragment into top-level paragraphs and tables, in document order. */
function splitBlocks(xml) {
  const blocks = [];
  const re = /<w:(p|tbl)\b(?![a-zA-Z])[^>]*(?:\/>|>[\s\S]*?<\/w:\1>)/g;
  let match;
  let cursor = 0;
  while ((match = re.exec(xml))) {
    if (match.index > cursor) blocks.push({ kind: 'raw', xml: xml.slice(cursor, match.index) });
    blocks.push({ kind: match[1], xml: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < xml.length) blocks.push({ kind: 'raw', xml: xml.slice(cursor) });
  return blocks;
}

const joinBlocks = (blocks) => blocks.map((b) => b.xml).join('');

const PARA_RE = /<w:p\b(?![a-zA-Z])[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g;

/**
 * Visits every paragraph in a fragment, including those nested inside tables —
 * `splitBlocks` only sees top level, and most of this template's fill-in values
 * live in table cells.
 *
 * `fn` returns replacement XML, or null/undefined to leave the paragraph alone.
 */
function eachParagraph(xml, fn) {
  let count = 0;
  const out = xml.replace(PARA_RE, (paragraph) => {
    const replaced = fn(paragraph, textOf(paragraph));
    if (replaced == null || replaced === paragraph) return paragraph;
    count += 1;
    return replaced;
  });
  return { xml: out, count };
}

/**
 * Replaces `needle` inside a paragraph, coping with the two ways Word stores it:
 *
 *  1. spread over consecutive runs whose combined text equals it exactly
 *     ("05" + "." + "08" + ".2025"), or
 *  2. embedded in a longer run ("IP 10.202.6.148").
 *
 * Returns the rewritten paragraph, or null when the text is not present.
 */
function replaceAcrossRuns(paragraphXml, needle, replacement) {
  const runs = [];
  let match;
  RUN_RE.lastIndex = 0;
  while ((match = RUN_RE.exec(paragraphXml))) {
    runs.push({ xml: match[0], start: match.index, end: match.index + match[0].length });
  }
  if (!runs.length) return null;

  const texts = runs.map((r) => textOf(r.xml));

  /*
   * A run with no text cannot be where the needle starts, so it must not be where the
   * replacement is written either.
   *
   * It is not a hypothetical empty run: an earlier replacement in the same paragraph leaves one
   * behind. Anchoring on it moves the new text *before* whatever that run carried besides text —
   * and what a blanked run usually still carries is the `<w:br/>` that ended the line. The
   * counters page read "TOTAL FIXED VULNERABILITIES: 1TOTAL VULNERABILITIES RETESTING: 1" on one
   * line, with the break left dangling at the end, for exactly this reason.
   */
  const anchors = (index) => texts[index] !== '';

  for (let start = 0; start < runs.length; start += 1) {
    if (!anchors(start)) continue;
    let combined = '';
    for (let end = start; end < runs.length; end += 1) {
      combined += texts[end];
      if (combined === needle) {
        const head = dropHighlight(setRunText(runs[start].xml, replacement));
        const tail = runs
          .slice(start + 1, end + 1)
          .map((r) => dropHighlight(setRunText(r.xml, '')))
          .join('');
        return (
          paragraphXml.slice(0, runs[start].start) +
          head +
          tail +
          paragraphXml.slice(runs[end].end)
        );
      }
      // Overshot — this starting point cannot match.
      if (combined.length > needle.length) break;
    }
  }

  // Second: the needle lives inside a single, longer run.
  for (let i = 0; i < runs.length; i += 1) {
    if (!texts[i].includes(needle)) continue;
    const rewritten = dropHighlight(
      setRunText(runs[i].xml, texts[i].replace(needle, replacement))
    );
    return paragraphXml.slice(0, runs[i].start) + rewritten + paragraphXml.slice(runs[i].end);
  }

  /*
   * Third: it straddles run boundaries without aligning to them.
   *
   * This is the common case in a document somebody has actually edited, and the two above miss
   * it. "…on the web application and the IP 10.202.6.148 of CLIENT" is stored as one run ending
   * "…on the web application", then " and the ", then "IP 10.202.6.148", then " of ", then
   * "CLIENT" — so a needle starting mid-run and ending at a boundary matches neither an exact
   * concatenation nor a single run, and the caller is left writing needles that describe Word's
   * arbitrary run splits rather than the sentence they can see.
   *
   * Whatever sat before the needle in the middle runs moves into the first run's formatting, and
   * whatever sat after it into the last run's. That is the same trade the single-run case already
   * makes, and in practice those fragments are the spaces either side of the phrase.
   */
  for (let start = 0; start < runs.length; start += 1) {
    if (!anchors(start)) continue;
    let combined = '';
    for (let end = start; end < runs.length; end += 1) {
      combined += texts[end];
      const at = combined.indexOf(needle);
      if (at === -1) continue;

      const head = combined.slice(0, at) + replacement;
      const tail = combined.slice(at + needle.length);
      const parts = [dropHighlight(setRunText(runs[start].xml, head))];
      for (let i = start + 1; i < end; i += 1) parts.push(dropHighlight(setRunText(runs[i].xml, '')));
      if (end > start) parts.push(dropHighlight(setRunText(runs[end].xml, tail)));
      else if (tail) {
        // One run held the lot, which the case above would have caught; keep the tail anyway.
        parts[0] = dropHighlight(setRunText(runs[start].xml, head + tail));
      }

      return (
        paragraphXml.slice(0, runs[start].start) + parts.join('') + paragraphXml.slice(runs[end].end)
      );
    }
  }

  return null;
}

/** Replaces the entire visible text of a paragraph with one value. */
function setParagraphText(paragraphXml, value) {
  const runs = [];
  let match;
  RUN_RE.lastIndex = 0;
  while ((match = RUN_RE.exec(paragraphXml))) runs.push(match[0]);
  if (!runs.length) return null;

  let done = false;
  return paragraphXml.replace(RUN_RE, (runXml) => {
    if (done) return dropHighlight(setRunText(runXml, ''));
    done = true;
    return dropHighlight(setRunText(runXml, value));
  });
}

/** A bare paragraph carrying just a control tag; disappears when rendered. */
const controlParagraph = (tag) =>
  `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(tag)}</w:t></w:r></w:p>`;

export {
  RUN_RE,
  TEXT_RE,
  escapeXml,
  decodeXml,
  textOf,
  setRunText,
  dropHighlight,
  splitBlocks,
  joinBlocks,
  PARA_RE,
  eachParagraph,
  replaceAcrossRuns,
  setParagraphText,
  controlParagraph,
};
