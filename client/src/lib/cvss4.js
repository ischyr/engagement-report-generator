/**
 * CVSS v4.0 for the browser, so the score moves as the tester clicks metrics.
 *
 * Mirrors `server/src/services/cvss4.js`; the server stays authoritative and
 * recomputes on every read. The scoring tables in `cvss4-data.js` are the same
 * bytes in both workspaces and `npm run test:cvss4` fails if they drift.
 *
 * Unlike 3.1 there is no formula: a vector reduces to one of 270 "macrovectors"
 * with a score assigned by the specification, then drops in proportion to how far
 * it sits from the worst case inside that macrovector.
 *
 * https://www.first.org/cvss/v4.0/specification-document
 */

import { LOOKUP, MAX_COMPOSED, MAX_SEVERITY, METRIC_LEVELS } from './cvss4-data.js';

export const CVSS4_PREFIX = 'CVSS:4.0';
export const CVSS4_DEFAULT_VECTOR = `${CVSS4_PREFIX}/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N`;

export const isCvss4 = (vector) =>
  typeof vector === 'string' && vector.trim().toUpperCase().startsWith(CVSS4_PREFIX);

/* -------------------------------------------------------------------------- */
/* Metric definitions driving the picker                                      */
/* -------------------------------------------------------------------------- */

export const BASE_METRICS_4 = [
  {
    key: 'AV',
    name: 'Attack Vector',
    help: 'How remote can the attacker be?',
    values: [
      { value: 'N', label: 'Network', help: 'Exploitable across the internet.' },
      { value: 'A', label: 'Adjacent', help: 'Requires the same logical network.' },
      { value: 'L', label: 'Local', help: 'Requires local access or a shell.' },
      { value: 'P', label: 'Physical', help: 'Requires touching the device.' },
    ],
  },
  {
    key: 'AC',
    name: 'Attack Complexity',
    help: 'Must the attacker defeat a security measure that is working as intended?',
    values: [
      { value: 'L', label: 'Low', help: 'No evasion of built-in defences needed.' },
      { value: 'H', label: 'High', help: 'ASLR, WAF or similar has to be beaten.' },
    ],
  },
  {
    key: 'AT',
    name: 'Attack Requirements',
    help: 'Do deployment conditions outside anyone’s control have to line up?',
    values: [
      { value: 'N', label: 'None', help: 'Works against any affected deployment.' },
      { value: 'P', label: 'Present', help: 'Needs a race, a specific config or a state.' },
    ],
  },
  {
    key: 'PR',
    name: 'Privileges Required',
    help: 'What access does the attacker need first?',
    values: [
      { value: 'N', label: 'None', help: 'Unauthenticated.' },
      { value: 'L', label: 'Low', help: 'An ordinary user account.' },
      { value: 'H', label: 'High', help: 'Administrative access.' },
    ],
  },
  {
    key: 'UI',
    name: 'User Interaction',
    help: 'Does a human other than the attacker have to do something?',
    values: [
      { value: 'N', label: 'None', help: 'No interaction at all.' },
      { value: 'P', label: 'Passive', help: 'Ordinary use is enough, e.g. viewing a page.' },
      { value: 'A', label: 'Active', help: 'A deliberate action, e.g. importing a file.' },
    ],
  },
  {
    key: 'VC',
    name: 'Confidentiality (vulnerable system)',
    help: 'What can be read on the system that holds the flaw?',
    values: [
      { value: 'H', label: 'High', help: 'All of it, or the most sensitive parts.' },
      { value: 'L', label: 'Low', help: 'Some of it, with limited impact.' },
      { value: 'N', label: 'None', help: 'Nothing.' },
    ],
  },
  {
    key: 'VI',
    name: 'Integrity (vulnerable system)',
    help: 'What can be changed on the system that holds the flaw?',
    values: [
      { value: 'H', label: 'High', help: 'Anything, or something critical.' },
      { value: 'L', label: 'Low', help: 'Limited or unreliable modification.' },
      { value: 'N', label: 'None', help: 'Nothing.' },
    ],
  },
  {
    key: 'VA',
    name: 'Availability (vulnerable system)',
    help: 'How much of the affected system can be denied?',
    values: [
      { value: 'H', label: 'High', help: 'Full or sustained denial.' },
      { value: 'L', label: 'Low', help: 'Reduced performance or interruptions.' },
      { value: 'N', label: 'None', help: 'No impact.' },
    ],
  },
  {
    key: 'SC',
    name: 'Confidentiality (subsequent systems)',
    help: 'What can be read on *other* systems as a result? (3.1 called this Scope.)',
    values: [
      { value: 'H', label: 'High', help: 'Serious exposure beyond the vulnerable system.' },
      { value: 'L', label: 'Low', help: 'Limited exposure beyond it.' },
      { value: 'N', label: 'None', help: 'Contained to the vulnerable system.' },
    ],
  },
  {
    key: 'SI',
    name: 'Integrity (subsequent systems)',
    help: 'What can be changed on other systems as a result?',
    values: [
      { value: 'H', label: 'High', help: 'Serious modification beyond the vulnerable system.' },
      { value: 'L', label: 'Low', help: 'Limited modification beyond it.' },
      { value: 'N', label: 'None', help: 'Contained to the vulnerable system.' },
    ],
  },
  {
    key: 'SA',
    name: 'Availability (subsequent systems)',
    help: 'What can be denied on other systems as a result?',
    values: [
      { value: 'H', label: 'High', help: 'Serious denial beyond the vulnerable system.' },
      { value: 'L', label: 'Low', help: 'Limited denial beyond it.' },
      { value: 'N', label: 'None', help: 'Contained to the vulnerable system.' },
    ],
  },
];

export const THREAT_METRICS_4 = [
  {
    key: 'E',
    name: 'Exploit Maturity',
    help: 'Leaving this unset scores as though it were being attacked.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'A', label: 'Attacked', help: 'Exploited in the wild, or trivially exploitable.' },
      { value: 'P', label: 'Proof-of-concept', help: 'A PoC exists but is not weaponised.' },
      { value: 'U', label: 'Unreported', help: 'No known exploit or PoC.' },
    ],
  },
];

export const ENVIRONMENTAL_METRICS_4 = [
  {
    key: 'CR',
    name: 'Confidentiality Requirement',
    help: 'How much this client cares about confidentiality here.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'H', label: 'High' },
      { value: 'M', label: 'Medium' },
      { value: 'L', label: 'Low' },
    ],
  },
  {
    key: 'IR',
    name: 'Integrity Requirement',
    help: 'How much this client cares about integrity here.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'H', label: 'High' },
      { value: 'M', label: 'Medium' },
      { value: 'L', label: 'Low' },
    ],
  },
  {
    key: 'AR',
    name: 'Availability Requirement',
    help: 'How much this client cares about availability here.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'H', label: 'High' },
      { value: 'M', label: 'Medium' },
      { value: 'L', label: 'Low' },
    ],
  },
  {
    key: 'MSI',
    name: 'Modified Integrity (subsequent)',
    help: 'Safety marks a flaw that can hurt people, not just data.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'S', label: 'Safety' },
      { value: 'H', label: 'High' },
      { value: 'L', label: 'Low' },
      { value: 'N', label: 'None' },
    ],
  },
  {
    key: 'MSA',
    name: 'Modified Availability (subsequent)',
    help: 'Safety marks a flaw that can hurt people, not just data.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'S', label: 'Safety' },
      { value: 'H', label: 'High' },
      { value: 'L', label: 'Low' },
      { value: 'N', label: 'None' },
    ],
  },
];

/** Recorded for the report, never scored — the specification is explicit on this. */
export const SUPPLEMENTAL_METRICS_4 = [
  {
    key: 'AU',
    name: 'Automatable',
    help: 'Can reconnaissance through exploitation be scripted?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'N', label: 'No' },
      { value: 'Y', label: 'Yes' },
    ],
  },
  {
    key: 'R',
    name: 'Recovery',
    help: 'How does the system come back afterwards?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'A', label: 'Automatic' },
      { value: 'U', label: 'User-initiated' },
      { value: 'I', label: 'Irrecoverable' },
    ],
  },
  {
    key: 'S',
    name: 'Safety',
    help: 'Could exploitation cause physical harm?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'N', label: 'Negligible' },
      { value: 'P', label: 'Present' },
    ],
  },
  {
    key: 'V',
    name: 'Value Density',
    help: 'How much is controlled by one successful attack?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'D', label: 'Diffuse' },
      { value: 'C', label: 'Concentrated' },
    ],
  },
  {
    key: 'RE',
    name: 'Response Effort',
    help: 'How much work is remediation for the client?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'L', label: 'Low' },
      { value: 'M', label: 'Moderate' },
      { value: 'H', label: 'High' },
    ],
  },
  {
    key: 'U',
    name: 'Provider Urgency',
    help: 'The vendor’s own stated urgency, if they publish one.',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'Red', label: 'Red' },
      { value: 'Amber', label: 'Amber' },
      { value: 'Green', label: 'Green' },
      { value: 'Clear', label: 'Clear' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Vector strings                                                             */
/* -------------------------------------------------------------------------- */

const ALL_VALUES = {
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
  E: ['X', 'A', 'P', 'U'],
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
  S: ['X', 'N', 'P'],
  AU: ['X', 'N', 'Y'],
  R: ['X', 'A', 'U', 'I'],
  V: ['X', 'D', 'C'],
  RE: ['X', 'L', 'M', 'H'],
  U: ['X', 'Clear', 'Green', 'Amber', 'Red'],
};

const VECTOR_ORDER = Object.keys(ALL_VALUES);
export const BASE_KEYS_4 = BASE_METRICS_4.map((m) => m.key);

export function parseVector4(vector) {
  const metrics = {};
  if (typeof vector !== 'string') return metrics;
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (!key || value === undefined || key.toUpperCase() === 'CVSS') continue;
    // Provider Urgency uses capitalised words, so values cannot be upper-cased.
    if (ALL_VALUES[key]?.includes(value)) metrics[key] = value;
  }
  return metrics;
}

export function buildVector4(metrics) {
  const parts = [CVSS4_PREFIX];
  for (const key of VECTOR_ORDER) {
    const value = metrics[key];
    if (value && value !== 'X') parts.push(`${key}:${value}`);
  }
  return parts.join('/');
}

export const isVectorComplete4 = (metrics) => BASE_KEYS_4.every((k) => Boolean(metrics[k]));

export function nomenclatureOf(metrics) {
  const set = (keys) => keys.some((k) => metrics[k] && metrics[k] !== 'X');
  let name = 'CVSS-B';
  if (set(['E'])) name += 'T';
  if (
    set([
      'CR', 'IR', 'AR',
      'MAV', 'MAC', 'MAT', 'MPR', 'MUI',
      'MVC', 'MVI', 'MVA', 'MSC', 'MSI', 'MSA',
    ])
  ) {
    name += 'E';
  }
  return name;
}

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

/** Round half up to one decimal; the epsilon defeats binary float artefacts. */
const round1 = (value) => Math.round((value + 1e-6) * 10) / 10;

const WORST_CASE = { E: 'A', CR: 'H', IR: 'H', AR: 'H' };

function effective(metrics, key) {
  if ((metrics[key] === 'X' || metrics[key] === undefined) && WORST_CASE[key]) {
    return WORST_CASE[key];
  }
  const modified = metrics[`M${key}`];
  if (modified && modified !== 'X') return modified;
  return metrics[key];
}

export function macroVectorOf(metrics) {
  const v = (key) => effective(metrics, key);

  const av = v('AV');
  const pr = v('PR');
  const ui = v('UI');
  const anyNone = av === 'N' || pr === 'N' || ui === 'N';
  const eq1 = av === 'N' && pr === 'N' && ui === 'N' ? '0' : anyNone && av !== 'P' ? '1' : '2';

  const eq2 = v('AC') === 'L' && v('AT') === 'N' ? '0' : '1';

  const vc = v('VC');
  const vi = v('VI');
  const va = v('VA');
  const eq3 = vc === 'H' && vi === 'H' ? '0' : vc === 'H' || vi === 'H' || va === 'H' ? '1' : '2';

  const safety = v('MSI') === 'S' || v('MSA') === 'S';
  const subsequentHigh = v('SC') === 'H' || v('SI') === 'H' || v('SA') === 'H';
  const eq4 = safety ? '0' : subsequentHigh ? '1' : '2';

  const e = v('E');
  const eq5 = e === 'A' ? '0' : e === 'P' ? '1' : '2';

  const eq6 =
    (v('CR') === 'H' && vc === 'H') ||
    (v('IR') === 'H' && vi === 'H') ||
    (v('AR') === 'H' && va === 'H')
      ? '0'
      : '1';

  return eq1 + eq2 + eq3 + eq4 + eq5 + eq6;
}

function fromMaxVector(maxVector, metric) {
  const at = maxVector.indexOf(`${metric}:`);
  if (at === -1) return undefined;
  const rest = maxVector.slice(at + metric.length + 1);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : rest;
}

function severityDistances(metrics, maxVector) {
  const distances = {};
  for (const metric of Object.keys(METRIC_LEVELS)) {
    distances[metric] =
      METRIC_LEVELS[metric][effective(metrics, metric)] -
      METRIC_LEVELS[metric][fromMaxVector(maxVector, metric)];
  }
  return distances;
}

const NO_IMPACT = ['VC', 'VI', 'VA', 'SC', 'SI', 'SA'];

export function scoreOf(metrics) {
  if (!isVectorComplete4(metrics)) return null;
  if (NO_IMPACT.every((metric) => effective(metrics, metric) === 'N')) return 0;

  const macroVector = macroVectorOf(metrics);
  const value = LOOKUP[macroVector];
  if (value === undefined) return null;

  const [eq1, eq2, eq3, eq4, eq5, eq6] = macroVector.split('').map(Number);
  const lower = (digits) => LOOKUP[digits.join('')];

  const msd = {
    eq1: value - lower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]),
    eq2: value - lower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]),
    eq4: value - lower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]),
    eq5: value - lower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]),
    eq3eq6:
      eq3 === 0 && eq6 === 0
        ? value -
          Math.max(
            lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]),
            lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6])
          )
        : eq3 === 1 && eq6 === 0
          ? value - lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1])
          : eq3 === 2
            ? value - lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1])
            : value - lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]),
  };

  const maxes = [
    MAX_COMPOSED.eq1[eq1],
    MAX_COMPOSED.eq2[eq2],
    MAX_COMPOSED.eq3[eq3][eq6],
    MAX_COMPOSED.eq4[eq4],
    MAX_COMPOSED.eq5[eq5],
  ];

  let distances = null;
  outer: for (const a of maxes[0]) {
    for (const b of maxes[1]) {
      for (const c of maxes[2]) {
        for (const d of maxes[3]) {
          for (const e of maxes[4]) {
            const candidate = severityDistances(metrics, a + b + c + d + e);
            if (Object.values(candidate).every((distance) => distance >= 0)) {
              distances = candidate;
              break outer;
            }
          }
        }
      }
    }
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

export function calculateCvss4(vector) {
  const metrics = parseVector4(vector);
  const complete = isVectorComplete4(metrics);

  if (!complete) {
    return {
      version: '4.0',
      nomenclature: nomenclatureOf(metrics),
      macroVector: null,
      vector: typeof vector === 'string' ? vector : '',
      metrics,
      complete: false,
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

  const baseOnly = {};
  for (const key of BASE_KEYS_4) baseOnly[key] = metrics[key];
  const withThreat = { ...baseOnly };
  if (metrics.E) withThreat.E = metrics.E;

  const baseScore = scoreOf(baseOnly);
  const threatScore = scoreOf(withThreat);
  const environmentalScore = scoreOf(metrics);

  return {
    version: '4.0',
    nomenclature: nomenclatureOf(metrics),
    macroVector: macroVectorOf(metrics),
    vector: buildVector4(metrics),
    metrics,
    complete: true,
    baseScore,
    baseSeverity: severityOf4(baseScore),
    temporalScore: threatScore,
    temporalSeverity: severityOf4(threatScore),
    threatScore,
    threatSeverity: severityOf4(threatScore),
    environmentalScore,
    environmentalSeverity: severityOf4(environmentalScore),
    score: environmentalScore,
    severity: severityOf4(environmentalScore),
    impact: null,
    exploitability: null,
  };
}

export default calculateCvss4;
