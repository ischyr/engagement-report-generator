/**
 * CVSS v3.1 calculator for the browser, so the score updates as the tester
 * clicks metrics without a round-trip.
 *
 * This mirrors `server/src/services/cvss.js`. The server stays authoritative —
 * it recomputes on every read and when generating reports — but both implement
 * the same published formulas, so they cannot drift in behaviour.
 * https://www.first.org/cvss/v3.1/specification-document
 */

import { calculateCvss4, isCvss4 } from './cvss4.js';

export { calculateCvss4, isCvss4 };
export { CVSS4_DEFAULT_VECTOR } from './cvss4.js';

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
  E: { X: 1, H: 1, F: 0.97, P: 0.94, U: 0.91 },
  RL: { X: 1, U: 1, W: 0.97, T: 0.96, O: 0.95 },
  RC: { X: 1, C: 1, R: 0.96, U: 0.92 },
  CIAR: { X: 1, H: 1.5, M: 1, L: 0.5 },
};

export const CVSS_DEFAULT_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';

const BASE_KEYS = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];

/** Metric definitions driving the picker UI: order, labels, help text. */
export const BASE_METRICS = [
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
    help: 'Do conditions beyond the attacker’s control have to line up?',
    values: [
      { value: 'L', label: 'Low', help: 'Repeatable, no special conditions.' },
      { value: 'H', label: 'High', help: 'Depends on configuration or a race.' },
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
    help: 'Must a victim do something?',
    values: [
      { value: 'N', label: 'None', help: 'No victim action needed.' },
      { value: 'R', label: 'Required', help: 'A user must click or visit something.' },
    ],
  },
  {
    key: 'S',
    name: 'Scope',
    help: 'Can the impact cross a security boundary?',
    values: [
      { value: 'U', label: 'Unchanged', help: 'Impact stays in the same component.' },
      { value: 'C', label: 'Changed', help: 'Impact reaches beyond it.' },
    ],
  },
  {
    key: 'C',
    name: 'Confidentiality',
    help: 'How much data can be read?',
    values: [
      { value: 'H', label: 'High', help: 'Total disclosure.' },
      { value: 'L', label: 'Low', help: 'Some disclosure.' },
      { value: 'N', label: 'None', help: 'No disclosure.' },
    ],
  },
  {
    key: 'I',
    name: 'Integrity',
    help: 'How much data can be altered?',
    values: [
      { value: 'H', label: 'High', help: 'Total loss of integrity.' },
      { value: 'L', label: 'Low', help: 'Limited modification.' },
      { value: 'N', label: 'None', help: 'No modification.' },
    ],
  },
  {
    key: 'A',
    name: 'Availability',
    help: 'How much service can be denied?',
    values: [
      { value: 'H', label: 'High', help: 'Full denial of service.' },
      { value: 'L', label: 'Low', help: 'Reduced performance.' },
      { value: 'N', label: 'None', help: 'No impact.' },
    ],
  },
];

export const TEMPORAL_METRICS = [
  {
    key: 'E',
    name: 'Exploit Code Maturity',
    help: 'How readily available is working exploit code?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'H', label: 'High' },
      { value: 'F', label: 'Functional' },
      { value: 'P', label: 'Proof-of-concept' },
      { value: 'U', label: 'Unproven' },
    ],
  },
  {
    key: 'RL',
    name: 'Remediation Level',
    help: 'Is a fix available?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'U', label: 'Unavailable' },
      { value: 'W', label: 'Workaround' },
      { value: 'T', label: 'Temporary fix' },
      { value: 'O', label: 'Official fix' },
    ],
  },
  {
    key: 'RC',
    name: 'Report Confidence',
    help: 'How confident are you in this finding?',
    values: [
      { value: 'X', label: 'Not defined' },
      { value: 'C', label: 'Confirmed' },
      { value: 'R', label: 'Reasonable' },
      { value: 'U', label: 'Unknown' },
    ],
  },
];

const ALL_VALID = (() => {
  const map = {};
  for (const metric of [...BASE_METRICS, ...TEMPORAL_METRICS]) {
    map[metric.key] = metric.values.map((v) => v.value);
  }
  // Environmental requirement metrics are accepted on parse even though the UI
  // does not expose them yet, so imported vectors survive a round-trip.
  for (const key of ['CR', 'IR', 'AR']) map[key] = ['X', 'H', 'M', 'L'];
  map.MAV = ['X', 'N', 'A', 'L', 'P'];
  map.MAC = ['X', 'L', 'H'];
  map.MPR = ['X', 'N', 'L', 'H'];
  map.MUI = ['X', 'N', 'R'];
  map.MS = ['X', 'U', 'C'];
  map.MC = ['X', 'H', 'L', 'N'];
  map.MI = ['X', 'H', 'L', 'N'];
  map.MA = ['X', 'H', 'L', 'N'];
  return map;
})();

const VECTOR_ORDER = [
  'AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A',
  'E', 'RL', 'RC',
  'CR', 'IR', 'AR',
  'MAV', 'MAC', 'MPR', 'MUI', 'MS', 'MC', 'MI', 'MA',
];

/** Spec's Roundup: smallest 1-decimal value >= x, immune to float artefacts. */
function roundUp1(x) {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

export function parseVector(vector) {
  const metrics = {};
  if (typeof vector !== 'string') return metrics;
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (!key || value === undefined || key === 'CVSS') continue;
    const k = key.toUpperCase();
    const v = value.toUpperCase();
    if (ALL_VALID[k]?.includes(v)) metrics[k] = v;
  }
  return metrics;
}

export function buildVector(metrics) {
  const parts = ['CVSS:3.1'];
  for (const key of VECTOR_ORDER) {
    const value = metrics[key];
    if (!value || value === 'X') continue;
    parts.push(`${key}:${value}`);
  }
  return parts.join('/');
}

export const isVectorComplete = (metrics) => BASE_KEYS.every((k) => Boolean(metrics[k]));

export function severityOf(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'None';
  if (score === 0) return 'None';
  if (score < 4) return 'Low';
  if (score < 7) return 'Medium';
  if (score < 9) return 'High';
  return 'Critical';
}

export function calculateCvss(vector) {
  // Findings may carry either version; the vector says which.
  if (isCvss4(vector)) return calculateCvss4(vector);

  const m = parseVector(vector);
  if (!isVectorComplete(m)) {
    return {
      version: '3.1',
      nomenclature: 'CVSS:3.1',
      vector: typeof vector === 'string' ? vector : '',
      metrics: m,
      complete: false,
      baseScore: null,
      baseSeverity: 'None',
      temporalScore: null,
      temporalSeverity: 'None',
      score: null,
      severity: 'None',
      impact: null,
      exploitability: null,
    };
  }

  const scopeChanged = m.S === 'C';
  const iss = 1 - (1 - W.CIA[m.C]) * (1 - W.CIA[m.I]) * (1 - W.CIA[m.A]);
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  const exploitability = 8.22 * W.AV[m.AV] * W.AC[m.AC] * W.PR[m.S][m.PR] * W.UI[m.UI];

  const baseScore =
    impact <= 0
      ? 0
      : roundUp1(
          Math.min(scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability, 10)
        );

  const temporalScore = roundUp1(
    baseScore * W.E[m.E ?? 'X'] * W.RL[m.RL ?? 'X'] * W.RC[m.RC ?? 'X']
  );

  return {
    version: '3.1',
    nomenclature: 'CVSS:3.1',
    vector: buildVector(m),
    metrics: m,
    complete: true,
    baseScore,
    baseSeverity: severityOf(baseScore),
    temporalScore,
    temporalSeverity: severityOf(temporalScore),
    /** The headline number: base for 3.1, everything supplied for 4.0. */
    score: baseScore,
    severity: severityOf(baseScore),
    impact: Math.round(impact * 10) / 10,
    exploitability: Math.round(exploitability * 10) / 10,
  };
}

export default calculateCvss;
