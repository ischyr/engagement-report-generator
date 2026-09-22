/**
 * Converts editor HTML into WordprocessingML block content (`<w:p>` / `<w:tbl>`)
 * suitable for raw-XML injection into a template body.
 *
 * Headings, quotes and captions are emitted as *style references* rather than
 * direct formatting, so the look always comes from the user's own .docx
 * template. Templates therefore need the usual Word styles (Heading1..6, Quote,
 * Caption) — every document created from Word's default template has them.
 */

import { parseHtml, parseStyle } from './html-parser.js';
import { readImageSize, fitToPage, scaleToWidth } from './image-size.js';
import { captionPrefix, referenceField } from './figure-fields.js';
import { highlight, detectLanguage } from './code-highlight.js';

const escapeXml = (value) =>
  String(value ?? '')
    // Strip characters XML 1.0 forbids outright.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const HEADING_STYLES = {
  h1: 'Heading1', h2: 'Heading2', h3: 'Heading3',
  h4: 'Heading4', h5: 'Heading5', h6: 'Heading6',
};

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr', 'figure', 'figcaption',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'dl', 'dd', 'dt',
]);

const normaliseColor = (value) => {
  if (!value) return null;
  const v = String(value).trim();
  let hex = null;
  if (/^#?[0-9a-f]{6}$/i.test(v)) hex = v.replace('#', '');
  else if (/^#?[0-9a-f]{3}$/i.test(v)) {
    const s = v.replace('#', '');
    hex = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  } else {
    const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
      hex = [rgb[1], rgb[2], rgb[3]]
        .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
        .join('');
    }
  }
  return hex ? hex.toUpperCase() : null;
};

const ALIGN_MAP = { left: 'left', center: 'center', right: 'right', justify: 'both' };

/**
 * A table's column widths in twips, from whatever the editor recorded.
 *
 * ProseMirror writes `colwidth` on a cell as a comma-separated list — one entry per column the
 * cell spans, in the editor's own CSS pixels, and `0` for a column nobody has touched. Any row can
 * carry it, and in practice only the rows somebody dragged do, so every row is read and the first
 * width found for a column wins.
 *
 * The numbers are turned into a ratio and scaled to `total`, because the absolute values are a
 * fact about somebody's browser window rather than about the page. Columns nobody sized share what
 * is left over, at least a minimum each so a table of one sized column and five untouched ones
 * does not print five hairlines.
 *
 * With nothing recorded at all — a table pasted from a spreadsheet, or one written before the
 * editor could resize — every column is equal, which is exactly what happened before.
 */
function columnWidths(rows, columnCount, total) {
  const found = new Array(columnCount).fill(0);

  for (const row of rows) {
    let column = 0;
    for (const cell of row.children ?? []) {
      if (cell.type !== 'element' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
      const span = Math.max(1, Number(cell.attrs.colspan) || 1);
      const declared = String(cell.attrs.colwidth ?? '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      for (let i = 0; i < span; i += 1) {
        const at = column + i;
        if (at < columnCount && !found[at] && declared[i]) found[at] = declared[i];
      }
      column += span;
    }
  }

  const equal = Math.floor(total / columnCount);
  if (!found.some(Boolean)) return new Array(columnCount).fill(equal);

  /*
   * A column nobody sized is given the average of the ones that were, so it is a column rather
   * than a sliver — and then the whole lot is scaled to the page, so the ratio is what survives.
   */
  const sized = found.filter(Boolean);
  const average = sized.reduce((sum, w) => sum + w, 0) / sized.length;
  const guessed = found.map((w) => w || average);
  const sum = guessed.reduce((a, b) => a + b, 0);

  /** No column narrower than this, whatever the ratio says: a 40-twip column prints as a line. */
  const FLOOR = 400;
  const scaled = guessed.map((w) => Math.max(FLOOR, Math.floor((w / sum) * total)));

  /*
   * Rounding and the floor both cost width, and a grid that adds up to more than the page makes
   * Word reflow the whole table. The last column absorbs the difference, which is where a reader
   * is least likely to notice a few twips.
   */
  const over = scaled.reduce((a, b) => a + b, 0) - total;
  if (over !== 0) {
    scaled[scaled.length - 1] = Math.max(FLOOR, scaled[scaled.length - 1] - over);
  }
  return scaled;
}

/**
 * How wide one character of the pane is, in twips.
 *
 * Consolas advances 1126 of its 2048 em units, which at 9pt — `w:sz 18` — is 98.96 twips. The
 * gutter has always been sized at a hundred a digit on the same arithmetic. This is deliberately
 * a little wider than the truth, so the wrap this file computes falls *before* the one Word would
 * compute. Being out by a character leaves a short line; being out the other way would hand the
 * wrapping back to Word, which is the bug the wrapping exists to fix.
 *
 * Erring wide is also why `<w:noWrap/>` stays off the code cell. If the estimate is ever wrong —
 * a machine without Consolas substituting something broader — Word wraps the line and its number
 * is out by one, which is the old behaviour for that line and nothing worse. With `noWrap` it
 * would silently lose the end of it instead.
 */
const CODE_CHAR_TWIPS = 105;

/** No pane narrower than this, however deeply indented: a two-character column is not a pane. */
const MIN_CODE_COLUMNS = 24;

/**
 * Code-block looks. `terminal` renders a dark, padded pane so command output
 * reads as a console session; `light` is a pale reviewer-friendly box; `template`
 * defers to the template's own `CodeBlock` paragraph style if it defines one.
 */
export const CODE_THEMES = {
  terminal: {
    fill: '0D1117',
    text: 'E6EDF3',
    border: '30363D',
    accent: '7EE787',
    /** The line-number column: present enough to count by, quiet enough to read past. */
    gutter: '6E7681',
    gutterRule: '30363D',
    /**
     * One colour per token kind. The kinds come from `code-highlight.js`; anything it does not
     * recognise stays `text`, so a theme that omits a kind degrades to the single colour this
     * pane had before rather than to something unreadable.
     */
    tokens: {
      keyword: 'FF7B72',
      string: 'A5D6FF',
      number: '79C0FF',
      comment: '8B949E',
      punct: '8B949E',
      key: 'D2A8FF',
      accent: '7EE787',
    },
  },
  light: {
    fill: 'F6F8FA',
    text: '24292F',
    border: 'D0D7DE',
    accent: '116329',
    gutter: '8C959F',
    gutterRule: 'D0D7DE',
    tokens: {
      keyword: 'CF222E',
      string: '0A3069',
      number: '0550AE',
      comment: '6E7781',
      punct: '6E7781',
      key: '8250DF',
      accent: '116329',
    },
  },
};

/**
 * Callout boxes: a note, a warning, the thing the reader must not miss.
 *
 * Every report has these — "this was not exploited further because the client asked us to stop",
 * "the fix below breaks single sign-on" — and until now every one of them was an ordinary
 * paragraph starting with the word "Note:", which is to say it looked like the paragraph before it
 * and got read at the same speed.
 *
 * Four kinds and no more. A palette with seven is a palette nobody can keep straight, and the
 * distinction that actually matters in a penetration test report is: here is context, here is
 * something that will bite you, here is something dangerous, here is what we recommend.
 *
 * The colours are the severity palette's neighbours rather than the palette itself. A callout
 * shaded the exact red of a Critical finding reads as a severity when it is not one, which in a
 * document where red means Critical is a real misreading rather than a stylistic quibble.
 */
export const CALLOUTS = {
  note: { label: 'Note', fill: 'EFF6FF', border: '3B82F6', text: '1E3A5F' },
  tip: { label: 'Recommended', fill: 'F0FDF4', border: '22C55E', text: '14532D' },
  warning: { label: 'Warning', fill: 'FFFBEB', border: 'F59E0B', text: '78350F' },
  danger: { label: 'Danger', fill: 'FEF2F2', border: 'EF4444', text: '7F1D1D' },
};

/** Fallback direct formatting for heading levels a template does not define. */
const HEADING_FALLBACK = {
  h1: { size: 32, color: '1F3864' },
  h2: { size: 28, color: '1F3864' },
  h3: { size: 24, color: '222222' },
  h4: { size: 22, color: '222222' },
  h5: { size: 21, color: '444444' },
  h6: { size: 20, color: '444444' },
};

class OoxmlWriter {
  /**
   * @param {object} options
   * @param {import('./docx-parts.js').DocxAssembler|null} options.parts
   * @param {{bulletNumId:number, orderedNumId:number}|null} options.numbering
   * @param {string} options.monoFont
   * @param {boolean} options.imageBorder
   * @param {string} options.imageBorderColor
   * @param {string} options.captionStyle
   * @param {'terminal'|'light'|'template'} options.codeTheme
   * @param {Set<string>|null} options.availableStyles style ids the template defines;
   *   null means "assume everything exists" (the historical behaviour)
   * @param {number} [options.usableTwips] the template's own text-column width; defaults to
   *   the US Letter figure this code assumed before it was measured
   */
  constructor(options = {}) {
    this.parts = options.parts ?? null;
    this.numbering = options.numbering ?? null;
    this.monoFont = options.monoFont ?? 'Consolas';
    this.imageBorder = Boolean(options.imageBorder);
    this.imageBorderColor = (options.imageBorderColor ?? '000000').replace('#', '');
    this.captionStyle = options.captionStyle ?? 'Caption';
    /**
     * Whether captions are numbered — "Figure 7 — The request" — and references to them resolved.
     *
     * A setting rather than a decision, because it changes what every existing report looks like:
     * an instance whose house style numbers its own figures another way should be able to say so.
     * On by default, because an unnumbered figure cannot be referred to and most of them want to
     * be.
     */
    this.figureNumbering = options.figureNumbering !== false;
    this.figureLabel = options.figureLabel || 'Figure';
    /**
     * Whether a captioned table is numbered — "Table 3 — Hosts in scope".
     *
     * A separate setting from `figureNumbering` because the two have different answers: a house
     * whose template numbers its own figures may still want tables numbered, and a report with
     * three screenshots and eleven tables cares about this one far more.
     *
     * Only *captioned* tables are numbered — see `#table` — so turning this on does not put a
     * number on the two-row comparison inside somebody's paragraph.
     */
    this.tableNumbering = options.tableNumbering !== false;
    /** The word in front of the number. Word's `SEQ Table` counter is used whatever this says. */
    this.tableLabel = options.tableLabel || 'Table';
    /**
     * Pictures written but not yet captioned, oldest first.
     *
     * Every stored picture becomes a numbered figure, whether or not anybody wrote a caption for
     * it — on an engagement with fifty screenshots almost none of them will have one, and "see the
     * screenshot below" is exactly as useless at fifty as it was at five. So an image is queued
     * here as it is written, and the caption line that follows takes it: the author's words if
     * there are any, the number alone if there are not.
     */
    this.pendingFigures = [];
    /**
     * Which of those pictures are a frame out of a screen recording.
     *
     * A document cannot hold a video, so what prints is the still — and a reader looking at a
     * static screenshot has no way of knowing there is thirty seconds of evidence behind it.
     * Saying so in the caption is the whole of the fix: the recording is in the app, and the
     * report should not imply the still was all there ever was.
     *
     * A set beside the queue rather than a richer queue entry, because the key in that queue is
     * handed straight to `claimFigureCaption` and `figureBookmark`, and widening it would touch
     * every one of those call sites to carry one boolean.
     */
    this.recordingFigures = new Set();
    /** Set while a caption is being written, so writing one cannot start another. */
    this.suppressCaption = false;
    /**
     * A caption paragraph waiting for the table it names, set by `render` one node ahead.
     *
     * Cleared by `#table` as it takes it, and never read by anything else — so a marked paragraph
     * whose table turned out to be empty leaves nothing behind for the next table to pick up.
     */
    this.pendingTableCaption = null;
    this.codeTheme = options.codeTheme ?? 'terminal';
    /**
     * Whether code panes are coloured by what the text is.
     *
     * On by default, because it adds colour and moves nothing: every character stays where it was,
     * in the same font at the same size, and a reader who does not care sees the same pane slightly
     * easier to skim. Off is for a house style that wants one ink, and for the reader who prints in
     * greyscale and would rather have contrast than hue.
     *
     * Never applied to the `template` theme — that theme exists to hand the pane to the document's
     * own `CodeBlock` style, and direct run colours are the one thing that would override it.
     */
    this.codeHighlight = options.codeHighlight !== false;
    /**
     * Whether code panes carry a line-number column.
     *
     * Off by default, and deliberately, because it has a cost the other presentation settings do
     * not: a reader who selects a pane in Word to copy a command out of it gets the numbers too.
     * Worth it when the prose says "line 14"; not worth it for a three-line curl.
     *
     * A pane whose lines are not contiguous turns this on for itself regardless — see
     * `#codeBlock`. Skipping from line 40 to line 187 without saying so would be a lie about the
     * evidence, and the numbers are how it stops being one.
     */
    this.codeLineNumbers = Boolean(options.codeLineNumbers);
    this.availableStyles = options.availableStyles ?? null;
    /**
     * The width of the page's text column, in twentieths of a point.
     *
     * Tables, code panes and images are all drawn at a fixed width, and that width used to be
     * the constant 9360 — US Letter with 1" margins — written into three places. On A4 with
     * 2.5 cm margins the real column is 9070, so every table was 5 mm too wide, and in a
     * landscape section they were barely half the page.
     */
    this.usableTwips = Number(options.usableTwips) > 0 ? Number(options.usableTwips) : 9360;
    /**
     * Stored evidence, keyed by media id, loaded before rendering starts.
     *
     * Conversion is synchronous — docxtemplater walks the tree and calls in here
     * inline — so images referenced as `/api/media/<id>` have to be in hand
     * already. `report.service.js` collects the ids and fills this in.
     */
    this.media = options.media ?? null;
    this.blocks = [];
  }

  /**
   * Returns the style name only if the template actually defines it. Referencing
   * a missing style is not an error in Word — it just silently renders as Normal,
   * which is how headings and quotes end up looking like body text.
   */
  #style(name) {
    if (!name) return null;
    if (!this.availableStyles) return name;
    return this.availableStyles.has(name) ? name : null;
  }

  /* ------------------------------ paragraphs ------------------------------ */

  /**
   * WordprocessingML validates `<w:pPr>` against a sequence, so the children are
   * emitted in schema order: pStyle, keepNext, numPr, pBdr, shd, ind, jc, rPr.
   * Word rejects the document outright if they are shuffled.
   */
  #paragraph(runs, props = {}) {
    /*
     * Whether a caption is about to follow this paragraph.
     *
     * Decided here because `#paragraph` is the one funnel every picture goes through — a paragraph
     * of its own, a sentence with a screenshot in it, a list item, a table cell, a heading. The
     * first attempt captioned only a picture that was alone in its block, which read well in the
     * cases it covered and silently skipped everything else: a screenshot after a label, evidence
     * inside a list, a picture in a table. Every picture in a report is evidence and every one of
     * them needs a number, so the rule is now simply: a paragraph that drew a picture is followed
     * by that picture's caption.
     */
    const captions =
      !this.suppressCaption &&
      this.figureNumbering &&
      this.pendingFigures.length > 0 &&
      runs.includes('<w:drawing');

    const pPr = [];
    if (props.style) pPr.push(`<w:pStyle w:val="${escapeXml(props.style)}"/>`);
    /* A picture is never left at the foot of a page with its caption at the head of the next. */
    if (props.keepNext || captions) pPr.push('<w:keepNext/>');
    if (props.numId !== undefined) {
      pPr.push(
        `<w:numPr><w:ilvl w:val="${props.ilvl ?? 0}"/><w:numId w:val="${props.numId}"/></w:numPr>`
      );
    }
    if (props.border === 'left') {
      pPr.push('<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr>');
    } else if (props.border) {
      pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
    }
    if (props.shading) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${props.shading}"/>`);
    if (props.indentLeft) pPr.push(`<w:ind w:left="${props.indentLeft}"/>`);
    if (props.align) pPr.push(`<w:jc w:val="${props.align}"/>`);
    if (props.mono) {
      pPr.push(
        `<w:rPr><w:rFonts w:ascii="${this.monoFont}" w:hAnsi="${this.monoFont}" w:cs="${this.monoFont}"/><w:sz w:val="18"/></w:rPr>`
      );
    }
    const prefix = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
    this.blocks.push(`<w:p>${prefix}${runs}</w:p>`);

    if (captions) {
      /*
       * The flag stops the caption's own paragraph from trying to caption itself, and it is what
       * lets a `<figure>` opt out — there the `<figcaption>` supplies the words, so the picture
       * must not be given a bare number first.
       */
      this.suppressCaption = true;
      while (this.pendingFigures.length) this.#figureCaption([], props.align);
      this.suppressCaption = false;
    } else if (!this.figureNumbering) {
      this.pendingFigures.length = 0;
    }
  }

  /** Schema order for `<w:rPr>`: rFonts, b, i, caps, strike, color, sz, u, shd, vertAlign. */
  #runProps(marks) {
    const rPr = [];
    if (marks.code || marks.mono) {
      rPr.push(
        `<w:rFonts w:ascii="${this.monoFont}" w:hAnsi="${this.monoFont}" w:cs="${this.monoFont}"/>`
      );
    }
    if (marks.bold) rPr.push('<w:b/>');
    if (marks.italic) rPr.push('<w:i/>');
    if (marks.caps) rPr.push('<w:caps/>');
    if (marks.strike) rPr.push('<w:strike/>');
    if (marks.link) rPr.push('<w:color w:val="0563C1"/>');
    else if (marks.color) rPr.push(`<w:color w:val="${marks.color}"/>`);
    if (marks.size) rPr.push(`<w:sz w:val="${marks.size}"/>`);
    if (marks.underline || marks.link) rPr.push('<w:u w:val="single"/>');
    if (marks.highlight) {
      rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${marks.highlight}"/>`);
    } else if (marks.code) {
      rPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F1F1F1"/>');
    }
    if (marks.vertAlign) rPr.push(`<w:vertAlign w:val="${marks.vertAlign}"/>`);
    return rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  }

  #textRun(text, marks, preserveLines = false) {
    if (text === '') return '';
    const rPr = this.#runProps(marks);
    if (!preserveLines) {
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    }
    // In <pre> blocks newlines and tabs are content, not formatting noise.
    const pieces = String(text).split('\n');
    const body = pieces
      .map((line, idx) => {
        const withTabs = line
          .split('\t')
          .map((chunk) => `<w:t xml:space="preserve">${escapeXml(chunk)}</w:t>`)
          .join('<w:tab/>');
        return (idx > 0 ? '<w:br/>' : '') + withTabs;
      })
      .join('');
    return `<w:r>${rPr}${body}</w:r>`;
  }

  /* -------------------------------- inline -------------------------------- */

  #inline(nodes, marks, preserveLines = false) {
    let out = '';
    for (const node of nodes) {
      if (node.type === 'text') {
        const value = preserveLines ? node.value : node.value.replace(/[\r\n]+/g, ' ');
        out += this.#textRun(value, marks, preserveLines);
        continue;
      }
      if (node.type !== 'element') continue;

      const { tag, attrs, children } = node;
      const style = parseStyle(attrs.style);
      const next = { ...marks };

      switch (tag) {
        case 'br':
          out += `<w:r>${this.#runProps(marks)}<w:br/></w:r>`;
          continue;
        case 'img':
          out += this.#image(attrs);
          continue;
        case 'span':
          /*
           * A reference to a figure, written in the editor as a chip and stored as
           * `<span data-figref="<media id>">`.
           *
           * Only this one attribute is special; every other span falls through to the ordinary
           * inline handling below, which is what keeps a pasted `<span style="...">` behaving as
           * it always has.
           */
          if (attrs['data-figref']) {
            out += this.#figureReference(attrs['data-figref'], marks, children);
            continue;
          }
          /*
           * A footnote, written in the editor as `<span data-footnote>the aside</span>`.
           *
           * The words inside are the note, not the sentence: what the reader sees in the body is a
           * superscript number, and the words go to the foot of the page.
           */
          if (attrs['data-footnote'] !== undefined) {
            out += this.#footnote(children, marks);
            continue;
          }
          break;
        case 'strong':
        case 'b':
          next.bold = true;
          break;
        case 'em':
        case 'i':
        case 'cite':
        case 'var':
          next.italic = true;
          break;
        case 'u':
        case 'ins':
          next.underline = true;
          break;
        case 's':
        case 'strike':
        case 'del':
          next.strike = true;
          break;
        case 'code':
        case 'kbd':
        case 'samp':
        case 'tt':
          next.code = true;
          break;
        case 'sup':
          next.vertAlign = 'superscript';
          break;
        case 'sub':
          next.vertAlign = 'subscript';
          break;
        case 'mark':
          next.highlight = normaliseColor(style['background-color']) ?? 'FFFF00';
          break;
        case 'a': {
          const href = attrs.href ?? '';
          if (/^(https?:|mailto:|ftp:)/i.test(href) && this.parts) {
            const rId = this.parts.addHyperlink(href);
            out += `<w:hyperlink r:id="${rId}">${this.#inline(children, { ...next, link: true }, preserveLines)}</w:hyperlink>`;
            continue;
          }
          next.link = true;
          break;
        }
        default:
          break;
      }

      const color = normaliseColor(style.color);
      if (color) next.color = color;
      const bg = normaliseColor(style['background-color']);
      if (bg) next.highlight = bg;
      if (style['font-weight'] === 'bold' || Number(style['font-weight']) >= 600) next.bold = true;
      if (style['font-style'] === 'italic') next.italic = true;
      if (style['text-decoration']?.includes('underline')) next.underline = true;
      if (style['text-decoration']?.includes('line-through')) next.strike = true;

      out += this.#inline(children, next, preserveLines);
    }
    return out;
  }

  #image(attrs) {
    const src = attrs.src ?? '';
    if (!this.parts) return '';

    let buffer = null;
    let declaredExt = null;

    // Stored evidence: `/api/media/<id>`, resolved from the pre-loaded map. Anchored
    // to the start, so an absolute URL that merely contains that path — somebody
    // else's instance — is treated as the remote image it is.
    const stored = /^\/api\/media\/([0-9a-f]{24})(?:[?#].*)?$/i.exec(src.trim());
    if (stored) {
      const entry = this.media?.get(stored[1].toLowerCase());
      if (!entry) {
        return this.#textRun('[image missing from storage]', { italic: true, color: '888888' });
      }
      buffer = entry.buffer;
      declaredExt = entry.ext;
    } else {
      // Inline data URIs still work: older engagements hold them, and a paste that
      // never went through the uploader would otherwise be lost.
      const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(src.trim());
      if (!match) {
        // Remote images cannot be fetched during generation; leave a visible marker.
        return this.#textRun(`[image: ${src.slice(0, 120)}]`, { italic: true, color: '888888' });
      }
      try {
        buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
      } catch {
        return '';
      }
      declaredExt = match[1].toLowerCase();
    }

    if (!buffer?.length) return '';

    const sniffed = readImageSize(buffer);
    const ext = sniffed?.ext ?? (declaredExt === 'jpeg' ? 'jpg' : declaredExt);
    const widthAttr = Number(attrs.width);
    const heightAttr = Number(attrs.height);
    const px = {
      w: Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr : sniffed?.width ?? 600,
      h: Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : sniffed?.height ?? 400,
    };
    /*
     * How wide it prints.
     *
     * 635 EMU to the twip (914400 per inch / 1440 twips per inch), so evidence is measured against
     * the real column rather than a hardcoded six inches — and against the *cell's* column when it
     * is in one, which is what lets two screenshots sit in a two-column table and each come out
     * the size of its half.
     *
     * `data-width` is a share of that column, in per cent, and it is the only thing that will
     * enlarge a picture. Without it the old rule stands: natural size, shrunk if it does not fit.
     */
    const share = Number(attrs['data-width']);
    const asked = Number.isFinite(share) && share > 0 && share <= 100 ? share : null;
    const { cx, cy } = asked
      ? scaleToWidth(px.w, px.h, Math.round(this.usableTwips * (asked / 100)) * 635)
      : fitToPage(px.w, px.h, this.usableTwips * 635);
    const { rId, docPrId, name } = this.parts.addImage(buffer, ext === 'jpeg' ? 'jpg' : ext);

    /*
     * Which picture the next caption belongs to.
     *
     * Stored evidence is keyed by its media id so a reference written anywhere in the report finds
     * it; a pasted data URI has no id and gets one derived from its drawing number, which is unique
     * within the document and cannot be referenced from elsewhere — correctly, because there is
     * nothing stable to reference.
     */
    /*
     * Queued for a caption — unless it is not evidence.
     *
     * "Every picture is a numbered figure" is right for screenshots and wrong for the pictures the
     * app composes itself: a severity chart carries its own legend, and a signature captioned
     * "Figure 8" is embarrassing in a document somebody signs. Those are marked at the point they
     * are built (`chart.service.js`, `signatures.service.js`), because that is the only place that
     * knows what they are — by the time it reaches here it is an `<img>` like any other.
     */
    if (attrs['data-figure'] !== 'no') {
      const key = stored ? stored[1].toLowerCase() : `img${docPrId}`;
      this.pendingFigures.push(key);
      /* Set by the editor when the picture is a frame taken out of a recording. */
      if (attrs['data-video']) this.recordingFigures.add(key);
    }

    const border = this.imageBorder
      ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${this.imageBorderColor}"/></a:solidFill></a:ln>`
      : '';
    const alt = escapeXml(attrs.alt ?? name);

    return (
      '<w:r><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      `<wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${alt}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(name)}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${border}</pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline>' +
      '</w:drawing></w:r>'
    );
  }

  /**
   * The caption line under a picture: "Figure 12", or "Figure 12 — The request".
   *
   * Takes the oldest picture still waiting for one, which is the one immediately above it —
   * `<figure>` blocks do not nest, and a paragraph of images is captioned in the order the images
   * were written.
   *
   * Only the *first* caption for a picture carries a number. The same screenshot printed in two
   * findings is one figure to a reader, and a second number for it would send every reference
   * somewhere they have already been.
   */
  #figureCaption(children, align) {
    const key = this.pendingFigures.shift() ?? null;
    const style = this.#style(this.captionStyle);
    /*
     * With no Caption style in the template, the formatting is written directly — and written to
     * match what the shipped templates' Caption style says, so a house that has not defined one
     * still gets italic grey rather than black body text pretending to be a caption.
     */
    const marks = style ? {} : { italic: true, size: 17, color: '6B7280' };
    const text = this.#inline(children, marks);

    let prefix = '';
    if (this.figureNumbering && this.parts && key && this.parts.claimFigureCaption(key)) {
      prefix = captionPrefix({
        ...this.parts.figureBookmark(key),
        label: this.figureLabel,
        /* No dash when there is nothing after it. */
        separator: text.trim() ? ' — ' : '',
        /* The same formatting the caption text got, so the number is not a black island in it. */
        rPr: style ? '' : this.#runProps(marks),
      });
    }

    /*
     * Numbering off and nothing written: there is no caption line to draw.
     *
     * Which also means a template that suppresses captions altogether prints the still with no
     * note on it. That is the template's decision — inventing a caption line here to carry the
     * note would put one where a house style deliberately has none.
     */
    if (!prefix && !text.trim()) return;

    /* Said last, so the caption reads as itself with a parenthetical after it. */
    const note =
      key && this.recordingFigures.has(key)
        ? this.#textRun(
            text.trim() ? ' (still from a screen recording)' : 'Still from a screen recording',
            marks
          )
        : '';

    this.#paragraph(prefix + text + note, { style: style ?? undefined, align });
  }

  /**
   * A cross-reference to a figure's caption.
   *
   * Emitted as a field pointing at a bookmark that may not have been written yet — the reference
   * is often in the description and the picture in the proof of concept, and the description is
   * converted first. That is why the bookmark name is derived from the media id rather than
   * allocated in reading order, and why the number itself is filled in by a pass over the finished
   * document rather than here. See `figure-fields.js`.
   *
   * With numbering switched off there is no bookmark to point at, so the chip degrades to the
   * words the author saw in the editor — its caption — which still reads as a sentence.
   */
  #figureReference(key, marks, children) {
    const media = String(key ?? '').trim().toLowerCase();
    if (!media || !this.figureNumbering || !this.parts) {
      return this.#inline(children, marks);
    }
    /*
     * The name, not a claim on the numbering. A reference converted before its figure has to name
     * the same bookmark the caption will later carry, and the assembler hands out one name per
     * picture for the life of the document — so whichever arrives first decides it.
     */
    return referenceField(this.parts.figureBookmark(media).name);
  }

  /**
   * A footnote: a superscript mark here, the words at the foot of the page.
   *
   * What this is for is the sentence every report carries and nowhere sensible to put: the tool
   * version, the reason something was not pursued, the caveat on a measurement. Inline it
   * interrupts the sentence; in the body it is a paragraph nobody asked for; in an appendix it is
   * too far from what it qualifies.
   *
   * Word numbers them, through `<w:footnoteRef/>` inside the note itself — so a note inserted
   * ahead of another renumbers both, and the client's own edits keep doing so afterwards. Nothing
   * here counts anything.
   *
   * **A template with no footnote part gets a parenthetical instead.** That is the honest
   * degradation: the words are what the writer meant and they still reach the reader, in the one
   * place that needs no part to exist. See `addFootnote` for why the part is not created.
   */
  #footnote(children, marks) {
    const body = this.#inline(children, marks);
    if (!body.trim()) return '';

    const id = this.parts?.addFootnote?.(
      '<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>' +
        /* The note's own number, which is what makes Word renumber them for itself. */
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
        '<w:r><w:t xml:space="preserve"> </w:t></w:r>' +
        `${body}</w:p>`
    );

    if (!id) return this.#textRun(' (', marks) + body + this.#textRun(')', marks);

    return (
      '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>' +
      `<w:footnoteReference w:id="${id}"/></w:r>`
    );
  }

  /* -------------------------------- blocks -------------------------------- */

  #hasBlockChild(nodes) {
    return nodes.some((n) => n.type === 'element' && BLOCK_TAGS.has(n.tag));
  }

  /** Renders a run of nodes as block content, wrapping loose inline runs. */
  render(nodes, ctx = { ilvl: 0, indent: 0 }) {
    // Inside a blockquote with no Quote style available, loose text still needs
    // to look quoted.
    const quoted = Boolean(ctx.quoteFallback);
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const runs = this.#inline(pending, quoted ? { italic: true, color: '4B4B4B' } : {});
      pending = [];
      if (runs.trim() !== '') {
        this.#paragraph(runs, {
          indentLeft: ctx.indent || undefined,
          border: quoted ? 'left' : undefined,
        });
      }
    };

    /* The next element, so a caption can see whether it has a table to belong to. */
    const elements = nodes.filter((node) => node.type === 'element');
    const nextElement = new Map(
      elements.map((node, index) => [node, elements[index + 1] ?? null])
    );

    for (const node of nodes) {
      if (node.type === 'text') {
        if (node.value.trim() === '') continue;
        pending.push(node);
        continue;
      }
      if (node.type !== 'element') continue;
      if (!BLOCK_TAGS.has(node.tag)) {
        pending.push(node);
        continue;
      }
      /*
       * A caption the editor wrote, which is a paragraph rather than a `<caption>`.
       *
       * HTML says a caption lives inside its table; ProseMirror's table model says a table's
       * children are rows, and putting anything else in there corrupts the map every table command
       * works from. So the editor marks a paragraph instead, and this is where the two views meet:
       * the paragraph immediately before a table is that table's caption and is drawn by `#table`,
       * and the same paragraph with no table after it is just a paragraph.
       */
      if (node.tag === 'p' && node.attrs['data-table-caption'] !== undefined) {
        const next = nextElement.get(node);
        if (next && next.tag === 'table') {
          flush();
          this.pendingTableCaption = node.children;
          continue;
        }
      }
      flush();
      this.#block(node, ctx);
    }
    flush();
  }

  #block(node, ctx) {
    const { tag, attrs, children } = node;
    const style = parseStyle(attrs.style);
    const align = ALIGN_MAP[style['text-align']];

    if (HEADING_STYLES[tag]) {
      const style = this.#style(HEADING_STYLES[tag]);
      // Without the style, fall back to direct formatting so a heading still
      // reads as a heading rather than silently collapsing into body text.
      const marks = style ? {} : { bold: true, ...HEADING_FALLBACK[tag] };
      this.#paragraph(this.#inline(children, marks), {
        style: style ?? undefined,
        align,
        keepNext: true,
      });
      return;
    }

    /*
     * A callout, which the editor writes as `<aside data-callout="warning">`.
     *
     * Checked before the switch rather than as a case of it, and that is not style: `aside` already
     * appears in the fallthrough group at the bottom, so a second case for it would shadow that one
     * — and an `<aside>` with no attribute would fall out of the switch having drawn nothing at
     * all. Which is exactly what it did, until the suite said so.
     *
     * `aside` because it is the one block element in the sanitiser's allow-list that means this and
     * is not already spoken for, and because without the attribute it stays the ordinary block it
     * has always been.
     */
    if (tag === 'aside' && attrs['data-callout'] !== undefined) {
      this.#callout(node, ctx);
      return;
    }

    switch (tag) {
      case 'hr':
        /*
         * A rule, or a page break — the editor writes both as `<hr>` and tells them apart with one
         * attribute.
         *
         * The same element because that is what it already is in the document model: a thing on
         * its own line that separates what is above from what is below. A page break is the
         * strongest version of that, and giving it its own tag would mean teaching the sanitiser,
         * the HTML report and the paste path about a second one.
         *
         * An empty paragraph carrying the break rather than a break inside the preceding
         * paragraph: Word treats the break as belonging to the run it sits in, so putting it at the
         * end of somebody's sentence makes the break part of that sentence — delete the last word
         * and the page break can go with it.
         */
        if (attrs['data-page-break'] !== undefined) {
          this.#paragraph('<w:r><w:br w:type="page"/></w:r>');
          return;
        }
        this.#paragraph('', { border: true });
        return;

      case 'ul':
      case 'ol':
        this.#list(node, ctx);
        return;

      case 'blockquote': {
        const indent = (ctx.indent || 0) + 720;
        const quoteStyle = this.#style('Quote');
        const inner = new OoxmlWriter(this.#childOptions());
        // No Quote style in the template — italic + a left rule reads as a quote.
        inner.render(children, { ...ctx, indent, quoteFallback: !quoteStyle });
        for (const block of inner.blocks) {
          this.blocks.push(quoteStyle ? applyStyleIfMissing(block, quoteStyle) : block);
        }
        return;
      }

      case 'pre':
        this.#codeBlock(children, ctx, attrs);
        return;

      case 'figcaption':
        /* A caption on its own, outside a figure — rare, and it still belongs to the last picture. */
        this.#figureCaption(children, align ?? 'center');
        return;

      case 'figure': {
        /*
         * The picture, then its caption, always in that order and always both.
         *
         * Handled here rather than falling through to the generic block branch so that a figure
         * with no `<figcaption>` still gets a caption line — which is the ordinary case once
         * numbering means every screenshot is a figure.
         */
        const caption = children.find((n) => n.type === 'element' && n.tag === 'figcaption');
        const body = children.filter((n) => n !== caption);

        /*
         * The picture, laid out as half of a figure.
         *
         * Written here rather than handed to `render()`, which flushes a lone `<img>` as a bare
         * paragraph with no properties — so a figure's picture came out left aligned and free to
         * be separated from its caption by a page break, while a loose screenshot two lines above
         * it got both. Same block, same treatment.
         */
        this.suppressCaption = true;
        if (this.#imagesOnly(body)) {
          this.#paragraph(this.#inline(body, {}), { align: align ?? 'center', keepNext: true });
        } else {
          this.render(body, ctx);
        }
        this.suppressCaption = false;
        this.#figureCaption(caption?.children ?? [], align ?? 'center');
        return;
      }

      case 'table':
        this.#table(node, ctx);
        return;

      case 'li':
        // A stray <li> outside a list — render as a bullet at the current level.
        this.#listItem(node, ctx, this.numbering?.bulletNumId);
        return;

      case 'dt':
        this.#paragraph(this.#inline(children, { bold: true }), { indentLeft: ctx.indent || undefined });
        return;

      case 'dd':
        this.#paragraph(this.#inline(children, {}), { indentLeft: (ctx.indent || 0) + 720 });
        return;

      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'main':
      case 'aside':
      case 'dl':
      default: {
        if (this.#hasBlockChild(children)) {
          this.render(children, ctx);
          return;
        }
        const quoted = Boolean(ctx.quoteFallback);
        const runs = this.#inline(children, quoted ? { italic: true, color: '4B4B4B' } : {});
        // Keep genuinely empty <p> tags: they are deliberate spacing.
        if (runs.trim() === '' && tag !== 'p') return;

        this.#paragraph(runs, {
          /*
           * A paragraph that is nothing but pictures is centred, so the caption sits under the
           * picture rather than under the middle of a page the picture is not in the middle of.
           *
           * The app owns this one property rather than the template's Caption style, because it
           * has to be the same on two paragraphs to look like one thing. Everything else about a
           * caption — font, size, colour, italics, spacing — is still the style's to decide, and
           * a paragraph that mixes words and a picture keeps whatever alignment it had.
           */
          align: this.#imagesOnly(children) ? (align ?? 'center') : align,
          indentLeft: ctx.indent || undefined,
          border: quoted ? 'left' : undefined,
        });
      }
    }
  }

  /** Whether a block holds pictures and nothing else — whitespace between them does not count. */
  #imagesOnly(nodes) {
    let images = 0;
    for (const node of nodes) {
      if (node.type === 'text') {
        if (node.value.trim()) return false;
        continue;
      }
      if (node.type !== 'element') continue;
      if (node.tag === 'img') {
        images += 1;
        continue;
      }
      if (node.tag === 'br') continue;
      return false;
    }
    return images > 0;
  }

  #childOptions() {
    return {
      parts: this.parts,
      numbering: this.numbering,
      monoFont: this.monoFont,
      imageBorder: this.imageBorder,
      imageBorderColor: this.imageBorderColor,
      captionStyle: this.captionStyle,
      figureNumbering: this.figureNumbering,
      figureLabel: this.figureLabel,
      tableNumbering: this.tableNumbering,
      tableLabel: this.tableLabel,
      codeTheme: this.codeTheme,
      codeHighlight: this.codeHighlight,
      codeLineNumbers: this.codeLineNumbers,
      availableStyles: this.availableStyles,
      // Nested writers draw tables and code panes too, and a cell's writer that fell back to
      // the default would size them for a different page than its parent.
      usableTwips: this.usableTwips,
      media: this.media,
    };
  }

  /**
   * What the gutter prints for a line that did not come out of the tool.
   *
   * The elision notice the print policy writes ("… 146 lines not printed") is a line in the pane
   * but not a line of evidence, so it gets this instead of a number. Without it the notice would
   * take the next number in the sequence and the count would be one out from there on.
   */
  static #ELISION = '…';

  /**
   * Which real line each printed row is, from `data-line-numbers`.
   *
   * The attribute is a comma list of numbers and ranges, one entry per printed row in order, with
   * `0` for a row the print policy wrote rather than the tool: `1-40,0,187,0,203-205`. That is the
   * whole of the contract, and it exists because a pane is not always the output — a step set to
   * print its first forty lines, with a marked line at 187 carried in anyway, is four ranges and
   * two notices, and no other encoding says that in forty characters.
   *
   * Returns null when the attribute is absent, malformed, or does not describe exactly this many
   * rows. Null means "number them 1, 2, 3", which is right for an editor code block and is the
   * only safe answer for a mismatch: numbering evidence wrongly is worse than not numbering it.
   *
   * @param {string} value
   * @param {number} rows
   * @returns {number[]|null}
   */
  static #lineNumbers(value, rows) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    const out = [];
    for (const part of raw.split(',')) {
      const range = /^(\d+)-(\d+)$/.exec(part.trim());
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (to < from || to - from > 100_000) return null;
        for (let n = from; n <= to; n += 1) out.push(n);
        continue;
      }
      if (!/^\d+$/.test(part.trim())) return null;
      out.push(Number(part.trim()));
    }
    return out.length === rows ? out : null;
  }

  /** The marked lines, as real line numbers: `data-mark-lines="187,203"`. */
  static #markedLines(value) {
    const out = new Set();
    for (const part of String(value ?? '').split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
    return out;
  }

  /**
   * The runs for one line of a code pane.
   *
   * A marked line is drawn whole in one colour rather than tokenised: the accent is saying "this
   * is the line somebody pointed at", and a line that is half accent and half syntax colours says
   * it much less clearly. Everything else is tokenised when highlighting is on, and is one run in
   * `theme.text` when it is off or the language was not recognised — which is the pane exactly as
   * it has always been.
   */
  /**
   * A tab, as the spaces a terminal would have shown.
   *
   * Counted rather than kept, because a tab character in a fixed-layout table cell lands on
   * whatever tab stops the document happens to define, which is never the eight columns the tool
   * that wrote it assumed. It also cannot be measured, and everything below depends on knowing how
   * wide a line is.
   */
  static #expandTabs(line, stop = 8) {
    if (!line.includes('\t')) return line;
    let out = '';
    for (const character of line) {
      out += character === '\t' ? ' '.repeat(stop - (out.length % stop)) : character;
    }
    return out;
  }

  /** A line's tokens, coloured or not. One token for the whole line when there is no language. */
  #codeLineTokens(text, language) {
    if (!this.codeHighlight || !language) return [{ text, kind: 'plain' }];
    return highlight(text, language);
  }

  /**
   * Splits one line's tokens into the display rows it will occupy.
   *
   * Tokens rather than text, so a wrapped line keeps its colours and — the part that matters —
   * the highlighter never sees a fragment. Several of its rules are anchored to the start of a
   * line: colouring the chunks separately would read `POST` in the middle of a wrapped URL as a
   * request method and paint it like one.
   *
   * A hard break at the column, the way a terminal wraps, rather than at the last space. A pane
   * is evidence: re-flowing somebody's output at word boundaries rewrites the shape of the thing
   * they are showing, and the one place a break must never fall is inside a value nobody can see
   * the end of.
   */
  static #wrapTokens(tokens, columns) {
    const rows = [];
    let row = [];
    let used = 0;
    for (const token of tokens) {
      let rest = token.text;
      while (rest.length > 0) {
        if (used >= columns) {
          rows.push(row);
          row = [];
          used = 0;
        }
        const take = rest.slice(0, columns - used);
        row.push({ text: take, kind: token.kind });
        used += take.length;
        rest = rest.slice(take.length);
      }
    }
    rows.push(row);
    return rows;
  }

  /** One display row's runs. */
  #codeRowRuns(tokens, { theme, marked }) {
    const base = { mono: true, size: 18 };
    if (marked) {
      const text = tokens.map((token) => token.text).join('');
      return this.#textRun(text, { ...base, color: theme.accent, bold: true }, true);
    }
    return tokens
      .map((token) =>
        this.#textRun(token.text, { ...base, color: theme.tokens?.[token.kind] ?? theme.text }, true)
      )
      .join('');
  }

  /**
   * Renders a `<pre>` block.
   *
   * The `terminal` and `light` themes use a one-cell table rather than a shaded
   * paragraph, because only a table cell can carry interior margins — shading a
   * paragraph puts the text flush against the coloured edge, which never looks
   * like a console. The `template` theme instead defers to the document's own
   * `CodeBlock` style so a house style wins.
   *
   * Three things can be asked of the pane through attributes on the `<pre>`, all optional and all
   * ignored unless the block is plain text (a hand-written `<pre>` with markup inside it takes the
   * original single-colour path, because nothing here could colour it without first deciding what
   * somebody's `<span>` meant):
   *
   *   `data-language`     what to colour it as — see `code-highlight.js`, which also sniffs
   *   `data-line-numbers` which real line each row is, so a pane that skips can say so
   *   `data-mark-lines`   the lines somebody marked, which the pane picks out in the accent
   */
  #codeBlock(children, ctx, attrs = {}) {
    // TipTap wraps code-block content in <code>; unwrap so the text is direct.
    const codeEl =
      children.length === 1 && children[0].type === 'element' && children[0].tag === 'code'
        ? children[0]
        : null;
    const inner = codeEl ? codeEl.children : children;

    const templateStyle = this.codeTheme === 'template' ? this.#style('CodeBlock') : null;
    if (templateStyle) {
      this.#paragraph(this.#inline(inner, { code: false, mono: true }, true), {
        style: templateStyle,
        indentLeft: ctx.indent || undefined,
      });
      return;
    }

    const theme = CODE_THEMES[this.codeTheme] ?? CODE_THEMES.terminal;
    const width = Math.max(1200, this.usableTwips - (ctx.indent || 0));

    /*
     * Plain text, or markup?
     *
     * Only the first can be coloured or counted, and only the first is what anything in this
     * codebase actually produces — TipTap's code block holds text, and the output pane is
     * assembled from escaped text in `report.service.js`. The second is a `<pre>` somebody pasted,
     * and it keeps the behaviour it has always had.
     */
    const plain = inner.every((node) => node.type === 'text')
      ? inner.map((node) => node.value).join('')
      : null;

    let runs;
    let gutter = null;

    if (plain === null) {
      // `code: false` so the inline-code shading does not fight the pane colour.
      runs = this.#inline(inner, { mono: true, color: theme.text, size: 18 }, true);
    } else {
      /*
       * One trailing newline is dropped, the way `<pre>` has always treated a leading one: it is
       * how the text was laid out, not a line of it. Left in, it becomes an empty final row — and
       * with a gutter, an empty final row that has been given a number, which reads as a bug in
       * the pane rather than as the blank line it is.
       */
      const lines = plain.replace(/\n$/, '').split('\n');
      const language = this.codeHighlight
        ? detectLanguage(plain, codeEl?.attrs?.class || `language-${attrs['data-language'] ?? ''}`)
        : '';
      const numbers = OoxmlWriter.#lineNumbers(attrs['data-line-numbers'], lines.length);
      const marked = OoxmlWriter.#markedLines(attrs['data-mark-lines']);

      /*
       * A pane that skips numbers its own lines whatever the setting says.
       *
       * The setting is a preference about how panes look; this is not. A pane showing lines 1-40
       * and then line 187 with nothing between them is a claim about the evidence, and without the
       * numbers beside it the claim is that those forty-one lines ran consecutively. The elision
       * notice says some were cut; only the numbers say which.
       */
      const skips = Boolean(numbers) && numbers.some((n, i) => i > 0 && n !== 0 && n !== numbers[i - 1] + 1);
      const numbered = this.codeLineNumbers || skips;

      /*
       * How many characters fit across the code cell.
       *
       * The gutter is as wide as its widest number, so the code column is only known once that is,
       * and the number below is computed from it rather than guessed at — see `CODE_CHAR_TWIPS`.
       */
      const gutterWidth = numbered
        ? Math.max(
            560,
            String(
              numbers ? numbers.reduce((a, b) => (b > a ? b : a), lines.length) : lines.length
            ).length *
              100 +
              320
          )
        : 0;
      const columns = Math.max(
        MIN_CODE_COLUMNS,
        Math.floor((width - gutterWidth - 320) / CODE_CHAR_TWIPS)
      );

      /*
       * Every line as the rows it will actually occupy, and the number that belongs beside each.
       *
       * This is the whole of 172. The cells line up only because the gutter and the code carry the
       * same number of `<w:br/>`-separated rows, and a line wider than the column used to gain a
       * row in the code cell that the gutter — which is `noWrap` — never gained. From the first
       * long line down, every number was beside the wrong line. Wrapping here rather than leaving
       * it to Word is the only way to know where the breaks are, and therefore the only way to put
       * a blank in the gutter opposite each one.
       *
       * Blank rather than a continuation mark, deliberately: a real empty line in the output still
       * carries its own number, so "numbered" and "blank" already distinguish the two without
       * putting a glyph in the gutter that the reader has to be taught.
       */
      const rows = [];
      for (const [index, line] of lines.entries()) {
        const number = numbers ? numbers[index] : index + 1;
        const isMarked = marked.has(number);
        const tokens = this.#codeLineTokens(OoxmlWriter.#expandTabs(line), language);
        const wrapped = OoxmlWriter.#wrapTokens(tokens, columns);
        for (const [part, rowTokens] of wrapped.entries()) {
          rows.push({ tokens: rowTokens, marked: isMarked, number, continuation: part > 0 });
        }
      }

      runs = rows
        .map((row) => this.#codeRowRuns(row.tokens, { theme, marked: row.marked }))
        .join('<w:r><w:br/></w:r>');

      if (numbered) {
        const label = (row) => {
          if (row.continuation) return '';
          return row.number === 0 ? OoxmlWriter.#ELISION : String(row.number);
        };
        gutter = {
          runs: rows
            .map((row) =>
              this.#textRun(
                label(row),
                {
                  mono: true,
                  size: 18,
                  color: row.marked ? theme.accent : (theme.gutter ?? theme.border),
                },
                false
              )
            )
            .join('<w:r><w:br/></w:r>'),
          /*
           * Wide enough for the longest number it will print, and no wider.
           *
           * The largest *number*, not the row count — a pane showing forty rows of a four-hundred
           * line sweep prints 187 in a column sized for 40, and the number wraps. Worked out
           * before the wrapping above, which needs to know what is left for the code.
           */
          width: gutterWidth,
        };
      }
    }

    const edge = (side, color = theme.border) =>
      `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`;

    const tblPr =
      '<w:tblPr>' +
      `<w:tblW w:w="${width}" w:type="dxa"/>` +
      (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '') +
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH'].map((side) => edge(side)).join('') +
      /* The rule between the gutter and the code, which is the only inside edge a pane has. */
      edge('insideV', theme.gutterRule ?? theme.border) +
      '</w:tblBorders>' +
      `<w:shd w:val="clear" w:color="auto" w:fill="${theme.fill}"/>` +
      '<w:tblLayout w:type="fixed"/>' +
      // Interior padding — the difference between a code pane and shaded text.
      '<w:tblCellMar>' +
      '<w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/>' +
      '<w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/>' +
      '</w:tblCellMar>' +
      '</w:tblPr>';

    /*
     * Both cells share this paragraph shape, and they have to: the rows only line up because the
     * gutter and the code are the same font at the same size on the same single-spaced line, each
     * broken by `<w:br/>` at the same points. Change the spacing in one and the numbers walk away
     * from the lines they are counting.
     */
    const paragraph = (body, align) =>
      '<w:p><w:pPr>' +
      (align ? `<w:jc w:val="${align}"/>` : '') +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      `<w:rPr><w:rFonts w:ascii="${this.monoFont}" w:hAnsi="${this.monoFont}" w:cs="${this.monoFont}"/>` +
      `<w:color w:val="${theme.text}"/><w:sz w:val="18"/></w:rPr>` +
      '</w:pPr>' +
      body +
      '</w:p>';

    const cell = (cellWidth, body, { align, noWrap } = {}) =>
      '<w:tc><w:tcPr>' +
      `<w:tcW w:w="${cellWidth}" w:type="dxa"/>` +
      `<w:shd w:val="clear" w:color="auto" w:fill="${theme.fill}"/>` +
      (noWrap ? '<w:noWrap/>' : '') +
      '<w:vAlign w:val="top"/>' +
      '</w:tcPr>' +
      paragraph(body, align) +
      '</w:tc>';

    const codeWidth = gutter ? width - gutter.width : width;
    const grid = gutter
      ? `<w:tblGrid><w:gridCol w:w="${gutter.width}"/><w:gridCol w:w="${codeWidth}"/></w:tblGrid>`
      : `<w:tblGrid><w:gridCol w:w="${width}"/></w:tblGrid>`;

    this.blocks.push(
      '<w:tbl>' +
        tblPr +
        grid +
        '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        (gutter ? cell(gutter.width, gutter.runs, { align: 'right', noWrap: true }) : '') +
        cell(codeWidth, runs) +
        '</w:tr>' +
        '</w:tbl>'
    );
    // Word requires a paragraph after a table.
    this.blocks.push('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>');
  }

  #list(node, ctx) {
    const ordered = node.tag === 'ol';
    /*
     * Every `<ol>` gets its own numbering instance, so it starts at 1.
     *
     * A numbering instance counts continuously wherever it is used, so sharing one across the
     * document meant the second numbered list carried on from the first — finding 3's
     * remediation steps started at 4. `newOrderedList()` allocates an instance with an
     * explicit restart; without an assembler (an HTML render, or a preview) there is nothing
     * to allocate from and the shared id is the old behaviour.
     */
    const numId = ordered
      ? (this.parts?.newOrderedList?.() ?? this.numbering?.orderedNumId)
      : this.numbering?.bulletNumId;
    const ilvl = Math.min(ctx.ilvl ?? 0, 8);
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tag === 'li') {
        this.#listItem(child, { ...ctx, ilvl }, numId);
      } else if (child.tag === 'ul' || child.tag === 'ol') {
        this.#list(child, { ...ctx, ilvl: ilvl + 1 });
      }
    }
  }

  #listItem(li, ctx, numId) {
    const ilvl = Math.min(ctx.ilvl ?? 0, 8);
    const inlineChildren = [];
    const nestedBlocks = [];
    for (const child of li.children) {
      if (child.type === 'element' && BLOCK_TAGS.has(child.tag)) nestedBlocks.push(child);
      else inlineChildren.push(child);
    }

    // TipTap wraps list-item text in <p>; unwrap the first one so the bullet
    // and its text share a paragraph.
    if (inlineChildren.length === 0 && nestedBlocks.length && nestedBlocks[0].tag === 'p') {
      inlineChildren.push(...nestedBlocks.shift().children);
    }

    const runs = this.#inline(inlineChildren, {});
    const props = { style: this.#style('ListParagraph') ?? undefined, ilvl };
    if (numId !== undefined) props.numId = numId;
    else props.indentLeft = 720 * (ilvl + 1);
    this.#paragraph(runs, props);

    for (const block of nestedBlocks) {
      if (block.tag === 'ul' || block.tag === 'ol') this.#list(block, { ...ctx, ilvl: ilvl + 1 });
      else this.#block(block, { ...ctx, indent: 720 * (ilvl + 2) });
    }
  }

  /**
   * The caption line over a table: "Table 3", or "Table 3 — Hosts in scope".
   *
   * **Above** the table, where a figure's goes below. That is the convention every style guide
   * agrees on, and it has a reason: a reader meets a figure and then asks what it was, and meets a
   * table and needs to know what the columns are before reading them.
   *
   * Numbered off `SEQ Table`, which is Word's own counter and a different one from `SEQ Figure` —
   * so Table 3 can sit beside Figure 7 and neither is wrong, and a table of tables built by Word
   * finds them. Like a figure's, the number here is the cached one; the field renumbers itself if
   * somebody edits the document afterwards. See `figure-fields.js`.
   *
   * `keepNext`, without which the caption can be the last line on a page and the table it names
   * the first thing on the next one.
   */
  #tableCaption(children) {
    const style = this.#style(this.captionStyle);
    const marks = style ? {} : { italic: true, size: 17, color: '6B7280' };
    const text = children ? this.#inline(children, marks) : '';

    let prefix = '';
    if (this.tableNumbering && this.parts) {
      prefix = captionPrefix({
        ...this.parts.tableBookmark(),
        label: this.tableLabel,
        sequence: 'Table',
        separator: text.trim() ? ' — ' : '',
        rPr: style ? '' : this.#runProps(marks),
      });
    }
    if (!prefix && !text.trim()) return;

    this.#paragraph(prefix + text, { style: style ?? undefined, keepNext: true });
  }

  /**
   * A callout box: one cell, shaded, with a coloured bar down its left edge.
   *
   * A table rather than a shaded paragraph, for the reason `#codeBlock` is one: only a cell can
   * carry interior margins, and text flush against a coloured edge does not read as a box. The
   * left border is heavier than the others and in the accent colour, which is what makes it
   * scannable when somebody is flicking through looking for the warnings.
   *
   * The label is a run rather than a separate paragraph, so a one-line callout is one line. It is
   * bold and coloured and the body follows it on the same line, which is how every style guide
   * that has an opinion sets these.
   *
   * `cantSplit` so a three-line warning is never broken across a page — the half a reader sees
   * first would be the half without the word "Warning" in it.
   */
  #callout(node, ctx) {
    const kind = String(node.attrs['data-callout'] ?? 'note').toLowerCase();
    const style = CALLOUTS[kind] ?? CALLOUTS.note;
    const width = Math.max(1200, this.usableTwips - (ctx.indent || 0));

    /*
     * Rendered through a child writer, so a callout can hold what a callout holds: a list, a code
     * pane, a second paragraph. Handing the children to `#inline` instead would flatten all of
     * that into one run, which is the version somebody notices a week later.
     */
    const inner = new OoxmlWriter(this.#childOptions());
    inner.render(node.children, { ...ctx, indent: 0 });
    if (!inner.blocks.length) return;

    /*
     * The label goes on the first paragraph rather than above it, and is injected rather than
     * composed, because the first block might be a list item or a table — in which case there is
     * no sentence to prefix and the label takes a line of its own.
     */
    const marks = { bold: true, color: style.text };
    const label = this.#textRun(`${style.label}  `, marks);
    const first = inner.blocks[0];
    if (first.startsWith('<w:p>') && !first.includes('<w:numPr')) {
      inner.blocks[0] = first.replace(
        first.startsWith('<w:p><w:pPr>') ? /^(<w:p><w:pPr>.*?<\/w:pPr>)/ : /^(<w:p>)/,
        (match) => `${match}${label}`
      );
    } else {
      inner.blocks.unshift(`<w:p>${label}</w:p>`);
    }

    const edge = (side, sz, color) =>
      `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`;

    this.blocks.push(
      '<w:tbl><w:tblPr>' +
        `<w:tblW w:w="${width}" w:type="dxa"/>` +
        (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '') +
        '<w:tblBorders>' +
        /* The left edge is the callout. The rest is a hairline so the box has an outline at all. */
        edge('left', '24', style.border) +
        ['top', 'bottom', 'right'].map((side) => edge(side, '2', style.border)).join('') +
        '</w:tblBorders>' +
        `<w:shd w:val="clear" w:color="auto" w:fill="${style.fill}"/>` +
        '<w:tblLayout w:type="fixed"/>' +
        '<w:tblCellMar>' +
        '<w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/>' +
        '<w:bottom w:w="120" w:type="dxa"/><w:right w:w="180" w:type="dxa"/>' +
        '</w:tblCellMar>' +
        '</w:tblPr>' +
        `<w:tblGrid><w:gridCol w:w="${width}"/></w:tblGrid>` +
        '<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr>' +
        `<w:tcW w:w="${width}" w:type="dxa"/>` +
        `<w:shd w:val="clear" w:color="auto" w:fill="${style.fill}"/>` +
        '</w:tcPr>' +
        inner.blocks.join('') +
        '</w:tc></w:tr></w:tbl>'
    );
    // Word requires a paragraph after a table.
    this.blocks.push('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>');
  }

  #table(node, ctx) {
    /*
     * A `<caption>`, or the paragraph the editor marked as one, or nothing.
     *
     * Taken first thing and taken whatever happens next, so that a table this method goes on to
     * decline — no rows, no columns — does not leave its caption lying around for the next table
     * in the field to pick up and print under the wrong name.
     *
     * Deliberately not the figure rule. Every picture is a numbered figure whether anybody
     * captioned it or not, because a report has fifty screenshots and almost none of them will
     * have a caption — but a write-up is full of small tables that are part of a sentence, a
     * two-row comparison inside a paragraph, and numbering those would produce "Table 14" for
     * something no reader will ever look up. A table worth pointing at is one somebody named.
     */
    const element = node.children?.find((n) => n.type === 'element' && n.tag === 'caption');
    const caption = element ? element.children : this.pendingTableCaption;
    this.pendingTableCaption = null;

    const rows = [];
    const collectRows = (n) => {
      for (const child of n.children ?? []) {
        if (child.type !== 'element') continue;
        if (child.tag === 'tr') rows.push(child);
        else if (['thead', 'tbody', 'tfoot'].includes(child.tag)) collectRows(child);
      }
    };
    collectRows(node);
    if (!rows.length) return;

    const columnCount = rows.reduce((max, row) => {
      const cells = row.children.filter(
        (c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')
      );
      const span = cells.reduce((sum, c) => sum + Math.max(1, Number(c.attrs.colspan) || 1), 0);
      return Math.max(max, span);
    }, 0);
    if (!columnCount) return;

    /* Drawn now that there is definitely a table under it. */
    if (caption) this.#tableCaption(caption);

    // The template's own text column, not a fixed 6.5 inches.
    const totalWidth = this.usableTwips;
    /*
     * The widths the author dragged the columns to, scaled to this document's text column.
     *
     * The editor has column resizing on and ProseMirror records the result as `colwidth` on each
     * cell, one number per column the cell spans. All of it used to be discarded here in favour of
     * an equal split, so "Host | Port | Service | Notes" printed as four equal columns and the
     * work somebody did to make the table readable was thrown away at the boundary.
     *
     * Scaled rather than converted, deliberately. `colwidth` is in the editor's CSS pixels, and
     * the editor is whatever width the browser window was — a number that means nothing about an
     * A4 page. What survives the trip is the *ratio* between the columns, which is the thing the
     * author was actually expressing.
     */
    const widths = columnWidths(rows, columnCount, totalWidth);
    /** The equal split, still, for everything that does not know its own width. */
    const colWidth = Math.floor(totalWidth / columnCount);

    const border = (side) =>
      `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
    const tblPr =
      '<w:tblPr>' +
      '<w:tblStyle w:val="TableGrid"/>' +
      '<w:tblW w:w="5000" w:type="pct"/>' +
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') +
      '</w:tblBorders>' +
      '<w:tblLayout w:type="fixed"/>' +
      '</w:tblPr>';
    const tblGrid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;

    const rowXml = rows
      .map((row) => {
        const cells = row.children.filter(
          (c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')
        );
        const isHeaderRow = cells.length > 0 && cells.every((c) => c.tag === 'th');
        /* Which column each cell starts at, so a spanning cell can add up the right ones. */
        let column = 0;
        const cellXml = cells
          .map((cell) => {
            const span = Math.max(1, Number(cell.attrs.colspan) || 1);
            const at = column;
            column += span;
            /* A cell is as wide as the columns it covers — not as wide as one of them times n,
             * which is the same number only while every column is the same width. */
            const cellWidth = widths
              .slice(at, at + span)
              .reduce((sum, w) => sum + w, 0) || colWidth * span;
            const rowSpan = Number(cell.attrs.rowspan) || 1;
            const cellStyle = parseStyle(cell.attrs.style);
            const fill =
              normaliseColor(cellStyle['background-color']) ?? (cell.tag === 'th' ? 'F2F2F2' : null);

            /*
             * A cell's writer measures against the cell, not against the page.
             *
             * Everything nested inherits this: an image, a code pane, a table inside a table. It
             * used to inherit the parent's full text column, so a screenshot pasted into one half
             * of a two-column table was laid out at the width of the whole page and spilled out of
             * the cell it was in — which is why "put them side by side" was not something anybody
             * could do with the table they already had.
             *
             * Word's default cell margin is 108 twips each side; taking both off keeps the picture
             * inside the rule rather than touching it.
             */
            const inner = new OoxmlWriter({
              ...this.#childOptions(),
              usableTwips: Math.max(720, cellWidth - 216),
            });
            if (this.#hasBlockChild(cell.children)) {
              inner.render(cell.children, { ilvl: 0, indent: 0 });
            } else {
              const runs = inner.#inline(cell.children, { bold: cell.tag === 'th' });
              inner.#paragraph(runs, { align: ALIGN_MAP[cellStyle['text-align']] });
            }
            // Every table cell must contain at least one paragraph.
            const content = inner.blocks.length ? inner.blocks.join('') : '<w:p/>';

            const tcPr =
              '<w:tcPr>' +
              `<w:tcW w:w="${cellWidth}" w:type="dxa"/>` +
              (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') +
              (rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '') +
              (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '') +
              '<w:vAlign w:val="center"/>' +
              '</w:tcPr>';
            return `<w:tc>${tcPr}${content}</w:tc>`;
          })
          .join('');
        const trPr = isHeaderRow ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
        return `<w:tr>${trPr}${cellXml}</w:tr>`;
      })
      .join('');

    this.blocks.push(`<w:tbl>${tblPr}${tblGrid}${rowXml}</w:tbl>`);
    // Word requires a paragraph after a table, otherwise the document is invalid.
    this.blocks.push('<w:p/>');
  }
}

/** Injects a pStyle into a paragraph that does not already declare one. */
function applyStyleIfMissing(paragraphXml, styleName, indent) {
  if (!paragraphXml.startsWith('<w:p>') || paragraphXml.includes('<w:pStyle')) return paragraphXml;
  const props = `<w:pStyle w:val="${styleName}"/>${indent ? `<w:ind w:left="${indent}"/>` : ''}`;
  if (paragraphXml.startsWith('<w:p><w:pPr>')) {
    return paragraphXml.replace('<w:p><w:pPr>', `<w:p><w:pPr>${props}`);
  }
  return paragraphXml.replace('<w:p>', `<w:p><w:pPr>${props}</w:pPr>`);
}

/**
 * @param {string} html
 * @param {object} [options] see {@link OoxmlWriter}
 * @returns {string} block-level WordprocessingML, always at least one paragraph
 */
export function htmlToOoxml(html, options = {}) {
  if (typeof html !== 'string' || html.trim() === '') return '<w:p/>';
  const tree = parseHtml(html);
  const writer = new OoxmlWriter(options);
  writer.render(tree.children, { ilvl: 0, indent: 0 });
  return writer.blocks.length ? writer.blocks.join('') : '<w:p/>';
}

/** Wraps plain text (possibly multi-line) as paragraphs. */
export function textToOoxml(text, options = {}) {
  const value = String(text ?? '');
  if (value.trim() === '') return '<w:p/>';
  const writer = new OoxmlWriter(options);
  for (const line of value.split(/\r?\n/)) {
    writer.render([{ type: 'element', tag: 'p', attrs: {}, children: [{ type: 'text', value: line }] }]);
  }
  return writer.blocks.join('');
}

export { escapeXml };
export default htmlToOoxml;
