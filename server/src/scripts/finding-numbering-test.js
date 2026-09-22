/**
 * The numbers in the report, and whether they are in order.
 *
 *   npm run test:numbering
 *
 * Four places decided what order findings go in, and three of them used the vector's own base
 * score while the report used the overridden severity. A finding argued down from Critical to
 * Medium still computes 9.8, so it led the findings tab and it led the renumber — and then the
 * report printed it among the Mediums. Pressing "Renumber", whose entire job is to make the
 * printed numbers ascend, could leave them *less* in order than before.
 *
 * So the fixture below is built entirely out of arguments: every finding in it would sort
 * differently on its raw score than on the severity it is actually reported at. If the four
 * orderings ever drift apart again, every check in the first section fails at once.
 */
import { buildReportData } from '../services/report.service.js';
import { calculateCvss, findingSeverity, orderFindings } from '../services/cvss.js';
import { findingSortScore as clientSortScore } from '../../../client/src/lib/cvss.js';
import { preflightAudit } from '../services/preflight.service.js';

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

const V = {
  critical: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  high: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
  low: 'CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:L/A:N',
};

/* The fixture only means anything if the vectors score what it assumes, so that is asserted
 * rather than believed — a mistyped vector would otherwise make every check below vacuous. */
console.log('The fixture scores what it claims:');
check('the Critical vector scores 9.8', calculateCvss(V.critical).baseScore === 9.8, String(calculateCvss(V.critical).baseScore));
check('the High vector scores 7.5', calculateCvss(V.high).baseScore === 7.5, String(calculateCvss(V.high).baseScore));
check(
  'the Low vector scores 3.7',
  calculateCvss(V.low).baseScore === 3.7 && calculateCvss(V.low).baseSeverity === 'Low',
  `${calculateCvss(V.low).baseSeverity} ${calculateCvss(V.low).baseScore}`
);

/**
 * Two findings arguing in opposite directions, and two that are what they compute.
 *
 * `argued-up` scores 3.7 and is reported Critical; `argued-down` scores 9.8 and is reported Low.
 * On the raw score they are last and first of the four; on the reported severity they swap.
 */
const findings = [
  { _id: 'a'.repeat(24), title: 'Plain critical', cvssv3: V.critical, identifier: 1 },
  {
    _id: 'b'.repeat(24),
    title: 'Argued up',
    cvssv3: V.low,
    severityOverride: 'Critical',
    severityOverrideReason: 'Reaches the payment flow.',
    identifier: 2,
  },
  { _id: 'c'.repeat(24), title: 'Plain high', cvssv3: V.high, identifier: 3 },
  {
    _id: 'd'.repeat(24),
    title: 'Argued down',
    cvssv3: V.critical,
    severityOverride: 'Low',
    severityOverrideReason: 'Behind a compensating control.',
    identifier: 4,
  },
];

/* Critical 9.8, argued-up 9.5 (mid-Critical), high 7.5, argued-down 2.5 (mid-Low). */
const EXPECTED = ['Plain critical', 'Argued up', 'Plain high', 'Argued down'];
/* What the raw base score gives — the two 9.8s tie and break on title. This is what three of the
 * four places used to do, and it agrees with EXPECTED nowhere but the middle. */
const RAW = ['Argued down', 'Plain critical', 'Plain high', 'Argued up'];

const auditOf = (list, extra = {}) => ({
  _id: 'f'.repeat(24),
  name: 'Numbering',
  findings: list,
  scope: [],
  sections: [],
  enumeration: [],
  sortFindings: true,
  ...extra,
});

const settings = { report: { public: { findingIdPrefix: 'VULN-', dateFormat: 'yyyy-MM-dd' } } };

const reportOrder = (list, extra) =>
  buildReportData(auditOf(list, extra), settings, { parts: null, numbering: null }, {
    target: 'html',
    templateName: 'test',
  }).findings.map((finding) => finding.title);

/* ------------------------------------------------------- everybody agrees -------- */

console.log('\nOne order, four places:');

check('the fixture would sort differently on the raw score', EXPECTED.join('|') !== RAW.join('|'));

check(
  'the report prints by the severity it reports, not by the vector',
  reportOrder(findings).join('|') === EXPECTED.join('|'),
  reportOrder(findings).join('|')
);
check(
  'the renumber puts them in the same order',
  orderFindings(findings).map((f) => f.title).join('|') === EXPECTED.join('|'),
  orderFindings(findings).map((f) => f.title).join('|')
);
check(
  'the findings tab shows the same order',
  [...findings]
    .sort((a, b) => clientSortScore(b) - clientSortScore(a) || a.title.localeCompare(b.title))
    .map((f) => f.title)
    .join('|') === EXPECTED.join('|')
);

/* The client keeps its own copy of the scoring, the way it keeps its own `calculateCvss`. This is
 * the check that stops the two copies drifting, which is the only thing that makes it safe. */
console.log('\nThe client copy scores what the server does:');
for (const finding of [
  ...findings,
  { title: 'no vector', cvssv3: '' },
  { title: 'empty override', cvssv3: V.high, severityOverride: '' },
  { title: 'override equal to computed', cvssv3: V.high, severityOverride: 'High' },
  { title: 'nonsense override', cvssv3: V.high, severityOverride: 'Catastrophic' },
  { title: 'override to None', cvssv3: V.high, severityOverride: 'None' },
]) {
  check(
    `  ${finding.title}`,
    clientSortScore(finding) === findingSeverity(finding).sortScore,
    `client ${clientSortScore(finding)} vs server ${findingSeverity(finding).sortScore}`
  );
}

/* --------------------------------------------------------------- the numbers ----- */

console.log('\nWhat the reader sees:');

/* Identifiers assigned in print order — what the renumber does — must read 01, 02, 03, 04. */
const renumbered = orderFindings(findings).map((finding, index) => ({
  ...finding,
  identifier: index + 1,
}));
check(
  'after a renumber the ids ascend with no gaps',
  reportOrder(renumbered, {}).length === 4 &&
    buildReportData(auditOf(renumbered), settings, { parts: null, numbering: null }, {
      target: 'html',
      templateName: 'test',
    })
      .findings.map((f) => f.id)
      .join(',') === 'VULN-01,VULN-02,VULN-03,VULN-04'
);

const built = buildReportData(auditOf(findings), settings, { parts: null, numbering: null }, {
  target: 'html',
  templateName: 'test',
});

/* The stable id may have gaps; the positional one never may, or "finding 3 of 12" is a lie. */
check(
  'positionId always counts 1..n whatever the ids are',
  built.findings.map((f) => f.positionId).join(',') === 'VULN-01,VULN-02,VULN-03,VULN-04',
  built.findings.map((f) => f.positionId).join(',')
);
check(
  'number matches the reading position',
  built.findings.every((finding, index) => finding.number === index + 1)
);
/*
 * The stored identifiers are 1, 2, 3, 4 in the order the findings were written; the print order is
 * a different order entirely. The ids follow the finding, not the position — which is the whole
 * point of a stable identifier, and the reason the report can read 01, 04, 07 at all.
 */
check(
  'a finding keeps its own number when the order moves it',
  built.findings.map((f) => `${f.title}=${f.id}`).join(',') ===
    'Plain critical=VULN-01,Argued up=VULN-02,Plain high=VULN-03,Argued down=VULN-04',
  built.findings.map((f) => `${f.title}=${f.id}`).join(',')
);

/* Padding, which is what makes a list line up in a table of contents. */
const wide = buildReportData(
  auditOf([
    { _id: '1'.repeat(24), title: 'Seventh', cvssv3: V.critical, identifier: 7 },
    { _id: '2'.repeat(24), title: 'Twelfth', cvssv3: V.high, identifier: 12 },
    { _id: '3'.repeat(24), title: 'Hundredth', cvssv3: V.low, identifier: 100 },
  ]),
  settings,
  { parts: null, numbering: null },
  { target: 'html', templateName: 'test' }
);
check(
  'single digits are padded and larger numbers are left alone',
  wide.findings.map((f) => f.id).join(',') === 'VULN-07,VULN-12,VULN-100',
  wide.findings.map((f) => f.id).join(',')
);

/* A finding written before identifiers existed falls back to its position — and the figures inside
 * it are prefixed with the same number, which they were not when the sort ran afterwards. */
const legacy = buildReportData(
  auditOf([
    { _id: '4'.repeat(24), title: 'Scored high', cvssv3: V.high },
    { _id: '5'.repeat(24), title: 'Scored critical', cvssv3: V.critical },
  ]),
  settings,
  { parts: null, numbering: null },
  { target: 'html', templateName: 'test' }
);
check(
  'a finding with no identifier falls back to its printed position',
  legacy.findings.map((f) => `${f.title}=${f.id}`).join(',') ===
    'Scored critical=VULN-01,Scored high=VULN-02',
  legacy.findings.map((f) => `${f.title}=${f.id}`).join(',')
);

/* ---------------------------------------------------------- manual ordering ------ */

console.log('\nWhen the order is set by hand:');

const manual = [
  { _id: '6'.repeat(24), title: 'Third by score', cvssv3: V.low, sortIndex: 0, identifier: 1 },
  { _id: '7'.repeat(24), title: 'First by score', cvssv3: V.critical, sortIndex: 1, identifier: 2 },
];
check(
  'the report follows sortIndex, not the score',
  reportOrder(manual, { sortFindings: false }).join('|') === 'Third by score|First by score',
  reportOrder(manual, { sortFindings: false }).join('|')
);
check(
  'and the renumber follows it too',
  orderFindings(manual, { manual: true }).map((f) => f.title).join('|') ===
    'Third by score|First by score'
);

/* ------------------------------------------------------------------ preflight ---- */

console.log('\nBeing told before it is a .docx:');

const ragged = auditOf([
  { _id: '8'.repeat(24), title: 'One', cvssv3: V.critical, identifier: 1 },
  { _id: '9'.repeat(24), title: 'Two', cvssv3: V.high, identifier: 4 },
  { _id: 'a'.repeat(24), title: 'Three', cvssv3: V.low, identifier: 7 },
]);
const raggedIssues = preflightAudit(ragged).issues.filter((i) => i.code === 'finding-numbering');
check('a run with gaps is reported', raggedIssues.length === 1);
check('as a note, not a blocker', raggedIssues[0]?.level === 'note', raggedIssues[0]?.level);
check('and it quotes what the report will read', /01, 04, 07/.test(raggedIssues[0]?.detail ?? ''), raggedIssues[0]?.detail);
check('and points at the tab that fixes it', raggedIssues[0]?.tab === 'findings');

const tidy = auditOf([
  { _id: '8'.repeat(24), title: 'One', cvssv3: V.critical, identifier: 1 },
  { _id: '9'.repeat(24), title: 'Two', cvssv3: V.high, identifier: 2 },
]);
check(
  'a clean run says nothing',
  preflightAudit(tidy).issues.every((i) => i.code !== 'finding-numbering')
);

/* Out of *order* rather than gapped — the case the override bug produced, and the one a check
 * that only looked for gaps would miss entirely. */
const outOfOrder = auditOf([
  { _id: '8'.repeat(24), title: 'Low, argued up', cvssv3: V.low, severityOverride: 'Critical', identifier: 2 },
  { _id: '9'.repeat(24), title: 'High', cvssv3: V.high, identifier: 1 },
]);
check(
  'numbers that are complete but out of order are reported',
  preflightAudit(outOfOrder).issues.some((i) => i.code === 'finding-numbering')
);

/* One finding cannot be out of order with itself, and a note saying so would be noise. */
check(
  'a single finding is never reported',
  preflightAudit(auditOf([{ _id: '8'.repeat(24), title: 'Only', cvssv3: V.high, identifier: 4 }])).issues.every(
    (i) => i.code !== 'finding-numbering'
  )
);
check(
  'and neither is an engagement with none',
  preflightAudit(auditOf([])).issues.every((i) => i.code !== 'finding-numbering')
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
