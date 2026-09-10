/**
 * Checks the CVSS v4.0 implementation against the official calculator.
 *
 *   npm run test:cvss4
 *
 * v4.0 scores by looking a "macrovector" up in a table and interpolating, not by
 * evaluating a formula, so a subtle error produces a plausible-but-wrong number
 * rather than an obvious one. The fixture holds 900-odd vectors — randomised
 * across every metric, plus the specification's published examples — each with the
 * score, severity, macrovector and nomenclature produced by FIRST and Red Hat's
 * reference implementation. The whole space was checked exhaustively when this was
 * written (all 104,976 base vectors and 40,000 full ones, zero mismatches); the
 * fixture is the regression net.
 *
 * It also verifies the two copies of the scoring tables — one per workspace,
 * because the editor scores as you type — are byte-identical.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  buildVector4,
  calculateCvss4,
  isCvss4,
  macroVectorOf,
  nomenclatureOf,
  parseVector4,
  scoreOf,
  severityOf4,
} from '../services/cvss4.js';
import { calculateCvss } from '../services/cvss.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '..', 'fixtures', 'cvss4-vectors.json'), 'utf8')
);

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) passed += 1;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------- the fixture ------- */

let scoreMismatches = 0;
let severityMismatches = 0;
let macroMismatches = 0;
let nomenclatureMismatches = 0;
let baseMismatches = 0;

for (const row of fixture) {
  const result = calculateCvss4(row.v);

  if (result.score !== row.score) {
    scoreMismatches += 1;
    if (scoreMismatches <= 3) failures.push(`score ${row.v}: got ${result.score}, want ${row.score}`);
  }
  if (result.severity !== row.severity) {
    severityMismatches += 1;
    if (severityMismatches <= 3) {
      failures.push(`severity ${row.v}: got ${result.severity}, want ${row.severity}`);
    }
  }
  if (result.macroVector !== row.mv) {
    macroMismatches += 1;
    if (macroMismatches <= 3) failures.push(`macrovector ${row.v}: got ${result.macroVector}, want ${row.mv}`);
  }
  if (result.nomenclature !== row.nom) {
    nomenclatureMismatches += 1;
    if (nomenclatureMismatches <= 3) {
      failures.push(`nomenclature ${row.v}: got ${result.nomenclature}, want ${row.nom}`);
    }
  }
  if (result.baseScore !== row.base) {
    baseMismatches += 1;
    if (baseMismatches <= 3) failures.push(`base score ${row.v}: got ${result.baseScore}, want ${row.base}`);
  }
}

check(`${fixture.length} fixture scores`, scoreMismatches === 0, `${scoreMismatches} wrong`);
check('fixture severities', severityMismatches === 0, `${severityMismatches} wrong`);
check('fixture macrovectors', macroMismatches === 0, `${macroMismatches} wrong`);
check('fixture nomenclature', nomenclatureMismatches === 0, `${nomenclatureMismatches} wrong`);
check('fixture base scores', baseMismatches === 0, `${baseMismatches} wrong`);

/* -------------------------------------------- published anchor examples ---- */

const WORST = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H';
check('the worst possible vector scores 10', calculateCvss4(WORST).score === 10);
check(
  'no impact scores 0',
  calculateCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N').score === 0
);
check(
  'the specification headline example is 9.3',
  calculateCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N').score === 9.3
);

/* --------------------------------------------------- structural behaviour -- */

check('4.0 vectors are recognised', isCvss4('CVSS:4.0/AV:N/AC:L') && !isCvss4('CVSS:3.1/AV:N'));

const full =
  'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U/CR:L/IR:L/AR:L/S:P/AU:Y';
const parsed = parseVector4(full);
check('parse then build round-trips', buildVector4(parsed) === full, buildVector4(parsed));
check('unknown metrics are dropped', parseVector4('CVSS:4.0/AV:N/ZZ:Q').ZZ === undefined);
check('invalid values are dropped', parseVector4('CVSS:4.0/AV:Q').AV === undefined);
check('X is treated as absent when rebuilding', !buildVector4({ AV: 'N', E: 'X' }).includes('E:'));

// Threat and environmental metrics default to the worst case, so leaving them out
// must never make a finding look less severe than filling them in pessimistically.
const baseOnly = calculateCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N');
const attacked = calculateCvss4(
  'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:A/CR:H/IR:H/AR:H'
);
check('unset threat/environmental means worst case', baseOnly.score === attacked.score);

const unreported = calculateCvss4(
  'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U'
);
check('an unreported exploit scores lower than an attacked one', unreported.score < attacked.score);
check(
  'the base score ignores the threat metric',
  unreported.baseScore === baseOnly.baseScore && unreported.score < unreported.baseScore
);
check('nomenclature reflects what was supplied', nomenclatureOf(parseVector4(full)) === 'CVSS-BTE');
check('base-only vectors are CVSS-B', baseOnly.nomenclature === 'CVSS-B');

check('an incomplete vector does not score', calculateCvss4('CVSS:4.0/AV:N/AC:L').score === null);
check('an incomplete vector is not complete', calculateCvss4('CVSS:4.0/AV:N').complete === false);
check('scoreOf refuses incomplete metrics', scoreOf({ AV: 'N' }) === null);

check(
  'severity bands',
  severityOf4(0) === 'None' &&
    severityOf4(3.9) === 'Low' &&
    severityOf4(4) === 'Medium' &&
    severityOf4(6.9) === 'Medium' &&
    severityOf4(7) === 'High' &&
    severityOf4(8.9) === 'High' &&
    severityOf4(9) === 'Critical' &&
    severityOf4(10) === 'Critical'
);

// EQ4 is the fourth digit, and 0 there means "safety impact".
check(
  'MSI:S reaches the safety equivalence class',
  macroVectorOf(
    parseVector4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H/MSI:S')
  )[3] === '0'
);
check(
  'a modified metric overrides its base counterpart',
  calculateCvss4('CVSS:4.0/AV:P/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/MAV:N').score ===
    calculateCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N').score
);

/* ------------------------------------------- dispatch from the shared API -- */

const viaShared = calculateCvss(
  'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
);
check('calculateCvss dispatches 4.0 vectors', viaShared.version === '4.0' && viaShared.score === 9.3);

const via31 = calculateCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
check('3.1 still works through the same entry point', via31.version === '3.1' && via31.baseScore === 9.8);
check(
  'both versions expose the same fields',
  Object.keys(via31).sort().join() === Object.keys(viaShared).sort().join(),
  `3.1: ${Object.keys(via31).sort().join()} | 4.0: ${Object.keys(viaShared).sort().join()}`
);

/* ------------------------------------------------ the two table copies ----- */

const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const serverTables = path.join(here, '..', 'services', 'cvss4-data.js');
const clientTables = path.join(here, '..', '..', '..', 'client', 'src', 'lib', 'cvss4-data.js');
check(
  'the server and client scoring tables are identical',
  hashOf(serverTables) === hashOf(clientTables),
  'regenerate them so both halves score the same'
);

// The editor scores as you type from its own copy of the engine. If it disagreed
// with the server the number would change on save, which is worse than either
// being wrong on its own.
// pathToFileURL, because a Windows absolute path is not a valid import specifier.
const clientEngine = await import(
  pathToFileURL(path.join(here, '..', '..', '..', 'client', 'src', 'lib', 'cvss4.js')).href
);
let clientMismatches = 0;
for (const row of fixture) {
  const mine = clientEngine.calculateCvss4(row.v);
  if (
    mine.score !== row.score ||
    mine.baseScore !== row.base ||
    mine.macroVector !== row.mv ||
    mine.nomenclature !== row.nom
  ) {
    clientMismatches += 1;
    if (clientMismatches <= 3) failures.push(`client engine ${row.v}: ${mine.score} vs ${row.score}`);
  }
}
check(
  'the browser engine agrees with the reference on every vector',
  clientMismatches === 0,
  `${clientMismatches} disagreed`
);

/* --------------------------------------------------------------- report ---- */

console.log('');
for (const failure of failures) console.log(`  FAIL  ${failure}`);
console.log(
  failures.length === 0
    ? `RESULT: ${passed} checks passed (${fixture.length} reference vectors)`
    : `RESULT: ${passed} passed, ${failures.length} failed`
);
process.exit(failures.length === 0 ? 0 : 1);
