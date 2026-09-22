/**
 * Four things a report needed and did not have.
 *
 *   npm run test:report-craft
 *
 *   146  what actually changed between two renders, word by word
 *   147  preflight reading the prose, not only the structure
 *   148  roughly how long the document will be, before there is one
 *   149  sections that belong at the back rather than in the body
 *
 * The one worth the most care is 147, and it is the only check on this list that is a **blocker**:
 * another client's name left in a paragraph copied from their report. Every other problem here
 * produces an awkward document; that one puts one client's name in another client's file. A check
 * like that has to be trusted, so half of what is asserted below is what it must *not* fire on.
 */
import { diffWords, reportSnapshot, snapshotDifferences } from '../utils/report-fingerprint.js';
import { preflightAudit, estimatePages } from '../services/preflight.service.js';

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

/** A diff as a readable string: `{-gone}{+new}`. */
const asText = (pieces) =>
  (pieces ?? [])
    .map((p) => (p.op === 'same' ? p.text : p.op === 'added' ? `{+${p.text}}` : `{-${p.text}}`))
    .join('');

/* ------------------------------------------------------------ 146: the words --- */

console.log('What the words became:');

const edited = diffWords(
  'The application does not validate the token on the server.',
  'The application does not verify the token signature on the server.'
);
check(
  'an edit inside a sentence shows only the edit',
  asText(edited) ===
    'The application does not {-validate }{+verify }the token {+signature }on the server.',
  asText(edited)
);
check(
  'the unchanged words are still there, so it reads as a sentence',
  edited.some((p) => p.op === 'same' && p.text.includes('The application'))
);
check(
  'rejoining every piece gives the new text back exactly',
  edited
    .filter((p) => p.op !== 'removed')
    .map((p) => p.text)
    .join('') === 'The application does not verify the token signature on the server.',
  edited.filter((p) => p.op !== 'removed').map((p) => p.text).join('')
);
check(
  'and rejoining the other way gives the old one',
  edited
    .filter((p) => p.op !== 'added')
    .map((p) => p.text)
    .join('') === 'The application does not validate the token on the server.'
);

check('identical text is nothing to show', diffWords('same words', 'same words') === null);
check(
  'and so is a change that was only whitespace',
  diffWords('one  two', 'one two') === null,
  asText(diffWords('one  two', 'one two'))
);
check(
  'a wholesale rewrite is not shown word by word',
  diffWords('a '.repeat(700), 'b '.repeat(700)) === null,
  'a 700-word diff is not something anybody reads'
);
/*
 * The reason the common prefix and suffix are trimmed first.
 *
 * Not speed — correctness of the *output*. Two thousand-word paragraphs differing by one word are
 * both far past the limit, so without trimming this would give up and report a rewrite, which is
 * the worst possible answer: a reader told "rewritten" stops looking for the word that moved.
 */
const longBefore = `${'word '.repeat(1000)}validate${' word'.repeat(1000)}`;
const longAfter = `${'word '.repeat(1000)}verify${' word'.repeat(1000)}`;
const longDiff = diffWords(longBefore, longAfter);
check(
  'but a one-word change inside two long paragraphs still is',
  longDiff !== null &&
    /\{-validate\s*\}/.test(asText(longDiff)) &&
    /\{\+verify\s*\}/.test(asText(longDiff)),
  longDiff ? asText(longDiff).replace(/(word )+/g, '… ') : 'gave up and called it a rewrite'
);
/*
 * Four pieces: the thousand words before, the removal, the addition, the thousand after.
 *
 * The merging is what makes this readable — a run of unchanged words arrives as one passage rather
 * than as a thousand spans the browser then has to draw.
 */
check(
  'and the unchanged thousand words on each side are one piece, not a thousand',
  longDiff !== null && longDiff.length === 4,
  `${longDiff?.length} pieces: ${longDiff?.map((p) => p.op).join(', ')}`
);
check(
  'text added to nothing is all additions',
  asText(diffWords('', 'brand new')) === '{+brand new}',
  asText(diffWords('', 'brand new'))
);
check(
  'and text removed to nothing is all removals',
  asText(diffWords('was here', '')) === '{-was here}',
  asText(diffWords('was here', ''))
);

/* Through the snapshot, which is how it actually arrives. */
const before = reportSnapshot({
  findings: [
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Stored XSS',
      description: '<p>The search parameter is reflected without encoding.</p>',
      remediation: '<p>Encode on output.</p>',
    },
  ],
  sections: [],
  scope: [],
});
const after = reportSnapshot({
  findings: [
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Stored XSS',
      description: '<p>The search parameter is reflected without any encoding at all.</p>',
      remediation: '<p>Encode on output.</p>',
    },
  ],
  sections: [],
  scope: [],
});

const plain = snapshotDifferences(before, after);
check('a list of renders is told which field changed', plain[0]?.fields?.includes('description'));
check(
  'and is not made to compute the words it did not ask for',
  plain[0]?.diffs === undefined,
  JSON.stringify(Object.keys(plain[0] ?? {}))
);

const detailed = snapshotDifferences(before, after, { withText: true });
check(
  'the side-by-side view gets them',
  Boolean(detailed[0]?.diffs?.description),
  JSON.stringify(Object.keys(detailed[0]?.diffs ?? {}))
);
check(
  'showing what it became',
  asText(detailed[0].diffs.description).includes('{+any encoding at all.}') &&
    asText(detailed[0].diffs.description).includes('{-encoding.}'),
  asText(detailed[0].diffs.description)
);
check(
  'and only for the field that moved',
  Object.keys(detailed[0].diffs).join() === 'description',
  Object.keys(detailed[0].diffs).join()
);

check(
  'a snapshot from before the words were kept is reported as incomparable',
  snapshotDifferences({ ...before, v: 1 }, after, { withText: true }) === null
);

/* The budget, which is what stops this being a second copy of the engagement. */
const huge = reportSnapshot({
  findings: Array.from({ length: 200 }, (_f, i) => ({
    _id: String(i).padStart(24, '0'),
    title: `Finding ${i}`,
    description: `<p>${'word '.repeat(2000)}</p>`,
  })),
  sections: [],
  scope: [],
});
const stored = JSON.stringify(huge).length;
check(
  'a huge engagement does not store a copy of itself',
  stored < 700_000,
  `${(stored / 1024).toFixed(0)} KB`
);
check(
  'the early findings keep their words',
  Boolean(huge.findings[0].text?.description),
  'the budget is spent in order, so the first should have text'
);
check(
  'and the ones past the budget keep their hashes',
  huge.findings.at(-1).text?.description === undefined &&
    Boolean(huge.findings.at(-1).fields?.description),
  'a field past the budget still reports as changed'
);

/* ------------------------------------------------------- 147: reading the prose --- */

console.log('\nAnother client, in somebody else’s report:');

const others = [
  { label: 'Northwind Logistics', names: ['Northwind Logistics', 'Northwind'] },
  { label: 'Hypertec', names: ['Hypertec'] },
  /*
   * Short and ordinary: the two shapes this must not fire on.
   *
   * "IT" is the one that matters — word boundaries alone do not save it, because "the IT
   * department" contains IT as a whole word. Only the minimum length does.
   */
  { label: 'IT Services', names: ['IT Services', 'IT'] },
  { label: 'Data Group', names: ['Data Group', 'Data'] },
];

const withProse = (description) => ({
  name: 'zz',
  findings: [
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'A finding',
      description,
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    },
  ],
  sections: [],
  scope: [],
});

const codes = (audit) =>
  preflightAudit(audit, { otherClients: others }).issues.map((issue) => issue.code);

check(
  'a client named in a finding is caught',
  codes(withProse('<p>As agreed with Northwind Logistics, this was not exploited further.</p>')).includes(
    'other-client-named'
  )
);
check(
  'a short form of the name too',
  codes(withProse('<p>The Northwind estate was out of scope.</p>')).includes('other-client-named')
);
check(
  'and it is a blocker, not a warning',
  preflightAudit(withProse('<p>Northwind was mentioned.</p>'), { otherClients: others }).issues.find(
    (issue) => issue.code === 'other-client-named'
  )?.level === 'blocker'
);
check(
  'the detail names which client, so it can be searched for',
  preflightAudit(withProse('<p>Northwind was mentioned.</p>'), { otherClients: others }).issues
    .find((issue) => issue.code === 'other-client-named')
    ?.detail?.includes('Northwind Logistics')
);

console.log('\nAnd what it must not fire on:');

check(
  'ordinary prose',
  !codes(withProse('<p>The application does not validate the token.</p>')).includes(
    'other-client-named'
  )
);
check(
  'a two-letter client name used as an ordinary word',
  !codes(withProse('<p>The IT department was informed before testing began.</p>')).includes(
    'other-client-named'
  ),
  '"IT" is a whole word here, so only the minimum length keeps this quiet'
);
check(
  'a client name that is also an ordinary word',
  !codes(withProse('<p>The data was not encrypted at rest.</p>')).includes('other-client-named'),
  '"Data" is too common to look for'
);
check(
  'a name inside a longer word',
  !codes(withProse('<p>The northwindow component renders it.</p>')).includes('other-client-named'),
  'word boundaries'
);
check(
  'and nothing at all when no other clients are known',
  !preflightAudit(withProse('<p>Northwind was mentioned.</p>'))
    .issues.map((i) => i.code)
    .includes('other-client-named')
);

const inSection = preflightAudit(
  {
    name: 'zz',
    findings: [],
    sections: [{ field: 'executive_summary', name: 'Executive summary', text: '<p>Hypertec asked us to…</p>' }],
    scope: [],
  },
  { otherClients: others }
);
check(
  'a section is read as well as a finding',
  inSection.issues.some((issue) => issue.code === 'other-client-named' && issue.tab === 'sections'),
  JSON.stringify(inSection.issues.map((i) => i.code))
);

/* -------------------------------------------------------- 148: how long it is --- */

console.log('\nHow long it will be:');

const small = estimatePages({ findings: [], sections: [], enumeration: [] });
check('an empty engagement is one page, not zero', small.pages === 1, `${small.pages}`);

const real = estimatePages({
  sections: [{ text: `<p>${'word '.repeat(600)}</p>` }],
  findings: Array.from({ length: 8 }, () => ({
    description: `<p>${'word '.repeat(250)}</p>`,
    remediation: `<p>${'word '.repeat(100)}</p>`,
    poc: '<p><img src="/api/media/aaaaaaaaaaaaaaaaaaaaaaaa"></p>',
  })),
  enumeration: [],
});
check('a real one is more than a page', real.pages > 5, `${real.pages}`);
check('it counts the words', real.words > 3000, `${real.words}`);
check('and the screenshots', real.images === 8, `${real.images}`);
check(
  'it is reported as a range, because a single number would be believed',
  real.low < real.pages && real.high > real.pages,
  `${real.low}-${real.high} around ${real.pages}`
);
check(
  'output panes count as lines, not as words',
  estimatePages({
    findings: [],
    sections: [],
    enumeration: [{ output: 'line\n'.repeat(400) }],
  }).pages >= 10,
  'four hundred lines of a sweep is ten pages of pane'
);

const estimated = preflightAudit(real.words ? { ...withProse('<p>x</p>'), sections: [] } : {});
check(
  'and preflight says so',
  estimated.issues.some((issue) => issue.code === 'length-estimate'),
  JSON.stringify(estimated.issues.map((i) => i.code))
);

/* ------------------------------------------------------------- 149: appendices --- */

console.log('\nWhat belongs at the back:');

/* Through the model's own default rather than a literal, so the flag cannot drift. */
check(
  'a section is in the body unless it says otherwise',
  reportSnapshot({ findings: [], sections: [{ name: 'Methodology' }], scope: [] }).sections.length === 1
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
