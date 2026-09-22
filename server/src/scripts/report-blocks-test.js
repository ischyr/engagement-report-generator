/**
 * Checks the five things a report needs that a general-purpose editor does not give you.
 *
 *   npm run test:report-blocks
 *
 * A page break, a callout box, a reference to another finding, a footnote, and the charts that
 * are not the severity ring. Each of them existed as a workaround before: "Note:" at the start of
 * a paragraph, a row of dashes, "see VULN-04" typed by hand, a parenthetical two lines long.
 *
 * The failures worth guarding here are the ones that look like nothing. An attribute the sanitiser
 * drops turns every warning box into a paragraph — in one deliverable only, while the other keeps
 * it. A reference that resolves to the wrong label points a client at the wrong finding. Both
 * produce a document that opens cleanly and says something untrue, which is the only kind of bug
 * this file is really about.
 */
import { htmlToOoxml, CALLOUTS } from '../services/ooxml/html2ooxml.js';
import { sanitizeHtml } from '../services/html-report.service.js';
import { resolveFindingRefs, MISSING_FINDING } from '../services/report.service.js';
import { rankedTableHtml } from '../services/chart.service.js';

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

const textOf = (xml) =>
  [...String(xml).matchAll(/<w:t(?=[ >])[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1])
    .join('')
    .replace(/&amp;/g, '&');

/* ------------------------------------------------------------------- page break --- */

console.log('A page break the author placed:');

const broken = htmlToOoxml('<p>Before.</p><hr data-page-break><p>After.</p>', {});
check('it is a real page break', broken.includes('<w:br w:type="page"/>'), broken.slice(0, 120));
check(
  'on a paragraph of its own, so deleting a word cannot take it',
  /<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/.test(broken),
  broken.slice(broken.indexOf('page'), broken.indexOf('page') + 80)
);
check('and the prose on both sides survives', textOf(broken) === 'Before.After.', textOf(broken));

const rule = htmlToOoxml('<p>a</p><hr><p>b</p>', {});
check('a plain rule is still a rule', !rule.includes('w:type="page"') && rule.includes('<w:pBdr>'), rule.slice(0, 160));
check(
  'the sanitiser keeps the attribute that tells them apart',
  sanitizeHtml('<hr data-page-break>').includes('data-page-break'),
  sanitizeHtml('<hr data-page-break>')
);

/* --------------------------------------------------------------------- callouts --- */

console.log('\nCallout boxes:');

for (const [kind, style] of Object.entries(CALLOUTS)) {
  const out = htmlToOoxml(`<aside data-callout="${kind}"><p>Body text.</p></aside>`, {});
  check(
    `${kind} is drawn as a shaded box in its own colour`,
    out.includes(`w:fill="${style.fill}"`) && out.includes(`w:color="${style.border}"`),
    out.slice(0, 140)
  );
  check(`${kind} says what it is`, textOf(out).startsWith(style.label), textOf(out));
}

const warned = htmlToOoxml('<aside data-callout="warning"><p>Breaks single sign-on.</p></aside>', {});
check(
  'the left edge is heavier than the rest, which is what makes it scannable',
  /<w:left w:val="single" w:sz="24"/.test(warned) && /<w:top w:val="single" w:sz="2"/.test(warned),
  warned.slice(0, 200)
);
check(
  'it cannot be split across a page',
  warned.includes('<w:cantSplit/>'),
  warned.slice(0, 200)
);
check(
  'the label and the body are on one line',
  textOf(warned) === 'Warning  Breaks single sign-on.',
  JSON.stringify(textOf(warned))
);

const listy = htmlToOoxml(
  '<aside data-callout="danger"><p>Do not run this on:</p><ul><li>prod</li><li>staging</li></ul></aside>',
  { numbering: { bulletNumId: 1, orderedNumId: 2 } }
);
check(
  'a callout can hold a list, not only a sentence',
  listy.includes('<w:numPr>') && textOf(listy).includes('prod'),
  textOf(listy)
);
check(
  'and the label still leads it',
  textOf(listy).startsWith('Danger'),
  textOf(listy)
);

const unknown = htmlToOoxml('<aside data-callout="banana"><p>x</p></aside>', {});
check(
  'an unknown kind falls back to a note rather than losing the box',
  unknown.includes(`w:fill="${CALLOUTS.note.fill}"`),
  unknown.slice(0, 120)
);
const plainAside = htmlToOoxml('<aside><p>Just a block.</p></aside>', {});
check(
  'an <aside> with no attribute is an ordinary block',
  !plainAside.includes('<w:tbl>') && textOf(plainAside) === 'Just a block.',
  textOf(plainAside)
);
check(
  'the sanitiser keeps the kind',
  sanitizeHtml('<aside data-callout="danger"><p>x</p></aside>').includes('data-callout="danger"'),
  sanitizeHtml('<aside data-callout="danger"><p>x</p></aside>')
);
check(
  'and drops anything else it was given',
  !sanitizeHtml('<aside data-callout="note" onclick="x"><p>y</p></aside>').includes('onclick'),
  sanitizeHtml('<aside data-callout="note" onclick="x"><p>y</p></aside>')
);

/* ------------------------------------------------------------ finding references --- */

console.log('\nReferring to another finding:');

const labels = new Map([
  ['aaaaaaaaaaaaaaaaaaaaaaaa', 'VULN-04'],
  ['bbbbbbbbbbbbbbbbbbbbbbbb', 'VULN-11'],
]);
const chip = (id, words) => `<span data-findingref="${id}">${words}</span>`;

check(
  'a chip becomes the label the report prints',
  resolveFindingRefs(`<p>See ${chip('aaaaaaaaaaaaaaaaaaaaaaaa', 'Stored XSS')}.</p>`, labels) ===
    '<p>See VULN-04.</p>',
  resolveFindingRefs(`<p>See ${chip('aaaaaaaaaaaaaaaaaaaaaaaa', 'Stored XSS')}.</p>`, labels)
);
check(
  'two chips in one sentence both resolve',
  resolveFindingRefs(
    `<p>${chip('aaaaaaaaaaaaaaaaaaaaaaaa', 'a')} and ${chip('bbbbbbbbbbbbbbbbbbbbbbbb', 'b')}</p>`,
    labels
  ) === '<p>VULN-04 and VULN-11</p>'
);
check(
  'a reference to a finding that has gone says so',
  resolveFindingRefs(`<p>See ${chip('cccccccccccccccccccccccc', 'Deleted one')}.</p>`, labels) ===
    `<p>See ${MISSING_FINDING}.</p>`,
  resolveFindingRefs(`<p>See ${chip('cccccccccccccccccccccccc', 'Deleted one')}.</p>`, labels)
);
check(
  'the words naming it go with it, rather than asserting something untrue',
  !resolveFindingRefs(`<p>${chip('cccccccccccccccccccccccc', 'Deleted one')}</p>`, labels).includes(
    'Deleted one'
  )
);
check(
  'prose with no chips is returned untouched',
  resolveFindingRefs('<p>Ordinary <b>prose</b>.</p>', labels) === '<p>Ordinary <b>prose</b>.</p>'
);
check(
  'an id that is not a finding id is left alone',
  resolveFindingRefs('<span data-findingref="nope">x</span>', labels) ===
    '<span data-findingref="nope">x</span>'
);
check('no labels means nothing to do', resolveFindingRefs('<p>a</p>', new Map()) === '<p>a</p>');

/* Reinstating the fault: a reference that silently keeps the author's words is the bad version. */
check(
  'the check would notice a missing reference left as prose',
  resolveFindingRefs(`<p>${chip('cccccccccccccccccccccccc', 'Deleted one')}</p>`, labels) !==
    '<p>Deleted one</p>',
  'the missing-finding assertion is not load-bearing'
);

/*
 * Preflight reads the same chips, with its own copy of the expression.
 *
 * Its own on purpose — importing the report builder into preflight for one regex would pull the
 * whole thing in. The copy is the risk, so both are run over the same markup here: they have to
 * find the same references or one of them is quietly missing some.
 */
const PREFLIGHT_PATTERN =
  /<span\b[^>]*\bdata-findingref="([0-9a-f]{24})"[^>]*>([\s\S]*?)<\/span>/gi;
const sample =
  `<p>${chip('aaaaaaaaaaaaaaaaaaaaaaaa', 'one')} then ` +
  `${chip('cccccccccccccccccccccccc', 'gone')} and <span>plain</span>.</p>`;
const found = [...sample.matchAll(PREFLIGHT_PATTERN)].map((m) => m[1]);
check(
  'preflight finds the same references the generator resolves',
  found.join() === 'aaaaaaaaaaaaaaaaaaaaaaaa,cccccccccccccccccccccccc',
  found.join()
);
check(
  'and would flag exactly the one that has gone',
  found.filter((id) => !labels.has(id)).join() === 'cccccccccccccccccccccccc',
  found.filter((id) => !labels.has(id)).join()
);

/* ------------------------------------------------------------------- footnotes --- */

console.log('\nFootnotes:');

/** Just enough assembler for the footnote path. */
const withFootnotes = () => {
  const stored = [];
  return {
    notes: stored,
    hasFootnotes: true,
    addFootnote(xml) {
      stored.push(xml);
      return stored.length;
    },
  };
};

const parts = withFootnotes();
const noted = htmlToOoxml('<p>Scanned<span data-footnote>nmap 7.94, default scripts.</span> it.</p>', {
  parts,
});
check('the body carries a reference, not the words', textOf(noted) === 'Scanned it.', textOf(noted));
check('and the reference is a real footnote reference', /<w:footnoteReference w:id="1"\/>/.test(noted), noted);
check('the words went to the footnote part', parts.notes.length === 1, `${parts.notes.length}`);
check(
  'the note carries its own number, so Word renumbers them',
  parts.notes[0].includes('<w:footnoteRef/>'),
  parts.notes[0].slice(0, 120)
);
check('and its text', textOf(parts.notes[0]).includes('nmap 7.94'), textOf(parts.notes[0]));
check(
  'the mark is styled as one rather than as ordinary text',
  noted.includes('<w:rStyle w:val="FootnoteReference"/>')
);

const two = withFootnotes();
htmlToOoxml('<p>a<span data-footnote>one</span>b<span data-footnote>two</span></p>', { parts: two });
check('two notes get two ids', two.notes.length === 2, `${two.notes.length}`);

const noPart = htmlToOoxml('<p>Scanned<span data-footnote>nmap 7.94.</span> it.</p>', {});
check(
  'a template with no footnote part gets a parenthetical instead',
  textOf(noPart) === 'Scanned (nmap 7.94.) it.',
  JSON.stringify(textOf(noPart))
);
check('and no dangling reference', !noPart.includes('footnoteReference'), noPart.slice(0, 160));

const empty = htmlToOoxml('<p>a<span data-footnote></span></p>', { parts: withFootnotes() });
check('an empty footnote is not written at all', !empty.includes('footnoteReference'), empty);

/* ---------------------------------------------------------------------- charts --- */

console.log('\nThe charts that are not the severity ring:');

/*
 * Handed over in the wrong order on purpose.
 *
 * Sorted input passes whether anything sorts or not, which is what the first version of this did.
 */
const ranked = rankedTableHtml([
  { label: 'Cryptography', count: 1 },
  { label: 'Injection', count: 7 },
  { label: 'Access control', count: 3 },
]);
check('it draws a table, not a picture of one', ranked.startsWith('<table>'), ranked.slice(0, 40));
check(
  'every label is real text',
  ranked.includes('<td>Injection</td>') && ranked.includes('<td>Access control</td>'),
  ranked.slice(0, 160)
);
check('and every count is', ranked.includes('<td>7</td>') && ranked.includes('<td>1</td>'));
check(
  'longest first',
  ranked.indexOf('Injection') < ranked.indexOf('Access control') &&
    ranked.indexOf('Access control') < ranked.indexOf('Cryptography'),
  ranked.slice(0, 200)
);
check('the bars are images', (ranked.match(/<img /g) ?? []).length === 3);
check(
  'and are not numbered as figures',
  (ranked.match(/data-figure="no"/g) ?? []).length === 3,
  ranked.slice(0, 200)
);

const widths = [...ranked.matchAll(/<img [^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
check('the bar lengths follow the counts', widths[0] > widths[1] && widths[1] > widths[2], JSON.stringify(widths));

/*
 * The floor, on a ratio steep enough to need it.
 *
 * One against two hundred is a bar a single pixel wide, which reads as a rendering fault rather
 * than as a small number. The earlier fixture never came close, so the floor was untested.
 */
const steep = rankedTableHtml([
  { label: 'Injection', count: 200 },
  { label: 'Cryptography', count: 1 },
]);
const steepWidths = [...steep.matchAll(/<img [^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
check(
  'a bar that would be a sliver is given a floor instead',
  steepWidths.at(-1) >= 12,
  JSON.stringify(steepWidths)
);
check(
  'and the floor does not swallow the difference',
  steepWidths[0] > steepWidths[1] * 4,
  JSON.stringify(steepWidths)
);

check('nothing to rank draws nothing', rankedTableHtml([]) === '', rankedTableHtml([]));
check('a zero row is not a row', rankedTableHtml([{ label: 'None', count: 0 }]) === '');
check(
  'a long tail is capped',
  (rankedTableHtml(
    Array.from({ length: 30 }, (_r, i) => ({ label: `Class ${i}`, count: 30 - i }))
  ).match(/<tr>/g) ?? []).length === 12
);
check(
  'a label with markup in it is escaped, not obeyed',
  !rankedTableHtml([{ label: '<b>x</b>', count: 1 }]).includes('<b>'),
  rankedTableHtml([{ label: '<b>x</b>', count: 1 }]).slice(0, 120)
);

/* And through the converter, which is where it actually has to land. */
const drawn = htmlToOoxml(ranked, {});
check(
  'the ranked chart survives conversion to a Word table',
  drawn.includes('<w:tbl>') && textOf(drawn).includes('Injection'),
  textOf(drawn).slice(0, 80)
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
