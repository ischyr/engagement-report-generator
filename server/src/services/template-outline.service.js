/**
 * A template as a readable map of where its placeholders are.
 *
 * The Test render dialog answers "did every tag resolve?" — a flat list of names and verdicts.
 * What it cannot answer is the question you actually have while writing a template: *where* is
 * that tag, what surrounds it, and which loop is it in? A name and a scope path is not enough to
 * find `{{ .title }}` in a 441-paragraph document that uses it four times.
 *
 * So this walks the document in reading order and returns the paragraphs that contain placeholders,
 * each split into plain text and tags, with the verdict attached to every occurrence. That is
 * enough for a page to show the template with its tags highlighted in place, and for clicking one
 * to say what it resolved to.
 *
 * Only paragraphs that contain a tag come back. A preview of every paragraph would be the document,
 * and the document is what Word is for — the point here is the tags and just enough of their
 * surroundings to recognise them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

import env from '../config/env.js';
import { eachTag, stepScope } from './tag-scan.js';
import { knownTagRoots, TAG_REFERENCE } from './tag-reference.js';

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* -------------------------------------------------------------------------- */

/** Every tag the reference documents, dotted paths included. */
function documentedTags() {
  const groups = [...(TAG_REFERENCE.groups ?? []), ...(TAG_REFERENCE.proposalGroups ?? [])];
  const names = new Set();
  for (const group of groups) for (const entry of group.tags ?? []) names.add(entry.tag);
  for (const root of knownTagRoots()) names.add(root);
  return [...names];
}

/** Levenshtein, bounded by nothing clever — the candidate list is a few hundred short strings. */
function distance(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/**
 * "Did you mean" for a tag nothing recognises.
 *
 * Compared on the whole dotted path *and* on the last segment, because the two mistakes look
 * different: `stats.totl` is close to `stats.total` as a whole, while `finding.cvssScore` is only
 * close to `cvssScore` at the end. Anything further than a third of the name away is not a
 * suggestion, it is a coincidence.
 *
 * The whole path wins, though, which is what the penalty on the leaf match is for. Scored purely on
 * the last segment, `clietn.email` is an equally good match for `email`, `firm.email` and
 * `owner.email` — and the shortest of those won, so the one obvious answer came third.
 */
const LEAF_PENALTY = 3;

export function suggestTags(tag, candidates = documentedTags()) {
  const name = String(tag ?? '');
  if (!name) return [];
  const leaf = name.split('.').at(-1);
  /*
   * The threshold ignores the penalty on purpose. Adding it in let `xyzzy` reach `year` and
   * `nonsense` reach `noise` — a wrong suggestion is worse than none, because it sends somebody
   * looking for a field that has nothing to do with what they typed.
   */
  const limit = Math.max(2, Math.ceil(name.length / 3));

  return candidates
    .map((candidate) => ({
      candidate,
      score: Math.min(
        distance(name, candidate),
        distance(leaf, candidate.split('.').at(-1)) + LEAF_PENALTY
      ),
    }))
    .filter((row) => row.score <= limit && row.candidate !== name)
    .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
    .slice(0, 3)
    .map((row) => row.candidate);
}

/* -------------------------------------------------------------------------- */
/* Reading the document                                                       */
/* -------------------------------------------------------------------------- */

const PARAGRAPH_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;
const HEADING_RE = /<w:pStyle w:val="(Heading[1-9]|Title|Subtitle)"\/>/;

const decodeXml = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * What a paragraph reads as.
 *
 * All markup stripped, which is also what makes a tag Word has split across runs come back
 * whole — the same trick the tag extractor uses. Tabs and breaks become spaces so two words
 * either side of one do not run together.
 */
const paragraphText = (xml) =>
  decodeXml(
    xml
      .replace(/<w:tab\s*\/?>/g, ' ')
      .replace(/<w:br\s*\/?>/g, ' ')
      .replace(/<[^>]*>/g, '')
  ).replace(/\s+/g, ' ');

/** Parts in reading order, named as a person would refer to them. */
function partsOf(zip) {
  const named = (name) => {
    if (name === 'word/document.xml') return { label: 'Document body', order: 0 };
    const header = /^word\/header(\d*)\.xml$/.exec(name);
    if (header) return { label: `Header ${header[1] || '1'}`, order: 1 };
    const footer = /^word\/footer(\d*)\.xml$/.exec(name);
    if (footer) return { label: `Footer ${footer[1] || '1'}`, order: 2 };
    if (name === 'word/footnotes.xml') return { label: 'Footnotes', order: 3 };
    if (name === 'word/endnotes.xml') return { label: 'Endnotes', order: 4 };
    return null;
  };

  return Object.keys(zip.files)
    .map((name) => ({ name, ...(named(name) ?? {}) }))
    .filter((part) => part.label)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * Whether a position sits inside a table, by counting the openings before it.
 *
 * Nesting is why this counts rather than matching ranges: a table inside a table cell would make
 * a non-greedy range end in the wrong place, and the answer here only has to be "yes or no".
 */
function insideTable(xml, position) {
  const before = xml.slice(0, position);
  const opens = (before.match(/<w:tbl[ >]/g) ?? []).length;
  const closes = (before.match(/<\/w:tbl>/g) ?? []).length;
  return opens > closes;
}

/* -------------------------------------------------------------------------- */
/* The outline                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Splits one block of text into plain runs and tags, stepping the loop stack as it goes.
 *
 * `stack` is carried across blocks by the caller, because a loop opens in one paragraph and closes
 * several paragraphs later — the whole reason a tag's scope is worth showing.
 */
function segmentsOf(text, stack, verdictFor) {
  const segments = [];
  let cursor = 0;

  for (const found of eachTag(text)) {
    if (found.start > cursor) segments.push({ text: text.slice(cursor, found.start) });
    cursor = found.end;

    const step = stepScope(stack, found);
    if (!step) {
      // `{{ }}` with nothing in it: show it as what it is rather than swallowing it.
      segments.push({ text: found.source });
      continue;
    }
    segments.push({
      raw: found.source,
      tag: step.tag,
      kind: step.kind,
      scope: step.scope,
      ...verdictFor(step),
    });
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/**
 * Looks a tag's verdict up in the lint's results.
 *
 * Two fallbacks, both for real cases. A closing tag has no verdict of its own — it is bookkeeping,
 * and marking it "not a tag" would be a lie about a correct template. And a tag written inside its
 * own condition (`{{ phone }}` within `{{#phone}}`) is deliberately only listed once, at the outer
 * scope, so that is where its verdict is.
 */
function verdictLookup(tags) {
  const byKey = new Map();
  for (const entry of tags ?? []) {
    byKey.set(`${entry.where ?? ''}|${entry.tag}`, entry);
  }
  const at = (scope, tag) => byKey.get(`${scope.join(' → ')}|${tag}`);

  return (step) => {
    if (step.kind === 'close') return { status: 'close' };
    const own = at(step.scope, step.tag) ?? at(step.scope.slice(0, -1), step.tag);
    if (!own) return { status: 'unlisted' };
    return {
      status: own.status,
      value: own.value ?? '',
      unverified: Boolean(own.unverified),
      suggestions: own.status === 'unknown' ? suggestTags(step.tag) : undefined,
    };
  };
}

/**
 * The template, as parts and blocks and segments.
 *
 * @param {{template: object, tags?: Array}} input `tags` is the lint's per-tag verdicts.
 */
export async function outlineTemplate({ template, tags = [] }) {
  const verdictFor = verdictLookup(tags);
  const parts = [];

  if (template.kind === 'html') {
    /*
     * Lines, and the markup left in.
     *
     * An HTML template's author reads markup — hiding it would be showing them something other
     * than the file they edit. It also keeps the tag positions honest: a tag inside an attribute
     * (`style="color:#{{ .stats.riskRatingColor }}"`) is a real tag, and stripping tags to make a
     * prettier preview would lose it and disagree with the lint about the scope of everything
     * after it.
     */
    const stack = [];
    const blocks = [];
    String(template.html ?? '')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const segments = segmentsOf(line, stack, verdictFor);
        const depth = stack.length;
        if (!segments.some((segment) => segment.tag)) return;
        blocks.push({ id: `l${index + 1}`, line: index + 1, depth, markup: true, segments });
      });
    parts.push({ id: 'html', label: 'Markup', blocks });
    return { kind: 'html', parts };
  }

  const file = path.join(env.storage.templates, template.filename ?? '');
  const zip = new PizZip(await fs.readFile(file));

  for (const part of partsOf(zip)) {
    const xml = zip.file(part.name)?.asText();
    if (!xml) continue;

    /*
     * A stack per part, not per document. A header is rendered separately from the body, so a
     * loop cannot span the two — and pretending otherwise would put every header tag inside
     * whatever loop the body happened to leave open.
     */
    const stack = [];
    const blocks = [];
    let heading = '';

    for (const match of xml.matchAll(PARAGRAPH_RE)) {
      const text = paragraphText(match[0]).trim();
      const style = HEADING_RE.exec(match[0])?.[1];
      if (style && text && !text.includes('{{')) heading = text;
      if (!text.includes('{{')) continue;

      const depth = stack.length;
      const segments = segmentsOf(text, stack, verdictFor);
      if (!segments.some((segment) => segment.tag)) continue;

      blocks.push({
        id: `${part.name}:${blocks.length}`,
        heading,
        style: style ?? '',
        table: insideTable(xml, match.index),
        depth,
        segments,
      });
    }

    if (blocks.length) parts.push({ id: part.name, label: part.label, blocks });
  }

  return { kind: 'docx', parts };
}

export default outlineTemplate;
