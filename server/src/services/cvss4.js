/**
 * CVSS v4.0.
 *
 * Version 4 does not compute a score from a formula the way 3.1 does. Every
 * vector is reduced to a "macrovector" — six equivalence classes that capture
 * exploitability, impact, threat and environment — which has a score assigned by
 * the specification. The vector's own score is that number, pulled down in
 * proportion to how far the vector sits from the worst case within its own
 * macrovector. The tables in `cvss4-data.js` are what make that possible, and the
 * algorithm below follows §8.2 of the specification.
 *
 * Practical consequences worth knowing:
 *   - There is one score, not three formulas. Base, threat and environmental
 *     scores are the same function applied to progressively more of the vector,
 *     which is why `scoreOf` takes a set of metrics rather than a mode.
 *   - Unset threat and environmental metrics default to the *worst* case (E:A,
 *     CR/IR/AR:H), so an incomplete vector scores high rather than low.
 *
 * Specification: https://www.first.org/cvss/v4.0/specification-document
 */

import { LOOKUP, MAX_COMPOSED, MAX_SEVERITY, METRIC_LEVELS } from './cvss4-data.js';

export const CVSS4_PREFIX = 'CVSS:4.0';

/** Every metric, in the order the specification writes them. */
export const CVSS4_METRICS = {
  base: {
    AV: ['N', 'A', 'L', 'P'],
    AC: ['L', 'H'],
    AT: ['N', 'P'],
    PR: ['N', 'L', 'H'],
    UI: ['N', 'P', 'A'],
    VC: ['H', 'L', 'N'],
    VI: ['H', 'L', 'N'],
    VA: ['H', 'L', 'N'],
    SC: ['H', 'L', 'N'],
    SI: ['H', 'L', 'N'],
    SA: ['H', 'L', 'N'],
  },
  threat: {
    E: ['X', 'A', 'P', 'U'],
  },
  environmental: {
    CR: ['X', 'H', 'M', 'L'],
    IR: ['X', 'H', 'M', 'L'],
    AR: ['X', 'H', 'M', 'L'],
    MAV: ['X', 'N', 'A', 'L', 'P'],
    MAC: ['X', 'L', 'H'],
    MAT: ['X', 'N', 'P'],
    MPR: ['X', 'N', 'L', 'H'],
    MUI: ['X', 'N', 'P', 'A'],
    MVC: ['X', 'H', 'L', 'N'],
    MVI: ['X', 'H', 'L', 'N'],
    MVA: ['X', 'H', 'L', 'N'],
    MSC: ['X', 'H', 'L', 'N'],
    MSI: ['X', 'S', 'H', 'L', 'N'],
    MSA: ['X', 'S', 'H', 'L', 'N'],
  },
  /** Recorded and reported, but deliberately never scored by the specification. */
  supplemental: {
    S: ['X', 'N', 'P'],
    AU: ['X', 'N', 'Y'],
    R: ['X', 'A', 'U', 'I'],
    V: ['X', 'D', 'C'],
    RE: ['X', 'L', 'M', 'H'],
    U: ['X', 'Clear', 'Green', 'Amber', 'Red'],
  },
};

export const BASE_KEYS = Object.keys(CVSS4_METRICS.base);
const THREAT_KEYS = Object.keys(CVSS4_METRICS.threat);
const ENVIRONMENTAL_KEYS = Object.keys(CVSS4_METRICS.environmental);
const SUPPLEMENTAL_KEYS = Object.keys(CVSS4_METRICS.supplemental);

const ALL_KEYS = [...BASE_KEYS, ...THREAT_KEYS, ...ENVIRONMENTAL_KEYS, ...SUPPLEMENTAL_KEYS];
const ALL_VALUES = {
  ...CVSS4_METRICS.base,
  ...CVSS4_METRICS.threat,
  ...CVSS4_METRICS.environmental,
  ...CVSS4_METRICS.supplemental,
};

export const CVSS4_DEFAULT_VECTOR = `${CVSS4_PREFIX}/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N`;

/** Human labels, for the editor and the generated report. */
export const CVSS4_VALUE_LABELS = {
  AV: { N: 'Network', A: 'Adjacent', L: 'Local', P: 'Physical' },
  AC: { L: 'Low', H: 'High' },
  AT: { N: 'None', P: 'Present' },
  PR: { N: 'None', L: 'Low', H: 'High' },
  UI: { N: 'None', P: 'Passive', A: 'Active' },
  VC: { H: 'High', L: 'Low', N: 'None' },
  VI: { H: 'High', L: 'Low', N: 'None' },
  VA: { H: 'High', L: 'Low', N: 'None' },
  SC: { H: 'High', L: 'Low', N: 'None' },
  SI: { H: 'High', L: 'Low', N: 'None', S: 'Safety' },
  SA: { H: 'High', L: 'Low', N: 'None', S: 'Safety' },
  E: { X: 'Not defined', A: 'Attacked', P: 'Proof-of-concept', U: 'Unreported' },
  CR: { X: 'Not defined', H: 'High', M: 'Medium', L: 'Low' },
  IR: { X: 'Not defined', H: 'High', M: 'Medium', L: 'Low' },
  AR: { X: 'Not defined', H: 'High', M: 'Medium', L: 'Low' },
  S: { X: 'Not defined', N: 'Negligible', P: 'Present' },
  AU: { X: 'Not defined', N: 'No', Y: 'Yes' },
  R: { X: 'Not defined', A: 'Automatic', U: 'User', I: 'Irrecoverable' },
  V: { X: 'Not defined', D: 'Diffuse', C: 'Concentrated' },
  RE: { X: 'Not defined', L: 'Low', M: 'Moderate', H: 'High' },
  U: { X: 'Not defined', Clear: 'Clear', Green: 'Green', Amber: 'Amber', Red: 'Red' },
};

export const CVSS4_METRIC_LABELS = {
  AV: 'Attack Vector',
  AC: 'Attack Complexity',
  AT: 'Attack Requirements',
  PR: 'Privileges Required',
  UI: 'User Interaction',
  VC: 'Confidentiality (vulnerable system)',
  VI: 'Integrity (vulnerable system)',
  VA: 'Availability (vulnerable system)',
  SC: 'Confidentiality (subsequent system)',
  SI: 'Integrity (subsequent system)',
  SA: 'Availability (subsequent system)',
  E: 'Exploit Maturity',
  CR: 'Confidentiality Requirement',
  IR: 'Integrity Requirement',
  AR: 'Availability Requirement',
  S: 'Safety',
  AU: 'Automatable',
  R: 'Recovery',
  V: 'Value Density',
  RE: 'Vulnerability Response Effort',
  U: 'Provider Urgency',
};

/* -------------------------------------------------------------------------- */
/* Vector strings                                                             */
/* -------------------------------------------------------------------------- */

export const isCvss4 = (vector) =>
  typeof vector === 'string' && vector.trim().toUpperCase().startsWith(CVSS4_PREFIX);

/** Parses a vector string, keeping only metrics with values the spec allows. */
export function parseVector4(vector) {
  const metrics = {};
  if (typeof vector !== 'string') return metrics;

  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (!key || value === undefined) continue;
    if (key.toUpperCase() === 'CVSS') continue;
    const allowed = ALL_VALUES[key];
    if (allowed?.includes(value)) metrics[key] = value;
  }
  return metrics;
}

/** Serialises metrics back to a vector string, in specification order. */
export function buildVector4(metrics) {
  const parts = [CVSS4_PREFIX];
  for (const key of ALL_KEYS) {
    const value = metrics[key];
    // 'X' means "not defined", which is the same as leaving it out.
    if (value && value !== 'X') parts.push(`${key}:${value}`);
  }
  return parts.join('/');
}

export const isVectorComplete4 = (metrics) => BASE_KEYS.every((key) => Boolean(metrics[key]));

/** Which parts of the vector were actually filled in: CVSS-B, -BT, -BE, -BTE. */
export function nomenclatureOf(metrics) {
  const defined = (keys) => keys.some((key) => metrics[key] && metrics[key] !== 'X');
  let name = 'CVSS-B';
  if (defined(THREAT_KEYS)) name += 'T';
  if (defined(ENVIRONMENTAL_KEYS)) name += 'E';
  return name;
}

/** Severity bands are the same as 3.1's. */
export function severityOf4(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'None';
  if (score === 0) return 'None';
  if (score < 4) return 'Low';
  if (score < 7) return 'Medium';
  if (score < 9) return 'High';
  return 'Critical';
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Round half up to one decimal.
 *
 * The epsilon matters: `8.6 - 7.15` is 1.4499999999999993 in binary floating
 * point, which naive rounding turns into 1.4 rather than the correct 1.5.
 */
function round1(value) {
  return Math.round((value + 1e-6) * 10) / 10;
}

/**
 * The value a metric actually scores as.
 *
 * Three rules, in order: an unset threat or environmental requirement defaults to
 * the worst case; a modified metric (M-prefixed) overrides its base counterpart;
 * otherwise the metric speaks for itself.
 */
const WORST_CASE = { E: 'A', CR: 'H', IR: 'H', AR: 'H' };

function effective(metrics, key) {
  if (metrics[key] === 'X' && WORST_CASE[key]) return WORST_CASE[key];
  if (metrics[key] === undefined && WORST_CASE[key]) return WORST_CASE[key];

  const modified = metrics[`M${key}`];
  if (modified && modified !== 'X') return modified;
  return metrics[key];
}

/** The six equivalence classes, as a six-digit string. */
export function macroVectorOf(metrics) {
  const value = (key) => effective(metrics, key);

  const av = value('AV');
  const pr = value('PR');
  const ui = value('UI');
  const anyNone = av === 'N' || pr === 'N' || ui === 'N';
  const eq1 = av === 'N' && pr === 'N' && ui === 'N' ? '0' : anyNone && av !== 'P' ? '1' : '2';

  const eq2 = value('AC') === 'L' && value('AT') === 'N' ? '0' : '1';

  const vc = value('VC');
  const vi = value('VI');
  const va = value('VA');
  const eq3 = vc === 'H' && vi === 'H' ? '0' : vc === 'H' || vi === 'H' || va === 'H' ? '1' : '2';

  const msi = value('MSI');
  const msa = value('MSA');
  const safety = msi === 'S' || msa === 'S';
  const subsequentHigh = value('SC') === 'H' || value('SI') === 'H' || value('SA') === 'H';
  const eq4 = safety ? '0' : subsequentHigh ? '1' : '2';

  const e = value('E');
  const eq5 = e === 'A' ? '0' : e === 'P' ? '1' : '2';

  const eq6 =
    (value('CR') === 'H' && vc === 'H') ||
    (value('IR') === 'H' && vi === 'H') ||
    (value('AR') === 'H' && va === 'H')
      ? '0'
      : '1';

  return eq1 + eq2 + eq3 + eq4 + eq5 + eq6;
}

/** Reads one metric out of a max-vector fragment such as `AV:N/PR:N/UI:N/`. */
function fromMaxVector(maxVector, metric) {
  const at = maxVector.indexOf(`${metric}:`);
  if (at === -1) return undefined;
  const rest = maxVector.slice(at + metric.length + 1);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : rest;
}

/** How far each metric is from the given worst case, in 0.1 steps. */
function severityDistances(metrics, maxVector) {
  const distances = {};
  for (const metric of Object.keys(METRIC_LEVELS)) {
    const mine = METRIC_LEVELS[metric][effective(metrics, metric)];
    const worst = METRIC_LEVELS[metric][fromMaxVector(maxVector, metric)];
    distances[metric] = mine - worst;
  }
  return distances;
}

const NO_IMPACT = ['VC', 'VI', 'VA', 'SC', 'SI', 'SA'];

/**
 * Scores a metric set.
 *
 * @param {object} metrics parsed metrics; missing threat/environmental entries
 *   take their worst-case defaults, per the specification
 * @returns {number|null} null when the base metrics are incomplete
 */
export function scoreOf(metrics) {
  if (!isVectorComplete4(metrics)) return null;

  // Nothing is affected, so there is nothing to score.
  if (NO_IMPACT.every((metric) => effective(metrics, metric) === 'N')) return 0;

  const macroVector = macroVectorOf(metrics);
  const value = LOOKUP[macroVector];
  if (value === undefined) return null;

  const [eq1, eq2, eq3, eq4, eq5, eq6] = macroVector.split('').map(Number);

  /* The maximal scoring difference per equivalence class: how much score lies
     between this macrovector and the next less severe one. Absent neighbours give
     NaN, which drops that class out of the mean below. */
  const lower = (digits) => LOOKUP[digits.join('')];
  const msd = {
    eq1: value - lower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]),
    eq2: value - lower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]),
    eq4: value - lower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]),
    eq5: value - lower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]),
    // eq3 and eq6 move together; from 00 either step is valid, so take the
    // gentler one (the higher-scoring neighbour).
    eq3eq6:
      eq3 === 0 && eq6 === 0
        ? value -
          Math.max(lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]), lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]))
        : eq3 === 1 && eq6 === 0
          ? value - lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1])
          : eq3 === 2
            ? value - lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1])
            : value - lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]),
  };

  /* The worst case within this macrovector is a combination of per-class maxima.
     Several combinations exist; the right one is the first that is at least as
     severe as the vector being scored in every metric. */
  const maxes = [
    MAX_COMPOSED.eq1[eq1],
    MAX_COMPOSED.eq2[eq2],
    MAX_COMPOSED.eq3[eq3][eq6],
    MAX_COMPOSED.eq4[eq4],
    MAX_COMPOSED.eq5[eq5],
  ];

  let distances = null;
  for (const a of maxes[0]) {
    for (const b of maxes[1]) {
      for (const c of maxes[2]) {
        for (const d of maxes[3]) {
          for (const e of maxes[4]) {
            const candidate = severityDistances(metrics, a + b + c + d + e);
            if (Object.values(candidate).every((distance) => distance >= 0)) {
              distances = candidate;
            }
            if (distances) break;
          }
          if (distances) break;
        }
        if (distances) break;
      }
      if (distances) break;
    }
    if (distances) break;
  }
  if (!distances) return round1(value);

  const STEP = 0.1;
  const current = {
    eq1: distances.AV + distances.PR + distances.UI,
    eq2: distances.AC + distances.AT,
    eq3eq6: distances.VC + distances.VI + distances.VA + distances.CR + distances.IR + distances.AR,
    eq4: distances.SC + distances.SI + distances.SA,
    eq5: 0,
  };
  const depth = {
    eq1: MAX_SEVERITY.eq1[eq1] * STEP,
    eq2: MAX_SEVERITY.eq2[eq2] * STEP,
    eq3eq6: MAX_SEVERITY.eq3eq6[eq3][eq6] * STEP,
    eq4: MAX_SEVERITY.eq4[eq4] * STEP,
    eq5: 1,
  };

  /* Each existing neighbour contributes its scoring difference scaled by how far
     into its class the vector sits; the score is the macrovector's score less the
     mean of those. EQ5 contributes nothing but still counts toward the mean. */
  let existing = 0;
  let total = 0;
  for (const key of ['eq1', 'eq2', 'eq3eq6', 'eq4', 'eq5']) {
    if (Number.isNaN(msd[key])) continue;
    existing += 1;
    total += key === 'eq5' ? 0 : msd[key] * (current[key] / depth[key]);
  }

  const mean = existing === 0 ? 0 : total / existing;
  return round1(Math.max(0, Math.min(10, value - mean)));
}

/**
 * Full result for a v4.0 vector, shaped like the 3.1 result so every caller —
 * severity counts, sorting, search, preflight, report data — works unchanged.
 */
export function calculateCvss4(vector) {
  const metrics = parseVector4(vector);
  const complete = isVectorComplete4(metrics);

  if (!complete) {
    return {
      version: '4.0',
      vector: typeof vector === 'string' ? vector : '',
      metrics,
      complete: false,
      nomenclature: nomenclatureOf(metrics),
      macroVector: null,
      baseScore: null,
      baseSeverity: 'None',
      temporalScore: null,
      temporalSeverity: 'None',
      threatScore: null,
      threatSeverity: 'None',
      environmentalScore: null,
      environmentalSeverity: 'None',
      score: null,
      severity: 'None',
      impact: null,
      exploitability: null,
    };
  }

  // One function, three progressively larger metric sets. Base-only means the
  // threat and environmental metrics are dropped so their worst-case defaults
  // apply, which is exactly what CVSS-B means.
  const baseOnly = {};
  for (const key of BASE_KEYS) baseOnly[key] = metrics[key];
  const withThreat = { ...baseOnly };
  for (const key of THREAT_KEYS) if (metrics[key]) withThreat[key] = metrics[key];

  const baseScore = scoreOf(baseOnly);
  const threatScore = scoreOf(withThreat);
  const environmentalScore = scoreOf(metrics);

  return {
    version: '4.0',
    vector: buildVector4(metrics),
    metrics,
    complete: true,
    nomenclature: nomenclatureOf(metrics),
    macroVector: macroVectorOf(metrics),
    baseScore,
    baseSeverity: severityOf4(baseScore),
    // `temporal*` is v3.1's name for the same idea; kept so shared code and
    // existing report templates do not have to care which version they are given.
    temporalScore: threatScore,
    temporalSeverity: severityOf4(threatScore),
    threatScore,
    threatSeverity: severityOf4(threatScore),
    environmentalScore,
    environmentalSeverity: severityOf4(environmentalScore),
    /** The headline number: everything the vector actually says. */
    score: environmentalScore,
    severity: severityOf4(environmentalScore),
    // v4.0 has no published impact/exploitability sub-scores.
    impact: null,
    exploitability: null,
  };
}

export default calculateCvss4;
