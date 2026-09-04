/**
 * Checks the rules that decide what happens to a screenshot on its way in.
 *
 *   npm run test:images
 *
 * The canvas work needs a browser and is not tested here. Everything that *decides* — whether an
 * image is touched at all, what size it becomes, and which of the two encodings is kept — was
 * deliberately written as arithmetic over plain numbers so that it can be, because those are the
 * rules with consequences: too eager and somebody's evidence is re-encoded for nothing, too shy
 * and the report will not send.
 */
import { createServer } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});

const { planResize, chooseEncoding, IMAGE_LIMITS } = await vite.ssrLoadModule('/src/lib/images.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const MB = 1024 * 1024;
const png = (width, height, bytes) => ({ type: 'image/png', width, height, bytes });

console.log('What gets touched:');

{
  /* The case this whole feature exists for. */
  const plan = planResize(png(3840, 2160, 6 * MB));
  check(
    'a 4K screenshot is scaled to the printable width',
    plan.resize && plan.width === 1600 && plan.height === 900,
    JSON.stringify(plan)
  );
}

check(
  'a screenshot already within the column is left alone',
  planResize(png(1440, 900, 180 * 1024)).resize === false
);

check(
  'and so is a small one, however it was made',
  planResize(png(600, 400, 40 * 1024)).resize === false
);

check(
  'a small image that is somehow enormous is re-encoded anyway',
  planResize(png(800, 600, 5 * MB)).resize === true,
  'a heavy image was skipped for being small'
);

{
  /* Never upscale: a 900px capture must not be blown up to 1600 and lose its sharpness. */
  const plan = planResize(png(900, 700, 3 * MB));
  check(
    'a heavy but small image keeps its dimensions',
    plan.resize && plan.width === 900 && plan.height === 700 && plan.scale === 1,
    JSON.stringify(plan)
  );
}

{
  /* Aspect ratio survives, and the *longest* edge is the one that is bounded. */
  const plan = planResize(png(1200, 4000, 3 * MB));
  check(
    'a tall screenshot is bounded by its height, keeping its proportions',
    plan.height === 1600 && plan.width === 480,
    JSON.stringify(plan)
  );
}

check('an animated GIF is never re-encoded', planResize({ type: 'image/gif', width: 4000, height: 4000, bytes: 9 * MB }).resize === false);
check('nor is an SVG, which has no pixels to lose', planResize({ type: 'image/svg+xml', width: 4000, height: 4000, bytes: 9 * MB }).resize === false);
check('nor is a PDF that arrived by mistake', planResize({ type: 'application/pdf', width: 0, height: 0, bytes: 9 * MB }).resize === false);
check(
  'an image whose size could not be read is left alone',
  planResize(png(0, 0, 9 * MB)).resize === false,
  'guessed at an unknown size'
);

console.log('\nWhich encoding is kept:');

check(
  'a screenshot stays PNG even when JPEG is somewhat smaller',
  chooseEncoding({ pngBytes: 300 * 1024, jpegBytes: 220 * 1024, hasAlpha: false }) === 'png',
  'text would have been sent to JPEG and blurred'
);
check(
  'a photograph, where PNG is far bigger, goes to JPEG',
  chooseEncoding({ pngBytes: 4 * MB, jpegBytes: 380 * 1024, hasAlpha: false }) === 'jpeg'
);
check(
  'anything with transparency stays PNG whatever the sizes',
  chooseEncoding({ pngBytes: 9 * MB, jpegBytes: 100 * 1024, hasAlpha: true }) === 'png',
  'transparency would have been flattened onto black'
);
check(
  'and a failed JPEG encode falls back to PNG',
  chooseEncoding({ pngBytes: 500 * 1024, jpegBytes: 0, hasAlpha: false }) === 'png'
);

check(
  'the tolerance is the thing that decides it',
  chooseEncoding({ pngBytes: 160, jpegBytes: 100, hasAlpha: false }) === 'png' &&
    chooseEncoding({ pngBytes: 161, jpegBytes: 100, hasAlpha: false }) === 'jpeg',
  `tolerance is ${IMAGE_LIMITS.pngTolerance}`
);

await vite.close();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
