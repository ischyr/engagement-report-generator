/**
 * The pictures in a write-up, found where they live.
 *
 * Evidence sits inside the prose — a `<figure><img><figcaption>` between two paragraphs, or just a
 * screenshot pasted into its own line — and three things need to know where each one is: the
 * numbering that turns it into "Figure 12", the references that point at it, and the check that
 * warns when a sentence points at one that has gone.
 *
 * This file used to serve a Figures panel as well, with buttons to caption and reorder from
 * outside the editor. That panel is gone: captioning belongs in the editor, where selecting an
 * image already offers it, and numbering removed the reason it had to be done at all — every
 * picture is a numbered figure now whether anybody captions it or not, so there is nothing to keep
 * on top of.
 *
 * **Why this is string surgery and not a parse.** The OOXML layer has an HTML *parser* and no HTML
 * *writer*: converting to a tree and back would mean writing a serialiser, and a serialiser that is
 * even slightly lossy rewrites everybody's evidence the first time anything touches it. Nothing
 * here rewrites at all — it reads positions out of the stored markup and leaves it exactly as it
 * found it.
 */

/** A `<figure>` block, or a bare `<img>` that never got one. Figures written here do not nest. */
const FIGURE = /<figure\b[^>]*>[\s\S]*?<\/figure>|<img\b[^>]*>/gi;
const MEDIA_ID = /\/api\/media\/([0-9a-f]{24})/i;
const attribute = (tag, name) =>
  new RegExp(`${name}="([^"]*)"`, 'i').exec(tag)?.[1] ??
  new RegExp(`${name}='([^']*)'`, 'i').exec(tag)?.[1] ??
  '';

const decode = (value) =>
  String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const encode = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Every picture in one field, in the order a reader meets them. */
export function figuresIn(html, field = '') {
  const out = [];
  for (const match of String(html ?? '').matchAll(FIGURE)) {
    const block = match[0];
    const img = /<img\b[^>]*>/i.exec(block)?.[0] ?? '';
    const src = attribute(img, 'src');
    out.push({
      field,
      index: out.length,
      at: match.index,
      length: block.length,
      media: MEDIA_ID.exec(src)?.[1]?.toLowerCase() ?? '',
      src,
      alt: decode(attribute(img, 'alt')),
      /*
       * Two places a caption can be, because the editor writes one and pasted HTML may carry the
       * other. `figcaption` wins: it is what the document actually shows.
       */
      caption:
        decode(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(block)?.[1]?.replace(/<[^>]+>/g, '') ?? '') ||
        decode(attribute(img, 'data-caption')),
      isFigure: /^<figure/i.test(block),
    });
  }
  return out;
}

/**
 * A reference to a figure, written in the prose.
 *
 * `<span data-figref="<media id>">the caption</span>`, produced by the editor's figure chip. The
 * text inside is the caption as it read when the reference was written — it is what the author
 * sees while writing, and what a reader gets if numbering is ever switched off.
 */
const REFERENCE = /<span\b[^>]*\bdata-figref="([0-9a-f]{24})"[^>]*>([\s\S]*?)<\/span>/gi;

/** Every reference in one field, in reading order. */
export function referencesIn(html, field = '') {
  const out = [];
  for (const match of String(html ?? '').matchAll(REFERENCE)) {
    out.push({
      field,
      at: match.index,
      length: match[0].length,
      media: match[1].toLowerCase(),
      text: decode(match[2].replace(/<[^>]+>/g, '')),
    });
  }
  return out;
}

/** The same, across every field of a record that carries editor HTML. */
export function referencesOf(record, fields) {
  return fields.flatMap((field) => referencesIn(record?.[field] ?? '', field));
}

/**
 * References with nothing to point at any more.
 *
 * The picture was deleted after the sentence that mentioned it was written, which is a thing that
 * happens and which nothing could previously notice. Reported by `preflight` before anybody
 * generates, because the alternative is finding out from the document.
 *
 * @param {object} record a finding, or anything with the same rich-text fields
 * @param {string[]} fields which of its fields to read
 */
export function danglingReferences(record, fields) {
  /*
   * Every picture in the report is numbered, wherever it sits — so a reference can only dangle for
   * one reason now, which is that the picture is not there any more. This used to have a second
   * case for a picture inside a sentence, back when those were left unnumbered; that rule is gone
   * and so is the case.
   */
  const present = new Set(
    figuresOf(record, fields)
      .map((figure) => figure.media)
      .filter(Boolean)
  );

  return referencesOf(record, fields)
    .filter((reference) => !present.has(reference.media))
    .map((reference) => ({ ...reference, why: 'that picture is gone' }));
}

/**
 * Numbers every picture in a finished HTML report, and resolves the references to them.
 *
 * The same job `figure-fields.js` does for Word, and for the same reason it is done here rather
 * than field by field: the number depends on document order, and the template decides that. This
 * runs over the rendered page, once.
 *
 * *Every* picture, captioned or not. An engagement with fifty screenshots in it will have written
 * captions for almost none of them, and a picture nobody can refer to is a picture the prose has
 * to describe as "the screenshot below" — which stops being true the moment anything moves.
 *
 * The HTML deliverable has no field mechanism, so unlike the Word path these numbers are final —
 * which is fine, because nobody edits an HTML report and expects it to renumber itself. What it
 * gains instead is a real link: a reference is an `<a href="#fig-…">`, so clicking "Figure 7"
 * goes there.
 */
export function numberFiguresHtml(html, { label = 'Figure' } = {}) {
  const source = String(html ?? '');

  /*
   * Marked first, numbered afterwards — the same order of operations as the Word path, and for
   * the same reason.
   *
   * The first attempt numbered each figure as it rewrote it, which meant a `<figure>` block got
   * its number before a loose screenshot that sits above it in the page: figure 1 appeared below
   * figure 2. Marking is per-picture and can happen in any order; *numbering* has to be a single
   * walk over the finished markup, because that is the only thing that knows what document order
   * is.
   */
  const mark = (media, existing = '') =>
    `<span class="engy-figure-number" data-fignum="${media}"></span>${
      existing.trim() ? ` — ${existing}` : ''
    }`;

  /*
   * Figures first, then the loose screenshots.
   *
   * Two passes because a `<figure>` contains an `<img>`, and the second pass must not find it
   * again and caption it twice. The finished figures are held aside behind a placeholder no
   * document can contain, and put back before the numbering walk.
   */
  const held = [];
  let out = source.replace(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/gi, (whole, attrs, inner) => {
    const media = MEDIA_ID.exec(inner)?.[1]?.toLowerCase() ?? '';
    const anchor = media ? ` id="fig-${media}"` : '';

    const body = /<figcaption([^>]*)>([\s\S]*?)<\/figcaption>/i.test(inner)
      ? inner.replace(
          /<figcaption([^>]*)>([\s\S]*?)<\/figcaption>/i,
          (_all, capAttrs, text) => `<figcaption${capAttrs}>${mark(media, text)}</figcaption>`
        )
      : `${inner}<figcaption>${mark(media)}</figcaption>`;

    held.push(`<figure${attrs}${anchor}>${body}</figure>`);
    return `\u0000FIG${held.length - 1}\u0000`;
  });

  /*
   * A paragraph that is nothing but pictures is evidence, and evidence gets numbered — this is how
   * a screenshot pasted straight into a write-up becomes "Figure 12" without anybody typing a
   * caption. A picture *inside* a sentence is left alone: it is an icon in the prose, not a figure,
   * and numbering it would interrupt the sentence it belongs to.
   */
  out = out.replace(/<(p|div)\b([^>]*)>\s*(?:<img\b[^>]*>\s*)+<\/\1>/gi, (whole, tag, attrs) => {
    const images = whole.match(/<img\b[^>]*>/gi) ?? [];
    return images
      .map((img) => {
        const media = MEDIA_ID.exec(attribute(img, 'src'))?.[1]?.toLowerCase() ?? '';
        /* Not stored evidence: it will not travel, so it is not a figure either. */
        if (!media) return `<${tag}${attrs}>${img}</${tag}>`;
        return `<figure id="fig-${media}">${img}<figcaption>${mark(media)}</figcaption></figure>`;
      })
      .join('');
  });

  /*
   * Everything else: a screenshot after a label, one in a list item, one in a table cell.
   *
   * The caption goes at the end of the block that holds the picture rather than immediately after
   * the picture itself, so it matches what the Word path does — there a caption is a paragraph, and
   * a paragraph cannot start in the middle of a sentence. Two pictures in one block get two
   * captions, in order, at the end of it.
   */
  out = out.replace(
    /<(p|li|td|th|div)\b([^>]*)>((?:(?!<\1[\s>])[\s\S])*?)<\/\1>/gi,
    (whole, tag, attrs, inner) => {
      const images = (inner.match(/<img\b[^>]*>/gi) ?? []).filter((img) =>
        MEDIA_ID.test(attribute(img, 'src'))
      );
      if (!images.length) return whole;
      const captions = images
        .map((img) => {
          const media = MEDIA_ID.exec(attribute(img, 'src'))[1].toLowerCase();
          return `<span class="engy-figure-loose" id="fig-${media}">${mark(media)}</span>`;
        })
        .join('');
      return `<${tag}${attrs}>${inner}${captions}</${tag}>`;
    }
  );

  out = out.replace(/\u0000FIG(\d+)\u0000/g, (_whole, index) => held[Number(index)]);

  /* Now, and only now, document order is knowable: it is the order these marks appear. */
  const numbers = new Map();
  out = out.replace(
    /<span class="engy-figure-number" data-fignum="([^"]*)"><\/span>/g,
    (_whole, media) => {
      const key = media || `anonymous-${numbers.size + 1}`;
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
      return `<span class="engy-figure-number">${encode(label)} ${numbers.get(key)}</span>`;
    }
  );

  let referenced = 0;
  const missing = [];
  out = out.replace(REFERENCE, (whole, media, text) => {
    const number = numbers.get(String(media).toLowerCase());
    if (!number) {
      missing.push(String(media).toLowerCase());
      /* Visible, like the Word path: a sentence that quietly lost its reference reads as complete. */
      return '<span class="engy-figure-missing">(figure removed)</span>';
    }
    referenced += 1;
    return `<a class="engy-figure-ref" href="#fig-${media}">${encode(label)} ${number}</a>`;
  });

  return { html: out, count: numbers.size, referenced, missing };
}

/** The same, across every field of a record that carries editor HTML. */
export function figuresOf(record, fields) {
  return fields.flatMap((field) => figuresIn(record?.[field] ?? '', field));
}

export default {
  figuresIn,
  figuresOf,
  referencesIn,
  referencesOf,
  danglingReferences,
  numberFiguresHtml,
};
