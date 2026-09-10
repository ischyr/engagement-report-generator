/**
 * CVSS v3.1 calculator (base, temporal and environmental scores) implemented
 * from the official specification's formulas — no external dependency.
 *
 * https://www.first.org/cvss/v3.1/specification-document
 *
 * This module is also the single entry point for both supported versions:
 * `calculateCvss` looks at the vector's own prefix and hands v4.0 vectors to
 * `cvss4.js`, which returns the same shape. Callers — severity counts, sorting,
 * search, preflight, report data — never have to ask which version they hold.
 */

import {
  CVSS4_DEFAULT_VECTOR,
  CVSS4_METRIC_LABELS,
  CVSS4_METRICS,
  CVSS4_VALUE_LABELS,
  calculateCvss4,
  isCvss4,
  parseVector4,
} from './cvss4.js';

export {
  CVSS4_DEFAULT_VECTOR,
  CVSS4_METRICS,
  CVSS4_METRIC_LABELS,
  CVSS4_VALUE_LABELS,
  calculateCvss4,
  isCvss4,
};

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  // Privileges Required depends on whether Scope changed.
  PR: { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
  E: { X: 1, H: 1, F: 0.97, P: 0.94, U: 0.91 },
  RL: { X: 1, U: 1, W: 0.97, T: 0.96, O: 0.95 },
  RC: { X: 1, C: 1, R: 0.96, U: 0.92 },
  CIAR: { X: 1, H: 1.5, M: 1, L: 0.5 },
};

export const CVSS_METRICS = {
  AV: { name: 'Attack Vector', values: ['N', 'A', 'L', 'P'] },
  AC: { name: 'Attack Complexity', values: ['L', 'H'] },
  PR: { name: 'Privileges Required', values: ['N', 'L', 'H'] },
  UI: { name: 'User Interaction', values: ['N', 'R'] },
  S: { name: 'Scope', values: ['U', 'C'] },
  C: { name: 'Confidentiality', values: ['H', 'L', 'N'] },
  I: { name: 'Integrity', values: ['H', 'L', 'N'] },
  A: { name: 'Availability', values: ['H', 'L', 'N'] },
  E: { name: 'Exploit Code Maturity', values: ['X', 'H', 'F', 'P', 'U'] },
  RL: { name: 'Remediation Level', values: ['X', 'U', 'W', 'T', 'O'] },
  RC: { name: 'Report Confidence', values: ['X', 'C', 'R', 'U'] },
  CR: { name: 'Confidentiality Requirement', values: ['X', 'H', 'M', 'L'] },
  IR: { name: 'Integrity Requirement', values: ['X', 'H', 'M', 'L'] },
  AR: { name: 'Availability Requirement', values: ['X', 'H', 'M', 'L'] },
  MAV: { name: 'Modified Attack Vector', values: ['X', 'N', 'A', 'L', 'P'] },
  MAC: { name: 'Modified Attack Complexity', values: ['X', 'L', 'H'] },
  MPR: { name: 'Modified Privileges Required', values: ['X', 'N', 'L', 'H'] },
  MUI: { name: 'Modified User Interaction', values: ['X', 'N', 'R'] },
  MS: { name: 'Modified Scope', values: ['X', 'U', 'C'] },
  MC: { name: 'Modified Confidentiality', values: ['X', 'H', 'L', 'N'] },
  MI: { name: 'Modified Integrity', values: ['X', 'H', 'L', 'N'] },
  MA: { name: 'Modified Availability', values: ['X', 'H', 'L', 'N'] },
};

const BASE_KEYS = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];

export const CVSS_DEFAULT_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';

/** Spec's Roundup: smallest 1-decimal number >= x, guarding float artefacts. */
function roundUp1(x) {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

export function parseVector(vector) {
  const metrics = {};
  if (typeof vector !== 'string') return metrics;
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (!key || value === undefined) continue;
    if (key === 'CVSS') continue;
    const upper = key.toUpperCase();
    if (CVSS_METRICS[upper]?.values.includes(value.toUpperCase())) {
      metrics[upper] = value.toUpperCase();
    }
  }
  return metrics;
}

export function buildVector(metrics) {
  const order = [
    'AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A',
    'E', 'RL', 'RC',
    'CR', 'IR', 'AR',
    'MAV', 'MAC', 'MPR', 'MUI', 'MS', 'MC', 'MI', 'MA',
  ];
  const parts = ['CVSS:3.1'];
  for (const key of order) {
    const value = metrics[key];
    if (!value || value === 'X') continue;
    parts.push(`${key}:${value}`);
  }
  return parts.join('/');
}

/** True when every base metric is present — scores are meaningless otherwise. */
export function isVectorComplete(metrics) {
  return BASE_KEYS.every((k) => Boolean(metrics[k]));
}

export function severityOf(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'None';
  if (score === 0) return 'None';
  if (score < 4) return 'Low';
  if (score < 7) return 'Medium';
  if (score < 9) return 'High';
  return 'Critical';
}

function impactSubScore(c, i, a) {
  return 1 - (1 - c) * (1 - i) * (1 - a);
}

/**
 * @returns {{vector:string, baseScore:number|null, baseSeverity:string,
 *   temporalScore:number|null, temporalSeverity:string,
 *   environmentalScore:number|null, environmentalSeverity:string,
 *   impact:number|null, exploitability:number|null, metrics:object, complete:boolean}}
 */
export function calculateCvss(vector) {
  // v4.0 scores by macrovector lookup rather than by formula; same result shape.
  if (isCvss4(vector)) return calculateCvss4(vector);

  const m = parseVector(vector);
  const empty = {
    version: '3.1',
    nomenclature: 'CVSS:3.1',
    macroVector: null,
    vector: typeof vector === 'string' ? vector : '',
    metrics: m,
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
  if (!isVectorComplete(m)) return empty;

  const scopeChanged = m.S === 'C';

  /* ---------------------------------- base --------------------------------- */
  const iss = impactSubScore(W.CIA[m.C], W.CIA[m.I], W.CIA[m.A]);
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  const exploitability =
    8.22 * W.AV[m.AV] * W.AC[m.AC] * W.PR[m.S][m.PR] * W.UI[m.UI];

  const baseScore =
    impact <= 0
      ? 0
      : roundUp1(Math.min(scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability, 10));

  /* -------------------------------- temporal ------------------------------- */
  const e = W.E[m.E ?? 'X'];
  const rl = W.RL[m.RL ?? 'X'];
  const rc = W.RC[m.RC ?? 'X'];
  const temporalScore = roundUp1(baseScore * e * rl * rc);

  /* ----------------------------- environmental ----------------------------- */
  const pick = (modified, base) => (!modified || modified === 'X' ? base : modified);
  const mav = pick(m.MAV, m.AV);
  const mac = pick(m.MAC, m.AC);
  const mpr = pick(m.MPR, m.PR);
  const mui = pick(m.MUI, m.UI);
  const ms = pick(m.MS, m.S);
  const mc = pick(m.MC, m.C);
  const mi = pick(m.MI, m.I);
  const ma = pick(m.MA, m.A);
  const cr = W.CIAR[m.CR ?? 'X'];
  const ir = W.CIAR[m.IR ?? 'X'];
  const ar = W.CIAR[m.AR ?? 'X'];
  const mScopeChanged = ms === 'C';

  const miss = Math.min(
    1 - (1 - W.CIA[mc] * cr) * (1 - W.CIA[mi] * ir) * (1 - W.CIA[ma] * ar),
    0.915
  );
  const modifiedImpact = mScopeChanged
    ? 7.52 * (miss - 0.029) - 3.25 * (miss * 0.9731 - 0.02) ** 13
    : 6.42 * miss;
  const modifiedExploitability =
    8.22 * W.AV[mav] * W.AC[mac] * W.PR[ms][mpr] * W.UI[mui];

  const environmentalScore =
    modifiedImpact <= 0
      ? 0
      : roundUp1(
          roundUp1(
            Math.min(
              mScopeChanged
                ? 1.08 * (modifiedImpact + modifiedExploitability)
                : modifiedImpact + modifiedExploitability,
              10
            )
          ) * e * rl * rc
        );

  return {
    version: '3.1',
    nomenclature: 'CVSS:3.1',
    macroVector: null,
    vector: buildVector(m),
    metrics: m,
    complete: true,
    baseScore,
    baseSeverity: severityOf(baseScore),
    temporalScore,
    temporalSeverity: severityOf(temporalScore),
    // v4.0's name for the same idea, so shared code can use one field name.
    threatScore: temporalScore,
    threatSeverity: severityOf(temporalScore),
    environmentalScore,
    environmentalSeverity: severityOf(environmentalScore),
    /**
     * The headline number, as each version defines it: the base score for 3.1,
     * where temporal and environmental are adjustments on top, and the score of
     * everything supplied for 4.0, which has one score rather than three.
     */
    score: baseScore,
    severity: severityOf(baseScore),
    impact: Math.round(impact * 10) / 10,
    exploitability: Math.round(exploitability * 10) / 10,
  };
}

/** Hex colour for a severity label, using the palette from Settings. */
export function severityColor(severity, cvssColors = {}) {
  const map = {
    None: cvssColors.noneColor ?? '4A86E8',
    Low: cvssColors.lowColor ?? '008000',
    Medium: cvssColors.mediumColor ?? 'F9A009',
    High: cvssColors.highColor ?? 'FE6C00',
    Critical: cvssColors.criticalColor ?? 'D02D2D',
  };
  return (map[severity] ?? map.None).replace('#', '');
}

export const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

/** Worst first, which is the order a report prints them in. */
export const SEVERITY_NAMES = ['Critical', 'High', 'Medium', 'Low', 'None'];

/**
 * Where an overridden finding sorts.
 *
 * The middle of the band it was moved into, so it lands among its new peers rather than at the
 * score its vector still computes — a finding downgraded to Medium must not sit above every real
 * High because the maths says 8.1. The vector's own score breaks ties inside a band.
 */
const BAND_MIDPOINT = { Critical: 9.5, High: 8, Medium: 5.5, Low: 2.5, None: 0 };

/**
 * A finding's severity, taking an override into account.
 *
 * Severity was derived from the vector and nothing else, which is right arithmetic and wrong
 * practice: a Critical behind a compensating control is reported as a High, and a Medium that
 * reaches the payment flow is argued up. Firms do this in the document by hand today, which
 * means the app's counts, charts and the report disagree with each other.
 *
 * An override equal to the computed value is not an override — nobody needs a justification for
 * calling a High a High — so it reports as untouched and prints no reason.
 *
 * @param {{cvssv3?: string, severityOverride?: string, severityOverrideReason?: string}} finding
 */
export function findingSeverity(finding) {
  const cvss = calculateCvss(finding?.cvssv3);
  const wanted = String(finding?.severityOverride ?? '').trim();
  const overridden = Boolean(wanted) && SEVERITY_NAMES.includes(wanted) && wanted !== cvss.baseSeverity;
  const severity = overridden ? wanted : cvss.baseSeverity;

  return {
    severity,
    /** What the vector says, kept so a report can print both and show its working. */
    cvssSeverity: cvss.baseSeverity,
    score: cvss.baseScore,
    overridden,
    reason: overridden ? String(finding?.severityOverrideReason ?? '') : '',
    sortScore: overridden ? BAND_MIDPOINT[severity] ?? 0 : (cvss.baseScore ?? -1),
  };
}
export const COMPLEXITY_LABELS = { 1: 'Easy', 2: 'Medium', 3: 'Complex' };

/** Human-readable value names, so templates can print "Network" not "N". */
const VALUE_LABELS = {
  AV: { N: 'Network', A: 'Adjacent Network', L: 'Local', P: 'Physical' },
  AC: { L: 'Low', H: 'High' },
  PR: { N: 'None', L: 'Low', H: 'High' },
  UI: { N: 'None', R: 'Required' },
  S: { U: 'Unchanged', C: 'Changed' },
  C: { H: 'High', L: 'Low', N: 'None' },
  I: { H: 'High', L: 'Low', N: 'None' },
  A: { H: 'High', L: 'Low', N: 'None' },
  E: { X: 'Not Defined', H: 'High', F: 'Functional', P: 'Proof-of-Concept', U: 'Unproven' },
  RL: { X: 'Not Defined', U: 'Unavailable', W: 'Workaround', T: 'Temporary Fix', O: 'Official Fix' },
  RC: { X: 'Not Defined', C: 'Confirmed', R: 'Reasonable', U: 'Unknown' },
  CR: { X: 'Not Defined', H: 'High', M: 'Medium', L: 'Low' },
  IR: { X: 'Not Defined', H: 'High', M: 'Medium', L: 'Low' },
  AR: { X: 'Not Defined', H: 'High', M: 'Medium', L: 'Low' },
};

/**
 * Expands a vector into `{ AV: 'Network', AC: 'Low', … }` for templates that
 * print a CVSS breakdown table.
 */
export function describeMetrics(vector) {
  if (isCvss4(vector)) {
    const metrics = parseVector4(vector);
    const out = {};
    for (const [key, value] of Object.entries(metrics)) {
      // MVC describes VC, MSI describes SI, and so on.
      const base = /^M[A-Z]{2}$/.test(key) ? key.slice(1) : key;
      out[key] = CVSS4_VALUE_LABELS[base]?.[value] ?? CVSS4_VALUE_LABELS[key]?.[value] ?? value;
    }
    return out;
  }

  const metrics = parseVector(vector);
  const out = {};
  for (const [key, value] of Object.entries(metrics)) {
    const base = key.startsWith('M') && key !== 'MS' ? key.slice(1) : key === 'MS' ? 'S' : key;
    out[key] = VALUE_LABELS[base]?.[value] ?? value;
  }
  return out;
}

export { VALUE_LABELS };

export default { calculateCvss, parseVector, buildVector, severityOf, severityColor };
