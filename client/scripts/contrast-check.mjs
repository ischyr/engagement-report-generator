/**
 * Checks every text colour against every surface it can sit on.
 *
 * Reads the tokens out of `index.css` rather than taking a copy, so it measures what
 * actually ships. Text at 10–11px is the common case in this UI, which is the
 * strictest WCAG threshold — 4.5:1 — and the reason this is worth a script instead
 * of an opinion.
 *
 *   node scripts/contrast-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'index.css'),
  'utf8'
);

/** Pulls `--color-NAME: #rrggbb;` out of the stylesheet. */
function token(name) {
  for (const line of css.split('\n')) {
    const [key, value] = line.split(':');
    if (key?.trim() === `--color-${name}`) {
      const hex = value?.trim().replace(/;.*$/, '');
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
    }
  }
  throw new Error(`token --color-${name} not found`);
}

const luminance = (hex) => {
  const channels = hex
    .replace('#', '')
    .match(/../g)
    .map((pair) => parseInt(pair, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

const SURFACES = ['canvas', 'surface', 'overlay'];
const TEXT = ['fg', 'fg-muted', 'fg-subtle'];
/** Severity and brand steps are used as marks and as text on badges. */
const ACCENTS = ['crit', 'high', 'med', 'low', 'info', 'brand-300'];

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

let failures = 0;

console.log('Text tokens (need 4.5:1 — this UI uses them at 10-11px):');
for (const name of TEXT) {
  const hex = token(name);
  const cells = SURFACES.map((surface) => {
    const ratio = contrast(hex, token(surface));
    if (ratio < AA_BODY) failures += 1;
    return `${surface} ${ratio.toFixed(2)}${ratio < AA_BODY ? ' FAIL' : ''}`;
  });
  console.log(`  ${name.padEnd(10)} ${hex}  ${cells.join('  |  ')}`);
}

console.log('\nAccents as text (badges and labels — 3:1 is the floor for a mark):');
for (const name of ACCENTS) {
  const hex = token(name);
  const cells = SURFACES.map((surface) => {
    const ratio = contrast(hex, token(surface));
    if (ratio < AA_LARGE) failures += 1;
    return `${surface} ${ratio.toFixed(2)}${ratio < AA_LARGE ? ' FAIL' : ''}`;
  });
  console.log(`  ${name.padEnd(10)} ${hex}  ${cells.join('  |  ')}`);
}

console.log(
  failures === 0
    ? '\nRESULT: every pair passes'
    : `\nRESULT: ${failures} pair(s) below threshold`
);
process.exit(failures === 0 ? 0 : 1);
