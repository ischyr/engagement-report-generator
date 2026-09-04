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
import { readImageSize, fitToPage } from './image-size.js';
import { captionPrefix, referenceField } from './figure-fields.js';

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
 * Code-block looks. `terminal` renders a dark, padded pane so command output
 * reads as a console session; `light` is a pale reviewer-friendly box; `template`
 * defers to the template's own `CodeBlock` paragraph style if it defines one.
 */
export const CODE_THEMES = {
  terminal: { fill: '0D1117', text: 'E6EDF3', border: '30363D', accent: '7EE787' },
  light: { fill: 'F6F8FA', text: '24292F', border: 'D0D7DE', accent: '116329' },
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
     * Pictures written but not yet captioned, oldest first.
     *
     * Every stored picture becomes a numbered figure, whether or not anybody wrote a caption for
     * it — on an engagement with fifty screenshots almost none of them will have one, and "see the
     * screenshot below" is exactly as useless at fifty as it was at five. So an image is queued
     * here as it is written, and the caption line that follows takes it: the author's words if
     * there are any, the number alone if there are not.
     */
    this.pendingFigures = [];
    /** Set while a caption is being written, so writing one cannot start another. */
    this.suppressCaption = false;
    this.codeTheme = options.codeTheme ?? 'terminal';
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
    // 635 EMU to the twip (914400 per inch / 1440 twips per inch), so evidence is clamped to
    // the real column rather than to a hardcoded six inches.
    const { cx, cy } = fitToPage(px.w, px.h, this.usableTwips * 635);
    const { rId, docPrId, name } = this.parts.addImage(buffer, ext === 'jpeg' ? 'jpg' : ext);

    /*
     * Which picture the next caption belongs to.
     *
     * Stored evidence is keyed by its media id so a reference written anywhere in the report finds
     * it; a pasted data URI has no id and gets one derived from its drawing number, which is unique
     * within the document and cannot be referenced from elsewhere — correctly, because there is
     * nothing stable to reference.
     */
    this.pendingFigures.push(stored ? stored[1].toLowerCase() : `img${docPrId}`);

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

    /* Numbering off and nothing written: there is no caption line to draw. */
    if (!prefix && !text.trim()) return;

    this.#paragraph(prefix + text, { style: style ?? undefined, align });
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

    switch (tag) {
      case 'hr':
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
        this.#codeBlock(children, ctx);
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
      codeTheme: this.codeTheme,
      availableStyles: this.availableStyles,
      // Nested writers draw tables and code panes too, and a cell's writer that fell back to
      // the default would size them for a different page than its parent.
      usableTwips: this.usableTwips,
      media: this.media,
    };
  }

  /**
   * Renders a `<pre>` block.
   *
   * The `terminal` and `light` themes use a one-cell table rather than a shaded
   * paragraph, because only a table cell can carry interior margins — shading a
   * paragraph puts the text flush against the coloured edge, which never looks
   * like a console. The `template` theme instead defers to the document's own
   * `CodeBlock` style so a house style wins.
   */
  #codeBlock(children, ctx) {
    // TipTap wraps code-block content in <code>; unwrap so the text is direct.
    const inner =
      children.length === 1 && children[0].type === 'element' && children[0].tag === 'code'
        ? children[0].children
        : children;

    const templateStyle = this.codeTheme === 'template' ? this.#style('CodeBlock') : null;
    if (templateStyle) {
      this.#paragraph(this.#inline(inner, { code: false, mono: true }, true), {
        style: templateStyle,
        indentLeft: ctx.indent || undefined,
      });
      return;
    }

    const theme = CODE_THEMES[this.codeTheme] ?? CODE_THEMES.terminal;
    // `code: false` so the inline-code shading does not fight the pane colour.
    const runs = this.#inline(inner, { mono: true, color: theme.text, size: 18 }, true);

    const width = Math.max(1200, this.usableTwips - (ctx.indent || 0));
    const edge = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${theme.border}"/>`;

    const tblPr =
      '<w:tblPr>' +
      `<w:tblW w:w="${width}" w:type="dxa"/>` +
      (ctx.indent ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '') +
      `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge).join('')}</w:tblBorders>` +
      `<w:shd w:val="clear" w:color="auto" w:fill="${theme.fill}"/>` +
      '<w:tblLayout w:type="fixed"/>' +
      // Interior padding — the difference between a code pane and shaded text.
      '<w:tblCellMar>' +
      '<w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/>' +
      '<w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/>' +
      '</w:tblCellMar>' +
      '</w:tblPr>';

    const paragraph =
      '<w:p><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      `<w:rPr><w:rFonts w:ascii="${this.monoFont}" w:hAnsi="${this.monoFont}" w:cs="${this.monoFont}"/>` +
      `<w:color w:val="${theme.text}"/><w:sz w:val="18"/></w:rPr>` +
      '</w:pPr>' +
      runs +
      '</w:p>';

    this.blocks.push(
      '<w:tbl>' +
        tblPr +
        `<w:tblGrid><w:gridCol w:w="${width}"/></w:tblGrid>` +
        '<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr>' +
        `<w:tcW w:w="${width}" w:type="dxa"/>` +
        `<w:shd w:val="clear" w:color="auto" w:fill="${theme.fill}"/>` +
        '</w:tcPr>' +
        paragraph +
        '</w:tc></w:tr>' +
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

  #table(node, ctx) {
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

    // The template's own text column, not a fixed 6.5 inches.
    const totalWidth = this.usableTwips;
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
    const tblGrid = `<w:tblGrid>${Array.from({ length: columnCount }, () => `<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>`;

    const rowXml = rows
      .map((row) => {
        const cells = row.children.filter(
          (c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')
        );
        const isHeaderRow = cells.length > 0 && cells.every((c) => c.tag === 'th');
        const cellXml = cells
          .map((cell) => {
            const span = Math.max(1, Number(cell.attrs.colspan) || 1);
            const rowSpan = Number(cell.attrs.rowspan) || 1;
            const cellStyle = parseStyle(cell.attrs.style);
            const fill =
              normaliseColor(cellStyle['background-color']) ?? (cell.tag === 'th' ? 'F2F2F2' : null);

            const inner = new OoxmlWriter(this.#childOptions());
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
              `<w:tcW w:w="${colWidth * span}" w:type="dxa"/>` +
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
