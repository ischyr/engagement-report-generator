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
 * @param {{name:string, id:number, label:string, separator?:string, rPr?:string}} figure
 */
export function captionPrefix({ name, id, label = 'Figure', separator = ' — ', rPr = '' }) {
  return (
    `<w:bookmarkStart w:id="${id}" w:name="${escapeXml(name)}"/>` +
    `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(label)} </w:t></w:r>` +
    '<w:fldSimple w:instr=" SEQ Figure \\* ARABIC ">' +
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

/** Exactly what `referenceField` produces, so a whole reference can be replaced in one go. */
const REFERENCE = new RegExp(
  '<w:fldSimple w:instr=" REF (' +
    FIGURE_BOOKMARK +
    '[^ "]+) \\\\h "><w:r><w:t>@@FIGREF:[^@]*@@</w:t></w:r></w:fldSimple>',
  'g'
);

const NUMBER_TOKEN = /@@FIGNUM:([^@]+)@@/g;
const BOOKMARK_START = new RegExp(`<w:bookmarkStart\\b[^>]*w:name="(${FIGURE_BOOKMARK}[^"]+)"`, 'g');

/**
 * Numbers every figure in the finished document, and resolves every reference to one.
 *
 * Pure, and takes the XML rather than the package, so the whole thing is testable against a string
 * — which matters more here than usual, because the failure mode is a document that looks fine
 * until page 12.
 *
 * @param {string} xml `word/document.xml` after rendering
 * @param {{label?:string}} [options]
 * @returns {{xml:string, count:number, referenced:number, missing:string[]}}
 */
export function numberFigures(xml, { label = 'Figure' } = {}) {
  const source = String(xml ?? '');

  /*
   * Document order, by definition: the order the bookmarks appear in the part Word will read.
   * A bookmark seen twice keeps its first number — the same screenshot printed in two findings is
   * one figure as far as a reader is concerned, and giving it two numbers would make the second
   * reference to it point somewhere the reader has already been told about.
   */
  const numbers = new Map();
  for (const match of source.matchAll(BOOKMARK_START)) {
    if (!numbers.has(match[1])) numbers.set(match[1], numbers.size + 1);
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
    return whole.replace(/@@FIGREF:[^@]*@@/, `${escapeXml(label)} ${number}`);
  });

  return { xml: out, count: numbers.size, referenced, missing };
}

export default { numberFigures, captionPrefix, referenceField, FIGURE_BOOKMARK, MISSING_FIGURE };
