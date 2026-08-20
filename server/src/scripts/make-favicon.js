/**
 * Draws the app icon and writes it out as favicon.ico, favicon.svg and a
 * PNG for mobile home screens.
 *
 *   npm run make:favicon
 *
 * Everything is generated rather than committed as opaque binaries: the mark is a
 * rounded square in the brand gradient with a white "E", which is a handful of
 * rectangles, so the icon stays editable by changing numbers here. PNG and ICO
 * are both written by hand — neither format needs more than zlib, which Node has.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { ROOT_DIR } from '../config/env.js';
import { log } from '../utils/logger.js';

/* -------------------------------------------------------------------------- */
/* Palette — matches --color-brand-* in the app's stylesheet                   */
/* -------------------------------------------------------------------------- */

const TOP = { r: 0x6d, g: 0x80, b: 0xf5 };
const BOTTOM = { r: 0x41, g: 0x50, b: 0xbd };
const GLYPH = { r: 0xff, g: 0xff, b: 0xff };

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

/** Signed-distance test for a rounded square, in unit coordinates. */
function insideRoundedSquare(x, y, radius) {
  // Fold into one quadrant so a single corner test covers all four.
  const dx = Math.abs(x - 0.5) - (0.5 - radius);
  const dy = Math.abs(y - 0.5) - (0.5 - radius);
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * The letter E as four bars, in unit coordinates. Proportions are chosen so the
 * bars still land on whole pixels at 16px, where rounding is most visible.
 */
const E_BARS = [
  { x0: 0.3, x1: 0.42, y0: 0.26, y1: 0.74 }, // stem
  { x0: 0.3, x1: 0.7, y0: 0.26, y1: 0.38 }, // top
  { x0: 0.3, x1: 0.64, y0: 0.44, y1: 0.56 }, // middle
  { x0: 0.3, x1: 0.7, y0: 0.62, y1: 0.74 }, // bottom
];

const inGlyph = (x, y) =>
  E_BARS.some((bar) => x >= bar.x0 && x <= bar.x1 && y >= bar.y0 && y <= bar.y1);

/**
 * Renders the icon to raw RGBA.
 *
 * Each pixel is supersampled on a 4x4 grid: at 16px the corner curve and the
 * stem edges are only a pixel or two wide, and without averaging they alias into
 * a visibly lumpy shape.
 */
function renderRgba(size) {
  const samples = 4;
  const buffer = Buffer.alloc(size * size * 4);
  const radius = 0.22;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverage = 0;
      let glyphCoverage = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (!insideRoundedSquare(x, y, radius)) continue;
          coverage += 1;
          if (inGlyph(x, y)) glyphCoverage += 1;
        }
      }

      const total = samples * samples;
      const alpha = coverage / total;
      const offset = (py * size + px) * 4;
      if (alpha === 0) continue;

      // Vertical gradient across the tile.
      const t = py / Math.max(1, size - 1);
      const base = {
        r: Math.round(TOP.r + (BOTTOM.r - TOP.r) * t),
        g: Math.round(TOP.g + (BOTTOM.g - TOP.g) * t),
        b: Math.round(TOP.b + (BOTTOM.b - TOP.b) * t),
      };

      // Blend the glyph over the tile by its own coverage.
      const g = coverage > 0 ? glyphCoverage / coverage : 0;
      buffer[offset] = Math.round(base.r + (GLYPH.r - base.r) * g);
      buffer[offset + 1] = Math.round(base.g + (GLYPH.g - base.g) * g);
      buffer[offset + 2] = Math.round(base.b + (GLYPH.b - base.b) * g);
      buffer[offset + 3] = Math.round(alpha * 255);
    }
  }
  return buffer;
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Encodes RGBA pixels as a PNG (colour type 6, 8-bit, no interlacing). */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* ICO                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Encodes RGBA as the DIB an ICO entry expects.
 *
 * Not PNG-in-ICO: browsers read that happily, but the Windows shell imaging path
 * (and System.Drawing) refuses it, so shortcuts and Explorer would show a blank
 * icon. The DIB layout has three quirks worth knowing — rows run bottom-up, the
 * channel order is BGRA, and the height in the header is doubled because a 1-bit
 * AND mask is appended after the colour data. The mask is redundant for 32-bit
 * icons since alpha already carries transparency, but it must be present.
 */
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — colour rows + mask rows
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    // Bottom-up: the last source row is written first.
    const source = (size - 1 - y) * size * 4;
    const target = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = source + x * 4;
      const t = target + x * 4;
      pixels[t] = rgba[s + 2]; // B
      pixels[t + 1] = rgba[s + 1]; // G
      pixels[t + 2] = rgba[s]; // R
      pixels[t + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: 1 bit per pixel, each row padded to a 4-byte boundary.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size); // all zero = "show the pixel"

  header.writeUInt32LE(pixels.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, pixels, mask]);
}

/** Wraps the DIB entries in an ICO container. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // The width/height fields are single bytes; 256 is encoded as 0.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

/* -------------------------------------------------------------------------- */
/* SVG — used by browsers that prefer it, and stays crisp at any size          */
/* -------------------------------------------------------------------------- */

function buildSvg() {
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const bars = E_BARS.map(
    (bar) =>
      `<rect x="${(bar.x0 * 100).toFixed(1)}" y="${(bar.y0 * 100).toFixed(1)}" ` +
      `width="${((bar.x1 - bar.x0) * 100).toFixed(1)}" height="${((bar.y1 - bar.y0) * 100).toFixed(1)}" rx="1.5"/>`
  ).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Engy Generator">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(TOP)}"/>
      <stop offset="1" stop-color="${hex(BOTTOM)}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g fill="${hex(GLYPH)}">
    ${bars}
  </g>
</svg>
`;
}

/* -------------------------------------------------------------------------- */

async function main() {
  const publicDir = path.join(ROOT_DIR, 'client', 'public');
  await fs.mkdir(publicDir, { recursive: true });

  // 16 and 32 are what browser tabs and bookmarks actually request; 48 covers
  // Windows shortcuts.
  const sizes = [16, 32, 48];
  const images = sizes.map((size) => ({ size, data: encodeDib(renderRgba(size), size) }));

  const ico = encodeIco(images);
  await fs.writeFile(path.join(publicDir, 'favicon.ico'), ico);
  log.info(`favicon.ico       ${sizes.join(', ')}px  ${(ico.length / 1024).toFixed(1)} KB`);

  await fs.writeFile(path.join(publicDir, 'favicon.svg'), buildSvg(), 'utf8');
  log.info('favicon.svg       vector');

  const touch = encodePng(renderRgba(180), 180);
  await fs.writeFile(path.join(publicDir, 'apple-touch-icon.png'), touch);
  log.info(`apple-touch-icon.png 180px  ${(touch.length / 1024).toFixed(1)} KB`);

  log.info(`Written to ${publicDir}`);
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
