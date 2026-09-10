/**
 * Checks the generated report charts, without a database.
 *
 *   npm run test:charts
 *
 * Three things have to hold, and only the first is obvious. The PNG must be a PNG — decodable by
 * the same sniffer the document writer uses to size it. The geometry must be *right*: a chart in a
 * penetration test report is a claim about proportion, so the test decodes the file back to pixels
 * and reads the colour at known angles. And the block must survive the trip into
 * WordprocessingML, because a picture that is not a `w:drawing` is a picture Word will not show.
 *
 * Pass `--write <dir>` to drop the PNGs somewhere and look at them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { chartBlockHtml, donutPng, legendHtml, segmentedBarPng } from '../services/chart.service.js';
import htmlToOoxml from '../services/ooxml/html2ooxml.js';
import { readImageSize } from '../services/ooxml/image-size.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Decodes what `encodePng` wrote: 8-bit RGBA, no interlacing, every scanline filter 0.
 *
 * A general PNG decoder would be a liability in a test — this one only has to read the files this
 * app produces, and refusing anything else is the point. If the encoder ever starts choosing a
 * real filter, this throws rather than quietly returning wrong pixels.
 */
function decodePng(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const idat = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`scanline ${y} uses filter ${filter}, which this cannot read`);
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return {
    width,
    height,
    at(x, y) {
      const o = (Math.round(y) * width + Math.round(x)) * 4;
      return {
        hex: pixels.subarray(o, o + 3).toString('hex').toUpperCase(),
        alpha: pixels[o + 3],
      };
    },
  };
}

/** The five severities as `buildReportData` hands them over, with the default palette. */
const SLICES = [
  { severity: 'Critical', label: 'Critical', color: 'D02D2D', count: 2 },
  { severity: 'High', label: 'High', color: 'FE6C00', count: 4 },
  { severity: 'Medium', label: 'Medium', color: 'F9A009', count: 6 },
  { severity: 'Low', label: 'Low', color: '008000', count: 3 },
  { severity: 'None', label: 'Informational', color: '4A86E8', count: 1 },
];

/* ------------------------------------------------------------------ the PNG -- */

const donut = donutPng(SLICES);
check('the donut renders', Boolean(donut?.buffer?.length));

const donutSize = readImageSize(donut.buffer);
check(
  'and decodes as a PNG at twice its printed size',
  donutSize?.ext === 'png' && donutSize.width === donut.width * 2,
  JSON.stringify(donutSize)
);

const bar = segmentedBarPng(SLICES);
const barSize = readImageSize(bar.buffer);
check(
  'the segmented bar renders and decodes',
  barSize?.ext === 'png' && barSize.width === bar.width * 2,
  JSON.stringify(barSize)
);

/* --------------------------------------------------------------- the shapes -- */

const pixels = decodePng(donut.buffer);

/** A point in the middle of the ring, `degrees` clockwise from twelve o'clock. */
function onRing(degrees) {
  const centre = pixels.width / 2;
  const outer = pixels.width * 0.48;
  const radius = (outer + outer * (1 - 0.34)) / 2;
  const angle = (degrees * Math.PI) / 180 - Math.PI / 2;
  return { x: centre + Math.cos(angle) * radius, y: centre + Math.sin(angle) * radius };
}

/*
 * 2 + 4 + 6 + 3 + 1 = 16 findings, so Critical owns the first 45°, High the 90° after it, then
 * Medium 135°, Low 67.5° and Informational the last 22.5°. Each sample sits mid-arc, clear of the
 * gaps at either end.
 */
for (const [degrees, colour, name] of [
  [22, 'D02D2D', 'Critical'],
  [90, 'FE6C00', 'High'],
  [200, 'F9A009', 'Medium'],
  [305, '008000', 'Low'],
  [348, '4A86E8', 'Informational'],
]) {
  const { x, y } = onRing(degrees);
  const found = pixels.at(x, y);
  check(
    `${name} is drawn where its share puts it (${degrees}°)`,
    found.hex === colour && found.alpha === 255,
    `got #${found.hex} at alpha ${found.alpha}`
  );
}

check(
  'the hole in the middle is transparent',
  pixels.at(pixels.width / 2, pixels.height / 2).alpha === 0,
  `alpha ${pixels.at(pixels.width / 2, pixels.height / 2).alpha}`
);

check(
  'and so is the corner, so the ring sits on any page colour',
  pixels.at(2, 2).alpha === 0
);

/* The arcs are separated, or a reader cannot tell two adjacent severities apart. */
const seam = pixels.at(onRing(45).x, onRing(45).y);
check('there is a gap between arcs', seam.alpha < 255, `alpha ${seam.alpha} at the 45° seam`);

/* An engagement with nothing in it must not print an empty ring. */
check(
  'no findings draws nothing at all',
  donutPng(SLICES.map((s) => ({ ...s, count: 0 }))) === null &&
    segmentedBarPng([]) === null &&
    chartBlockHtml([]) === '',
  'an empty chart was drawn'
);

/* One severity and nothing else is a complete ring, not a ring with a notch cut out of it. */
const single = donutPng([{ label: 'Medium', color: 'F9A009', count: 3 }]);
const singlePixels = decodePng(single.buffer);
const notch = singlePixels.at(
  singlePixels.width / 2,
  singlePixels.height / 2 - singlePixels.width * 0.4
);
check(
  'a lone severity closes the ring at twelve',
  notch.hex === 'F9A009' && notch.alpha === 255,
  `got #${notch.hex} at alpha ${notch.alpha}`
);

/* A severity found once, among many, must still be visible rather than trimmed away by the gap. */
const lopsided = decodePng(donutPng([
  { label: 'Critical', color: 'D02D2D', count: 1 },
  { label: 'Low', color: '008000', count: 120 },
]).buffer);
let sliver = 0;
for (let degrees = 0; degrees < 3; degrees += 0.1) {
  const { x, y } = onRing(degrees);
  if (lopsided.at(x, y).hex === 'D02D2D') sliver += 1;
}
check('one finding in a hundred is still drawn', sliver > 0, 'the sliver disappeared');

/* --------------------------------------------------------------- the markup -- */

const html = chartBlockHtml(SLICES, { kind: 'donut' });
check(
  'the block is an image and a legend',
  /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="300" height="300"/.test(html) &&
    html.includes('●'),
  html.slice(0, 120)
);

check(
  'every severity is named in the legend, zero counts included',
  ['Critical', 'High', 'Medium', 'Low', 'Informational'].every((label) =>
    legendHtml(SLICES.map((s) => ({ ...s, count: 0 }))).includes(label)
  )
);

/** Enough of a `DocxAssembler` for the writer to allocate an image relationship against. */
const parts = {
  images: [],
  addImage(buffer, ext) {
    this.images.push({ buffer, ext });
    return { rId: `rId${99 + this.images.length}`, docPrId: this.images.length, name: `chart.${ext}` };
  },
  addHyperlink: () => 'rId1',
};

const ooxml = htmlToOoxml(html, { parts, numbering: null, usableTwips: 9070 });
check(
  'it converts to a real Word drawing',
  ooxml.includes('<w:drawing>') && ooxml.includes('<a:blip r:embed="rId100"'),
  ooxml.slice(0, 200)
);
check(
  'the picture goes into the package once',
  parts.images.length === 1 && parts.images[0].ext === 'png',
  `${parts.images.length} images`
);
check(
  'the legend keeps its colours as text runs',
  ooxml.includes('<w:color w:val="D02D2D"/>'),
  'no coloured run found'
);
check(
  'and nothing is left as a literal data URI in the document',
  !ooxml.includes('data:image'),
  'a data URI reached the XML'
);

/* ----------------------------------------------------------------- writing --- */

const writeAt = process.argv.indexOf('--write');
if (writeAt !== -1 && process.argv[writeAt + 1]) {
  const dir = path.resolve(process.argv[writeAt + 1]);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'severity-donut.png'), donut.buffer);
  await fs.writeFile(path.join(dir, 'severity-bar.png'), bar.buffer);
  await fs.writeFile(path.join(dir, 'severity-donut-single.png'), single.buffer);
  console.log(`\n  wrote three PNGs to ${dir}`);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
