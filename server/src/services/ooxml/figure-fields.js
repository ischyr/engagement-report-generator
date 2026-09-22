/**
 * Numbered figures, and references to them that stay right.
 *
 * A forty-page report with eleven screenshots in it has, until now, eleven captions and no way to
 * point at one. The prose says "the screenshot below", which is true when it is written and false
 * the moment somebody reorders a finding, and a reader who wants to check the evidence for a
 * paragraph on page 12 has to guess which picture it meant.
 *
 * So captions become **Figure 7 — The request**, and the prose can say **Figure 7** and mean it.
 *
 * ## Why this is a pass over the finished document
 *
 * The number depends on document *order*, and nothing on the server knows that order. The template
 * decides it: which sections come first, whether the appendix is at the front, whether the
 * enumeration prints before the findings. The only thing that knows is `word/document.xml` once
 * docxtemplater has finished with it — so that is where the numbers are worked out, after the
 * render and before the package is committed.
 *
 * Everything before that point emits a **token** rather than a number: `@@FIGNUM:name@@` inside the
 * caption's field, `@@FIGREF:name@@` inside the reference's. The pass finds the figure bookmarks in
 * the order they appear, which is document order by definition, and fills the tokens in.
 *
 * ## Why they are Word fields and not just text
 *
 * Because the document is handed to a person who then edits it. A caption that is plain text says
 * "Figure 7" forever, including after they delete figure 3 — and the reference that pointed at it
 * says 7 as well, and now both are wrong in a document with our name on it.
 *
 * A caption carrying a `SEQ Figure` field and a reference carrying `REF` renumber themselves. Word
 * refreshes both when the document opens, which this pipeline already asks for — see
 * `requestFieldUpdate` in `docx-parts.js`. The numbers this pass writes are the *cached* results:
 * what a reader sees before any refresh happens, and what readers that do not evaluate fields at
 * all — LibreOffice in some configurations, Google Docs, a PDF printed by a converter — see
 * permanently. Both halves are needed. Fields alone would show zeros to those readers; text alone
 * would rot in Word.
 */

/** The prefix every figure bookmark carries. Also how the pass finds them, so it is not cosmetic. */
export const FIGURE_BOOKMARK = '_EngyFig_';

/**
 * The same, for tables.
 *
 * Tables were the half of this that never got done. A report's figures have been numbered since
 * this file was written, and its tables — the scope, the affected hosts, the forty rows of a
 * parsed sweep — have sat there unlabelled, so the prose could point at a screenshot and could not
 * point at the table on the facing page.
 *
 * A separate prefix rather than a flag on the same one, because Word keeps `SEQ Figure` and
 * `SEQ Table` as two independent counters and a reader expects the same: Figure 7 and Table 3 can
 * be on the same page, and neither number is wrong. Everything else here — the token, the pass,
 * the cached number beside the live field — is shared, because the problem is identical.
 */
export const TABLE_BOOKMARK = '_EngyTab_';

/** Which counter a caption belongs to, keyed by the prefix its bookmark carries. */
const SEQUENCES = [
  { name: 'Figure', prefix: FIGURE_BOOKMARK },
  { name: 'Table', prefix: TABLE_BOOKMARK },
];

const TOKEN = {
  /** Inside a caption's SEQ field: becomes the number alone. */
  num: (name) => `@@FIGNUM:${name}@@`,
  /** Inside a reference's REF field: becomes "Figure 7". */
  ref: (name) => `@@FIGREF:${name}@@`,
};

/** What a reference to a figure that is no longer in the document says instead. */
export const MISSING_FIGURE = '(figure removed)';

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The opening of a numbered caption: `Figure 7 — `.
 *
 * A bookmark around the label *and* the number, because that pair is what a `REF` field reproduces:
 * bookmark the number alone and every cross-reference in the report reads "as shown in 7".
 *
 * `w:fldSimple` rather than the begin/separate/end run triple. It is the same field to Word, it is
 * a quarter of the XML, and — the reason that matters here — it is one element, so the pass below
 * can match a whole reference with one expression and replace it wholesale when its figure is gone.
 *
 * `separator` is empty for a picture nobody captioned, which is most of them on a real engagement:
 * the caption line then reads "Figure 12" and nothing else, rather than "Figure 12 — " with a dash
 * hanging off the end.
 *
 * `rPr` is the run formatting to put on the label and the number. Empty when the template defines
 * a Caption style, because then the paragraph style carries it — and required when it does not,
 * or "Figure 12" comes out as black body text with an italic grey caption beside it.
 *
 * `sequence` is the counter Word keeps, not the word printed — `label` is the word printed. The two
 * are deliberately separate: a house that calls its pictures "Screenshot" still wants them counted
 * on Word's `Figure` sequence, because that is the sequence a table of figures reads and the one
 * every `REF` in the document already points at.
 *
 * @param {{name:string, id:number, label:string, sequence?:'Figure'|'Table', separator?:string, rPr?:string}} figure
 */
export function captionPrefix({
  name,
  id,
  label = 'Figure',
  sequence = 'Figure',
  separator = ' — ',
  rPr = '',
}) {
  return (
    `<w:bookmarkStart w:id="${id}" w:name="${escapeXml(name)}"/>` +
    `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(label)} </w:t></w:r>` +
    `<w:fldSimple w:instr=" SEQ ${sequence === 'Table' ? 'Table' : 'Figure'} \\* ARABIC ">` +
    `<w:r>${rPr}<w:t>${TOKEN.num(name)}</w:t></w:r>` +
    '</w:fldSimple>' +
    `<w:bookmarkEnd w:id="${id}"/>` +
    (separator ? `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(separator)}</w:t></w:r>` : '')
  );
}

/**
 * A reference in the prose, as a field pointing at a caption's bookmark.
 *
 * `\h` makes it a hyperlink, so a reader can click "Figure 7" and land on it — which is most of
 * the point in a document nobody prints any more.
 */
export function referenceField(name) {
  return (
    `<w:fldSimple w:instr=" REF ${escapeXml(name)} \\h ">` +
    `<w:r><w:t>${TOKEN.ref(name)}</w:t></w:r>` +
    '</w:fldSimple>'
  );
}

/**
 * The placeholder a template's "list of figures" leaves behind, filled by the pass below.
 *
 * One paragraph, because that is what a rawxml tag replaces. What goes in its place is a whole
 * `TOC` field with a cached list inside it, and that spans several paragraphs — which is why it
 * cannot be written where the tag is and has to wait for the pass, the same way the numbers do.
 */
const LIST_TOKEN = (sequence) => `@@FIGLIST:${sequence}@@`;
const LIST_PARAGRAPH = /<w:p(?=[ >])[^>]*>(?:(?!<w:p[ >])[\s\S])*?@@FIGLIST:(Figure|Table)@@[\s\S]*?<\/w:p>/g;

/**
 * A list of every figure (or table) in the report, for the front matter.
 *
 * Emitted as a placeholder now and built by `numberFigures` later, because the list is a fact
 * about the finished document — which captions there are and in what order — and nothing knows
 * that until the template has decided where everything goes.
 *
 * @param {'Figure'|'Table'} sequence
 */
export function listOfCaptions(sequence = 'Figure') {
  return `<w:p><w:r><w:t>${LIST_TOKEN(sequence === 'Table' ? 'Table' : 'Figure')}</w:t></w:r></w:p>`;
}

/**
 * The finished list: a real `TOC` field with a readable copy of its answer already inside it.
 *
 * Both halves, for exactly the reason the numbers need both. The field is what makes the list
 * survive editing — a reader who deletes a finding and refreshes gets a list without its figures,
 * and Word adds the page numbers we cannot know. The cached copy is what everything that does not
 * evaluate fields sees: LibreOffice in some configurations, a PDF printed by a converter, a
 * preview. A field alone shows those readers "Right-click to update field" at the front of the
 * document; a static list alone goes stale the first time anybody edits it.
 *
 * `\h` makes each entry a link to its caption, `\z` keeps the page numbers out of web view, and
 * `\c "Figure"` is what ties the list to the `SEQ Figure` fields the captions carry — which is why
 * `captionPrefix` uses Word's own sequence names even when the printed label is "Screenshot".
 */
function listBlock(sequence, entries) {
  /*
   * No entries means no paragraphs, which is deliberately the whole of the empty case: a template
   * carrying this tag unconditionally, used on a proposal with no evidence in it, prints nothing
   * rather than a heading over a blank.
   */
  const paragraph = (entry, index) =>
    '<w:p><w:pPr><w:pStyle w:val="TableofFigures"/></w:pPr>' +
    (index === 0
      ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        `<w:r><w:instrText xml:space="preserve"> TOC \\h \\z \\c "${sequence}" </w:instrText></w:r>` +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      : '') +
    `<w:hyperlink w:anchor="${escapeXml(entry.name)}">` +
    '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>' +
    `<w:t xml:space="preserve">${escapeXml(entry.text)}</w:t></w:r></w:hyperlink>` +
    (index === entries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '') +
    '</w:p>';

  return entries.map(paragraph).join('');
}

/** A paragraph, for finding the ones a caption lives in. Paragraphs do not nest, so this is safe. */
const PARAGRAPH = /<w:p(?=[ >])[^>]*>(?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g;
const TEXT = /<w:t(?=[ >])[^>]*>([\s\S]*?)<\/w:t>/g;

/**
 * Every caption in the document, in the order a reader meets them.
 *
 * Read back off the finished XML rather than collected as the captions were written, and that is
 * the point: writing order is not document order, and a list built from the first would disagree
 * with the numbers built from the second. Run after the numbers are substituted, so what it reads
 * is the caption exactly as it will be read — "Figure 7 — The request", number and all.
 */
function captionsIn(xml, prefix) {
  const marker = new RegExp(`<w:bookmarkStart\\b[^>]*w:name="(${prefix}[^"]+)"`);
  const out = [];
  for (const match of xml.matchAll(PARAGRAPH)) {
    const name = marker.exec(match[0])?.[1];
    if (!name) continue;
    const text = [...match[0].matchAll(TEXT)].map((t) => t[1]).join('').trim();
    if (text) out.push({ name, text });
  }
  return out;
}

/** Exactly what `referenceField` produces, so a whole reference can be replaced in one go. */
const REFERENCE = new RegExp(
  '<w:fldSimple w:instr=" REF ((?:' +
    FIGURE_BOOKMARK +
    '|' +
    TABLE_BOOKMARK +
    ')[^ "]+) \\\\h "><w:r><w:t>@@FIGREF:[^@]*@@</w:t></w:r></w:fldSimple>',
  'g'
);

const NUMBER_TOKEN = /@@FIGNUM:([^@]+)@@/g;
const BOOKMARK_START = new RegExp(
  `<w:bookmarkStart\\b[^>]*w:name="((?:${FIGURE_BOOKMARK}|${TABLE_BOOKMARK})[^"]+)"`,
  'g'
);

/**
 * Numbers every figure in the finished document, and resolves every reference to one.
 *
 * Pure, and takes the XML rather than the package, so the whole thing is testable against a string
 * — which matters more here than usual, because the failure mode is a document that looks fine
 * until page 12.
 *
 * Figures and tables are counted separately, because Word counts them separately and a reader
 * expects it: Figure 7 and Table 3 on the same page are both right.
 *
 * @param {string} xml `word/document.xml` after rendering
 * @param {{label?:string, tableLabel?:string}} [options]
 * @returns {{xml:string, count:number, tables:number, referenced:number, missing:string[]}}
 */
export function numberFigures(xml, { label = 'Figure', tableLabel = 'Table' } = {}) {
  const source = String(xml ?? '');

  /*
   * Document order, by definition: the order the bookmarks appear in the part Word will read.
   * A bookmark seen twice keeps its first number — the same screenshot printed in two findings is
   * one figure as far as a reader is concerned, and giving it two numbers would make the second
   * reference to it point somewhere the reader has already been told about.
   *
   * One counter per sequence. Interleaving them would number the third picture 5 because two
   * tables happened to come before it, and then say 5 in a document whose table of figures — which
   * Word builds from its own `SEQ Figure` field, not from this — says 3.
   */
  const numbers = new Map();
  const counts = new Map(SEQUENCES.map((sequence) => [sequence.prefix, 0]));
  const labels = { [FIGURE_BOOKMARK]: label, [TABLE_BOOKMARK]: tableLabel };
  /** Which sequence a bookmark belongs to, by the prefix it carries. */
  const prefixOf = (name) => SEQUENCES.find((sequence) => name.startsWith(sequence.prefix))?.prefix;

  for (const match of source.matchAll(BOOKMARK_START)) {
    if (numbers.has(match[1])) continue;
    const prefix = prefixOf(match[1]);
    if (!prefix) continue;
    counts.set(prefix, counts.get(prefix) + 1);
    numbers.set(match[1], counts.get(prefix));
  }

  let referenced = 0;
  const missing = [];

  let out = source.replace(NUMBER_TOKEN, (_whole, name) => String(numbers.get(name) ?? ''));

  out = out.replace(REFERENCE, (whole, name) => {
    const number = numbers.get(name);
    if (!number) {
      /*
       * The figure it pointed at is not in this document — deleted after the sentence was written,
       * or in a field this template does not print.
       *
       * The field is thrown away rather than left with an empty cache: a `REF` to a bookmark that
       * does not exist renders as "Error! Reference source not found." in Word, which is worse than
       * anything this could say instead. What it says instead is deliberately visible, because the
       * alternative — quietly deleting the words — leaves a sentence that reads as though nothing
       * is missing. `preflight` warns about this before anybody generates, which is where it
       * should be caught.
       */
      missing.push(name);
      return `<w:r><w:t xml:space="preserve">${escapeXml(MISSING_FIGURE)}</w:t></w:r>`;
    }
    referenced += 1;
    /* "Table 3", not "Figure 3", when that is what it points at. */
    const word = labels[prefixOf(name)] ?? label;
    return whole.replace(/@@FIGREF:[^@]*@@/, `${escapeXml(word)} ${number}`);
  });

  /*
   * And last, the lists — after the numbers, because an entry reads "Figure 7 — The request" and
   * the 7 only exists once the substitution above has run.
   */
  let listed = 0;
  out = out.replace(LIST_PARAGRAPH, (_whole, sequence) => {
    const entries = captionsIn(out, sequence === 'Table' ? TABLE_BOOKMARK : FIGURE_BOOKMARK);
    listed += entries.length;
    return listBlock(sequence, entries);
  });

  return {
    xml: out,
    count: counts.get(FIGURE_BOOKMARK),
    tables: counts.get(TABLE_BOOKMARK),
    referenced,
    listed,
    missing,
  };
}

export default {
  numberFigures,
  captionPrefix,
  referenceField,
  listOfCaptions,
  FIGURE_BOOKMARK,
  TABLE_BOOKMARK,
  MISSING_FIGURE,
};
