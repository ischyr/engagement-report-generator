/**
 * One finding, one page.
 *
 * A house style that starts every finding at the top of a page is common enough to be a setting
 * rather than a template edit — but it *is* a template edit, because only the template knows where
 * a finding begins. The heading is `{{ .id }} — {{ .title }}` inside the findings loop, drawn by
 * whichever .docx the engagement points at; nothing in the data or in the finished file marks the
 * boundary between one finding and the next.
 *
 * So this runs on the template, before docxtemplater fills it: find the paragraph the findings loop
 * repeats first, and set `pageBreakBefore` on it. Every iteration is a copy of that paragraph, so
 * every finding gets the break, and the template author has to do nothing.
 *
 * ## Why `pageBreakBefore` and not a page break
 *
 * A break character — what `{{@$pageBreakExceptLast}}` inserts — is a thing in the text, so it
 * needs a rule about the last one or the report ends on a blank page. `pageBreakBefore` is a
 * property of the paragraph: Word starts a new page *if the paragraph is not already at the top of
 * one*, which is the actual requirement, and it costs nothing at the end of the run. It is also
 * what somebody would do by hand — the checkbox on Heading 2's paragraph settings.
 *
 * ## Which loop
 *
 * A report template usually has two `{{#findings}}` loops: a row in the summary table near the
 * front, and the write-ups themselves. Breaking the page on the summary row would put each line of
 * a table on its own page, so loops inside a `<w:tbl>` are skipped, and of whatever is left the
 * longest body wins — a summary loop is a row, a write-up loop is a chapter.
 *
 * ## When it cannot
 *
 * It says so rather than guessing. A template with no findings loop, or one whose loop body opens
 * with a table instead of a paragraph, is left exactly as it was: a page break inside the first
 * cell of a table is not what anybody meant, and a document quietly rearranged is worse than a
 * setting that reports it did nothing.
 */

import { PARA_RE, textOf } from './docx-surgery.js';

/** The loop markers, tolerant of the spaces Word's own editing leaves inside a tag. */
const OPEN = /\{\{\s*#\s*findings\s*\}\}/;
const CLOSE = /\{\{\s*\/\s*findings\s*\}\}/;

/**
 * The only three properties that may precede `pageBreakBefore` inside `<w:pPr>`.
 *
 * Word validates paragraph properties against an ordered sequence and refuses to open a document
 * whose children are shuffled, so the insertion point is found rather than assumed. `smoke-test.js`
 * checks the whole order on a rendered document, which is what catches this being wrong.
 */
const PRECEDES = ['pStyle', 'keepNext', 'keepLines'];

const PAGE_BREAK_BEFORE = /<w:pageBreakBefore(?:\s[^>]*)?\/>/;

/**
 * Every paragraph in the part, in document order, with where it sits.
 *
 * Its own copy of the pattern: `PARA_RE` is a shared global regex, and a borrowed `lastIndex`
 * would silently start the scan halfway down somebody else's document.
 */
function paragraphsOf(xml) {
  const out = [];
  for (const match of xml.matchAll(new RegExp(PARA_RE.source, 'g'))) {
    out.push({
      xml: match[0],
      text: textOf(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

/** Whether an offset falls inside a table — an unbalanced `<w:tbl>` behind it. */
function insideTable(xml, offset) {
  const before = xml.slice(0, offset);
  const opened = (before.match(/<w:tbl>/g) ?? []).length;
  const closed = (before.match(/<\/w:tbl>/g) ?? []).length;
  return opened > closed;
}

/**
 * The same paragraph with `pageBreakBefore` set, or null if its markup is not a shape we can edit.
 *
 * A paragraph that already has the property is normalised rather than given a second one:
 * `<w:pageBreakBefore w:val="0"/>` is Word's way of writing "explicitly off", and a template that
 * says so while the setting says otherwise should follow the setting.
 */
export function withPageBreakBefore(paragraph) {
  if (PAGE_BREAK_BEFORE.test(paragraph)) {
    return paragraph.replace(PAGE_BREAK_BEFORE, '<w:pageBreakBefore/>');
  }

  /* `<w:p/>` — an empty paragraph, which has no properties yet and no content either. */
  const empty = /^<w:p(\s[^>]*?)?\/>$/.exec(paragraph);
  if (empty) return `<w:p${empty[1] ?? ''}><w:pPr><w:pageBreakBefore/></w:pPr></w:p>`;

  /* `<w:pPr/>` before `<w:pPr>`: the self-closing form would not match the open-tag pattern. */
  const emptyProps = /<w:pPr(?:\s[^>]*?)?\/>/.exec(paragraph);
  if (emptyProps) {
    return paragraph.replace(emptyProps[0], '<w:pPr><w:pageBreakBefore/></w:pPr>');
  }

  const props = /<w:pPr(?:\s[^>]*)?>/.exec(paragraph);
  if (!props) {
    const open = /^<w:p(?:\s[^>]*)?>/.exec(paragraph);
    if (!open) return null;
    return `${open[0]}<w:pPr><w:pageBreakBefore/></w:pPr>${paragraph.slice(open[0].length)}`;
  }

  const bodyStart = props.index + props[0].length;
  const bodyEnd = paragraph.indexOf('</w:pPr>', bodyStart);
  if (bodyEnd === -1) return null;

  const body = paragraph.slice(bodyStart, bodyEnd);
  let insertAt = 0;
  for (const name of PRECEDES) {
    const element = new RegExp(`<w:${name}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</w:${name}>)`).exec(body);
    if (element) insertAt = Math.max(insertAt, element.index + element[0].length);
  }

  const cut = bodyStart + insertAt;
  return `${paragraph.slice(0, cut)}<w:pageBreakBefore/>${paragraph.slice(cut)}`;
}

/**
 * Marks the first paragraph of the findings loop so each finding starts a page.
 *
 * Returns the part — rewritten if it could be, unchanged if it could not — and a reason when it
 * could not, for the caller to report. Never throws: a setting about layout must not be the thing
 * that stops a report being produced.
 *
 * @param {string} xml `word/document.xml`
 * @returns {{ xml: string, applied: boolean, reason?: string }}
 */
export function startFindingsOnNewPage(xml) {
  const source = String(xml ?? '');
  const paragraphs = paragraphsOf(source);

  const candidates = [];
  let loopsSeen = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (!OPEN.test(paragraphs[i].text)) continue;
    loopsSeen += 1;
    if (insideTable(source, paragraphs[i].start)) continue;
    /* `{{#findings}}…{{/findings}}` opened and closed in one paragraph is a sentence listing the
     * ids, not a chapter. Breaking the page on it would be absurd, and it must not win the pick. */
    if (CLOSE.test(paragraphs[i].text)) continue;

    /* How much of the document this loop repeats — the measure that tells a summary row from a
     * chapter. An unclosed loop counts to the end; docxtemplater will complain about it anyway. */
    let body = paragraphs.length - i;
    for (let j = i + 1; j < paragraphs.length; j += 1) {
      if (CLOSE.test(paragraphs[j].text)) {
        body = j - i;
        break;
      }
    }
    candidates.push({ index: i, body });
  }

  if (candidates.length === 0) {
    return {
      xml: source,
      applied: false,
      reason: loopsSeen
        ? "the template's findings loops are table rows or single paragraphs, so there is no write-up to break the page on"
        : 'the template has no findings loop',
    };
  }

  const loop = candidates.sort((a, b) => b.body - a.body)[0];
  const opener = paragraphs[loop.index];

  /*
   * Where the repeat actually starts.
   *
   * `paragraphLoop` drops a paragraph that holds nothing but the marker, so the first thing
   * repeated is the paragraph after it — normally the finding's heading. A marker sharing a
   * paragraph with real text repeats that paragraph itself.
   */
  const aloneInParagraph = opener.text.replace(OPEN, '').trim() === '';
  const target = aloneInParagraph ? paragraphs[loop.index + 1] : opener;

  if (!target) {
    return { xml: source, applied: false, reason: 'the findings loop has nothing in it' };
  }
  if (aloneInParagraph && source.slice(opener.end, target.start).includes('<w:tbl>')) {
    return {
      xml: source,
      applied: false,
      reason: 'the findings loop opens with a table, and the break would land inside its first cell',
    };
  }

  const replaced = withPageBreakBefore(target.xml);
  if (!replaced) {
    return { xml: source, applied: false, reason: 'the first paragraph of the findings loop could not be read' };
  }

  return {
    xml: source.slice(0, target.start) + replaced + source.slice(target.end),
    applied: true,
  };
}

export default startFindingsOnNewPage;
