/** Reads intrinsic pixel dimensions straight out of the image bytes. */
export function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;

  // PNG — IHDR is always the first chunk.
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), ext: 'png' };
  }

  // GIF87a / GIF89a — little-endian logical screen descriptor.
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), ext: 'gif' };
  }

  // BMP
  if (buffer.toString('ascii', 0, 2) === 'BM') {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
      ext: 'bmp',
    };
  }

  // WEBP (VP8/VP8L/VP8X variants)
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const w = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
      const h = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
      return { width: w, height: h, ext: 'webp' };
    }
    if (chunk === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        ext: 'webp',
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        ext: 'webp',
      };
    }
  }

  // JPEG — walk the marker segments looking for a Start-Of-Frame.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          ext: 'jpeg',
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  return null;
}

export const EMU_PER_PIXEL = 9525;
/**
 * 6 inches — the fallback when nobody says how wide the page is.
 *
 * Callers that have read the template's own `w:sectPr` pass the real column width instead;
 * this remains for a preview, an HTML render, or a template whose geometry could not be
 * parsed, where a conservative width is better than a guess that overflows.
 */
export const MAX_IMAGE_WIDTH_EMU = 6 * 914400;

/**
 * Scales pixel dimensions to EMUs, shrinking anything wider than the text column.
 *
 * @param {number} widthPx
 * @param {number} heightPx
 * @param {number} [maxWidthEmu] the page's usable width; defaults to a safe six inches
 */
export function fitToPage(widthPx, heightPx, maxWidthEmu = MAX_IMAGE_WIDTH_EMU) {
  const limit = Number(maxWidthEmu) > 0 ? Math.round(Number(maxWidthEmu)) : MAX_IMAGE_WIDTH_EMU;
  const w = Math.max(1, Math.round(widthPx * EMU_PER_PIXEL));
  const h = Math.max(1, Math.round(heightPx * EMU_PER_PIXEL));
  if (w <= limit) return { cx: w, cy: h };
  const ratio = limit / w;
  return { cx: limit, cy: Math.max(1, Math.round(h * ratio)) };
}

export default readImageSize;
