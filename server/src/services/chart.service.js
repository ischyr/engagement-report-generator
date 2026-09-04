/**
 * Charts, drawn here because a Word template cannot draw one.
 *
 * The report data has carried `stats.bySeverity` for a long time — label, count, percent and a
 * colour per severity — and every template did the same thing with it: a table of five numbers.
 * A table of five numbers is not what anybody looks at first in a report, and asking template
 * authors to build a chart out of Word's own charting parts is asking for something nobody will
 * do twice.
 *
 * So the picture is generated. Two shapes, both of which answer "how bad is this" at a glance:
 *
 *   donut         a ring, one arc per severity, sized by share
 *   segmented bar one pill per severity along a single line — the same data where a page has
 *                 width to spare but no height
 *
 * **There is no text inside the image.** That is the whole trick that keeps this honest without a
 * font: the drawing is pure geometry, and the labels come back as a real Word paragraph beside it
 * — real text, in the template's own typeface, selectable, searchable, and correct at any zoom.
 * A hand-rolled bitmap font would have been the alternative, and it would have looked like one.
 *
 * Everything renders at twice its printed size and is placed at half, so the curve of the ring
 * stays a curve on a 300dpi printer rather than the staircase a 1:1 raster gives.
 */
import { encodePng } from '../utils/png.js';
import { escapeXml } from './ooxml/html2ooxml.js';

/** How many sub-samples per pixel, per axis. Nine levels of coverage is plenty for one curve. */
const SAMPLES = 3;

/** Device pixels per printed pixel. See the note above about the printer. */
const SCALE = 2;

const hex = (value) => String(value ?? '').replace('#', '').trim();

function rgbOf(colour) {
  const value = hex(colour);
  const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return { r: 0x88, g: 0x88, b: 0x88 };
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** The slices with something in them. A zero-count severity belongs in the legend, not the ring. */
const drawable = (slices) =>
  (slices ?? [])
    .map((slice) => ({
      label: String(slice?.label ?? ''),
      count: Number(slice?.count) || 0,
      colour: rgbOf(slice?.color),
    }))
    .filter((slice) => slice.count > 0);

/**
 * Paints a canvas by asking `colourAt` what is under each sub-sample.
 *
 * Coverage rather than a hard test: a pixel that is nine-sixteenths inside the ring gets
 * nine-sixteenths of the alpha, which is what makes an edge look like an edge. Colours are
 * averaged over the samples that hit something, so a pixel that straddles two arcs blends them
 * instead of picking a winner.
 *
 * @param {number} width device pixels
 * @param {number} height device pixels
 * @param {(x: number, y: number) => {r:number,g:number,b:number}|null} colourAt
 */
function paint(width, height, colourAt) {
  const rgba = Buffer.alloc(width * height * 4);
  const total = SAMPLES * SAMPLES;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const found = colourAt(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES);
          if (!found) continue;
          r += found.r;
          g += found.g;
          b += found.b;
          hits += 1;
        }
      }

      if (!hits) continue;
      const offset = (py * width + px) * 4;
      rgba[offset] = Math.round(r / hits);
      rgba[offset + 1] = Math.round(g / hits);
      rgba[offset + 2] = Math.round(b / hits);
      rgba[offset + 3] = Math.round((hits / total) * 255);
    }
  }
  return rgba;
}

/**
 * A ring, one arc per slice, clockwise from twelve.
 *
 * @param {{label:string,count:number,color:string}[]} slices
 * @param {{size?:number, thickness?:number, gap?:number}} [options] `size` in printed pixels,
 *   `thickness` as a fraction of the outer radius, `gap` the space between arcs in printed pixels
 * @returns {{buffer: Buffer, width: number, height: number}|null} null when there is nothing to draw
 */
export function donutPng(slices, { size = 300, thickness = 0.34, gap = 4 } = {}) {
  const parts = drawable(slices);
  const total = parts.reduce((sum, slice) => sum + slice.count, 0);
  if (!total) return null;

  const px = Math.round(size * SCALE);
  const centre = px / 2;
  const outer = px * 0.48;
  const inner = outer * (1 - thickness);
  const middle = (outer + inner) / 2;

  /*
   * The gap is a distance, so it has to become an angle somewhere — and the somewhere is the
   * middle of the ring, where an eye reads the join. Measured at the outer edge it would look
   * pinched at the inside; at the inner edge it would look pinched at the outside.
   */
  const gapAngle = parts.length > 1 ? (gap * SCALE) / middle : 0;
  const TAU = Math.PI * 2;

  const arcs = [];
  let cursor = 0;
  for (const slice of parts) {
    const sweep = (slice.count / total) * TAU;
    /*
     * A slice thinner than the gap would be trimmed out of existence, and a severity that was
     * found once must not vanish from the picture of what was found. It keeps a hairline instead.
     */
    const trim = Math.min(gapAngle, Math.max(0, sweep - gapAngle / 4)) / 2;
    arcs.push({ from: cursor + trim, to: cursor + sweep - trim, colour: slice.colour });
    cursor += sweep;
  }

  const rgba = paint(px, px, (x, y) => {
    const dx = x - centre;
    const dy = y - centre;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < inner || distance > outer) return null;

    /* atan2 puts zero at three o'clock and grows clockwise on a screen, where y points down. */
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += TAU;
    if (angle >= TAU) angle -= TAU;

    for (const arc of arcs) {
      if (angle >= arc.from && angle <= arc.to) return arc.colour;
    }
    return null;
  });

  return { buffer: encodePng(rgba, px, px), width: size, height: size };
}

/**
 * The same data as one line of pills — for a page with width to spare and no height.
 *
 * @param {{label:string,count:number,color:string}[]} slices
 * @param {{width?:number, height?:number, gap?:number}} [options] printed pixels throughout
 */
export function segmentedBarPng(slices, { width = 560, height = 14, gap = 3 } = {}) {
  const parts = drawable(slices);
  const total = parts.reduce((sum, slice) => sum + slice.count, 0);
  if (!total) return null;

  const w = Math.round(width * SCALE);
  const h = Math.round(height * SCALE);
  const gapPx = parts.length > 1 ? gap * SCALE : 0;
  const usable = Math.max(1, w - gapPx * (parts.length - 1));

  const segments = [];
  let cursor = 0;
  for (const slice of parts) {
    const span = (slice.count / total) * usable;
    segments.push({ x0: cursor, x1: cursor + span, colour: slice.colour });
    cursor += span + gapPx;
  }

  const rgba = paint(w, h, (x, y) => {
    for (const segment of segments) {
      if (x < segment.x0 || x > segment.x1) continue;
      /* A pill: a rectangle with a half-height cap at each end, or a circle if it is narrower. */
      const radius = Math.min(h / 2, (segment.x1 - segment.x0) / 2);
      const left = segment.x0 + radius;
      const right = segment.x1 - radius;
      if (x >= left && x <= right) return segment.colour;
      const cx = x < left ? left : right;
      const cy = h / 2;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) return segment.colour;
      return null;
    }
    return null;
  });

  return { buffer: encodePng(rgba, w, h), width, height };
}

/**
 * The labels, as text rather than pixels.
 *
 * Every slice appears, zero-count ones included. "Critical 0" is not noise in a penetration test
 * report — it is the sentence the client reads first, and a legend that silently omits it makes
 * the reader count the colours to be sure.
 */
export function legendHtml(slices) {
  const entries = (slices ?? [])
    .filter((slice) => slice && String(slice.label ?? '').trim())
    .map((slice) => {
      const colour = `#${hex(slice.color) || '888888'}`;
      const count = Number(slice.count) || 0;
      return (
        `<span style="color:${colour}">●</span>&nbsp;` +
        `${escapeXml(String(slice.label))}&nbsp;${count}`
      );
    });
  if (!entries.length) return '';
  /* Three spaces between entries: one looks like a typo, and Word eats a run of ordinary ones. */
  return `<p style="text-align:center">${entries.join('&nbsp;&nbsp;&nbsp;')}</p>`;
}

/**
 * A whole chart block as editor HTML — the picture, then its legend.
 *
 * HTML rather than markup for one target, because that is how every other generated block in the
 * report reaches the page: `expandRichFields` hands it to `htmlToOoxml` for a .docx and to
 * `sanitizeHtml` for an HTML report, and both already understand a data-URI image. Nothing here
 * has to know which kind of document it is going into.
 *
 * @param {{label:string,count:number,color:string}[]} slices
 * @param {{kind?: 'donut'|'bar', size?: number, width?: number, alt?: string}} [options]
 * @returns {string} empty when every slice is zero — a template guards with {{#stats.total}}
 */
export function chartBlockHtml(slices, { kind = 'donut', size, width, alt } = {}) {
  const drawn =
    kind === 'bar'
      ? segmentedBarPng(slices, width ? { width } : undefined)
      : donutPng(slices, size ? { size } : undefined);
  if (!drawn) return '';

  const description = escapeXml(alt ?? 'Findings by severity');
  const data = drawn.buffer.toString('base64');
  return (
    `<p style="text-align:center"><img src="data:image/png;base64,${data}" ` +
    `width="${drawn.width}" height="${drawn.height}" alt="${description}"></p>` +
    legendHtml(slices)
  );
}

export default { donutPng, segmentedBarPng, legendHtml, chartBlockHtml };
