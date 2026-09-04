/**
 * Making a screenshot weigh what it needs to weigh.
 *
 * A 4K screenshot is about eight megapixels. Printed into a report it lands in a text column six
 * and a bit inches wide, where roughly sixteen hundred pixels across is already more than any
 * printer resolves — so seven of those eight megapixels are bytes that nobody, on any device, will
 * ever see. Forty of them make a .docx that no mail server will accept: Gmail refuses attachments
 * over 25 MB, and the report now goes out by email.
 *
 * So images are shrunk **in the browser, before they are uploaded**, and the server keeps what it
 * is given. Three reasons that is the right side of the wire:
 *
 *   - the browser already has a decoder for every format it will accept, and the alternative was a
 *     hand-written PNG and JPEG decoder on the server, which is a great deal of code to get subtly
 *     wrong on somebody's evidence
 *   - the person who pasted it is still there, so the app can say what it did
 *   - nothing needs to be stored twice
 *
 * **PNG first, JPEG only for photographs.** A pentest screenshot is mostly text on flat colour:
 * PNG compresses that far better than JPEG *and* keeps it legible, where JPEG puts ringing around
 * every glyph. So both are encoded and PNG wins unless it is much the larger, which in practice
 * only happens when the image is a photograph. Getting this backwards would save bytes and cost the
 * one thing a screenshot is for.
 *
 * The arithmetic is separated from the canvas work so it can be tested without a browser — see
 * `npm run test:images`.
 */
import { formatBytes } from './utils.js';

/**
 * What counts as enough.
 *
 * `maxEdge` is the number that matters. An A4 page with 2.5 cm margins leaves a text column of
 * 9070 twips — 6.3 inches — which the report writer already computes for itself. 1600 pixels
 * across that column is about 254 dpi, comfortably past the 220–300 a print shop asks for and
 * roughly three times what a screen shows. It is a ceiling rather than a target: a smaller image
 * is left alone.
 */
export const IMAGE_LIMITS = {
  maxEdge: 1600,
  /** Below this, re-encoding is as likely to add bytes as remove them. */
  skipUnderBytes: 200 * 1024,
  jpegQuality: 0.85,
  /**
   * How much bigger PNG may be before the image is treated as a photograph.
   *
   * Generous on purpose, because the cost of being wrong is asymmetric: a slightly larger PNG of a
   * terminal is a fine outcome, a JPEG of one is a smeared, ringing mess that somebody has to
   * re-take.
   */
  pngTolerance: 1.6,
};

/** Formats where re-encoding would lose something that matters. */
const LEAVE_ALONE = new Set(['image/gif', 'image/svg+xml', 'image/avif', 'image/heic', 'image/heif']);

/**
 * Whether an image is worth touching, and what size it should become.
 *
 * Pure arithmetic: no canvas, no file, no browser. Everything that decides *whether* to re-encode
 * lives here so it can be asserted directly.
 *
 * @param {{type?: string, bytes?: number, width?: number, height?: number}} image
 * @param {typeof IMAGE_LIMITS} [limits]
 * @returns {{resize: boolean, width: number, height: number, scale: number, reason: string}}
 */
export function planResize(image, limits = IMAGE_LIMITS) {
  const type = String(image?.type ?? '').toLowerCase();
  const width = Number(image?.width) || 0;
  const height = Number(image?.height) || 0;
  const bytes = Number(image?.bytes) || 0;
  const keep = (reason) => ({ resize: false, width, height, scale: 1, reason });

  if (!type.startsWith('image/')) return keep('not an image');
  if (LEAVE_ALONE.has(type)) return keep('a format that would lose something');
  if (!width || !height) return keep('dimensions unknown');

  const longest = Math.max(width, height);
  /*
   * Small *and* light is left exactly as it was. Either alone is not enough: a 400×300 PNG that
   * somehow weighs 4 MB is worth re-encoding, and a 6000-pixel-wide screenshot is worth scaling
   * even when it happens to compress well.
   */
  if (longest <= limits.maxEdge && bytes <= limits.skipUnderBytes) return keep('already small');

  const scale = Math.min(1, limits.maxEdge / longest);
  return {
    resize: true,
    /* Never upscale, and never round to zero. */
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    reason: scale < 1 ? 'larger than the page can print' : 'heavier than it needs to be',
  };
}

/** Which of the encodings to keep. Exported for the same reason `planResize` is. */
export function chooseEncoding({ pngBytes, jpegBytes, hasAlpha }, limits = IMAGE_LIMITS) {
  if (hasAlpha) return 'png';
  if (!jpegBytes) return 'png';
  if (!pngBytes) return 'jpeg';
  return pngBytes <= jpegBytes * limits.pngTolerance ? 'png' : 'jpeg';
}

const canDecode = () =>
  typeof createImageBitmap === 'function' && typeof document !== 'undefined';

/** Any pixel that is not fully opaque means JPEG would flatten it onto black. */
function hasTransparency(context, width, height) {
  try {
    const { data } = context.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
    return false;
  } catch {
    /* A tainted canvas cannot be read; assume alpha and keep PNG, which is the safe answer. */
    return true;
  }
}

const encode = (canvas, type, quality) =>
  new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob ?? null), type, quality);
    } catch {
      resolve(null);
    }
  });

/**
 * Shrinks one image file, or hands back exactly what it was given.
 *
 * Never throws and never returns something worse: if anything at all goes wrong — an unreadable
 * file, a browser without `createImageBitmap`, an encoder that produces more bytes than it was
 * given — the original file comes back untouched. Losing a screenshot to save a few hundred
 * kilobytes would be a terrible trade.
 *
 * @param {File|Blob} file
 * @param {typeof IMAGE_LIMITS} [limits]
 * @returns {Promise<{file: File|Blob, changed: boolean, before: object, after: object,
 *   note: string}>}
 */
export async function shrinkImage(file, limits = IMAGE_LIMITS) {
  const before = { bytes: file?.size ?? 0, width: null, height: null, type: file?.type ?? '' };
  const unchanged = (note) => ({ file, changed: false, before, after: before, note });

  if (!file || !canDecode()) return unchanged('this browser cannot re-encode images');
  if (!String(file.type ?? '').startsWith('image/')) return unchanged('not an image');
  if (LEAVE_ALONE.has(String(file.type).toLowerCase())) return unchanged('left as it is');

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return unchanged('could not be decoded');
  }

  try {
    before.width = bitmap.width;
    before.height = bitmap.height;

    const plan = planResize({ ...before, type: file.type }, limits);
    if (!plan.resize) return unchanged(plan.reason);

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return unchanged('no canvas');
    /*
     * The browser's own downscaler, at its best setting. A one-step draw from eight megapixels to
     * two is where a naive resize turns fine text into aliased noise; `imageSmoothingQuality` is
     * the difference between a readable terminal and a grey smear.
     */
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    const alpha = hasTransparency(context, plan.width, plan.height);
    const png = await encode(canvas, 'image/png');
    const jpeg = alpha ? null : await encode(canvas, 'image/jpeg', limits.jpegQuality);

    const pick = chooseEncoding(
      { pngBytes: png?.size ?? 0, jpegBytes: jpeg?.size ?? 0, hasAlpha: alpha },
      limits
    );
    const blob = pick === 'png' ? png : jpeg;
    if (!blob) return unchanged('could not be re-encoded');

    /* A "smaller" image that is bigger than the original is not an improvement. */
    if (blob.size >= before.bytes) return unchanged('already as small as it gets');

    const extension = pick === 'png' ? 'png' : 'jpg';
    const base = String(file.name ?? 'screenshot').replace(/\.[^.]+$/, '') || 'screenshot';
    const shrunk = new File([blob], `${base}.${extension}`, {
      type: pick === 'png' ? 'image/png' : 'image/jpeg',
      lastModified: Date.now(),
    });

    const after = { bytes: shrunk.size, width: plan.width, height: plan.height, type: shrunk.type };
    return {
      file: shrunk,
      changed: true,
      before,
      after,
      note:
        `${before.width}×${before.height} (${formatBytes(before.bytes)}) → ` +
        `${after.width}×${after.height} (${formatBytes(after.bytes)})`,
    };
  } finally {
    bitmap.close?.();
  }
}

/**
 * The same, for a list, reporting what it did in total.
 *
 * Sequential rather than parallel: each one holds a decoded bitmap and two encodings in memory, and
 * forty 4K screenshots at once is how a tab runs out of it.
 */
export async function shrinkImages(files, limits = IMAGE_LIMITS) {
  const out = [];
  let saved = 0;
  let changed = 0;
  for (const file of files) {
    const result = await shrinkImage(file, limits);
    if (result.changed) {
      changed += 1;
      saved += result.before.bytes - result.after.bytes;
    }
    out.push(result);
  }
  return { results: out, files: out.map((entry) => entry.file), changed, saved };
}

export default { shrinkImage, shrinkImages, planResize, chooseEncoding, IMAGE_LIMITS };
