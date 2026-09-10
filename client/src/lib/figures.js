/**
 * The pictures in some editor HTML, for the reference picker.
 *
 * A deliberate, small twin of `figures.service.js` on the server. It is not shared code — this
 * repository has no module both halves import — so the shape is kept identical and the division of
 * labour is written down instead:
 *
 * **The server is authoritative.** It decides what a figure is, what its caption says, and what
 * number it gets in the document. Nothing here influences any of that.
 *
 * **This exists to fill a menu.** The picker needs "which screenshots could this sentence point
 * at", across the fields of the finding being written, before anything is saved. Asking the server
 * would mean asking about the saved version, and the picture somebody wants to reference is
 * usually the one they pasted a minute ago.
 *
 * Both are held to the same inputs by `figures-test.js`, so a drift shows up as a failing test
 * rather than as a menu that quietly stops listing something.
 */

const FIGURE = /<figure\b[^>]*>[\s\S]*?<\/figure>|<img\b[^>]*>/gi;
const MEDIA_ID = /\/api\/media\/([0-9a-f]{24})/i;

const decode = (value) =>
  String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const attribute = (tag, name) =>
  new RegExp(`${name}="([^"]*)"`, 'i').exec(tag)?.[1] ??
  new RegExp(`${name}='([^']*)'`, 'i').exec(tag)?.[1] ??
  '';

/**
 * Every picture a sentence could point at, across a record's rich-text fields, in reading order.
 *
 * Captioned or not, and wherever it sits: the report numbers every picture in it — one alone in a
 * paragraph, one after a label, one in a list item or a table cell — so every picture can be
 * referred to.
 *
 * @param {object} record the finding form, or anything with the same fields
 * @param {string[]} fields which of its fields to read, in the order the report prints them
 * @returns {Array<{media:string, caption:string, field:string, index:number}>}
 */
export function referenceableFigures(record, fields) {
  const out = [];
  const seen = new Set();

  for (const field of fields) {
    for (const match of String(record?.[field] ?? '').matchAll(FIGURE)) {
      const block = match[0];
      const img = /<img\b[^>]*>/i.exec(block)?.[0] ?? '';
      const media = MEDIA_ID.exec(attribute(img, 'src'))?.[1]?.toLowerCase() ?? '';
      const caption =
        decode(
          /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i
            .exec(block)?.[1]
            ?.replace(/<[^>]+>/g, '') ?? ''
        ) || decode(attribute(img, 'data-caption'));

      /* No media id means it is not stored evidence and will not travel with the report. */
      if (!media || seen.has(media)) continue;
      seen.add(media);
      out.push({
        media,
        caption,
        /* Something to recognise it by when nobody wrote a caption, which is the common case. */
        label: caption || decode(attribute(img, 'alt')) || '',
        field,
        index: out.length,
      });
    }
  }

  return out;
}

export default { referenceableFigures };
