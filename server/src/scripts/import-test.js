/**
 * Checks the findings import, without a database.
 *
 *   npm run test:import
 *
 * The centrepiece is a round trip: build a workbook with the same writer the export uses, read it
 * back with the new reader, and assert the cells survived. A reader tested only against files a
 * test wrote by hand is a reader that agrees with the test and not with Excel — going through
 * `buildXlsx` means the two halves of this app have to agree about shared strings, sparse rows and
 * escaping, which is where the bodies are buried.
 *
 * The rest is about rows that are *nearly* right, because that is the whole difficulty: a severity
 * word that disagrees with its vector, a duplicate of something already written up, a blank line in
 * the middle, a column nobody recognises.
 */
import { buildXlsx, STYLE } from '../services/ooxml/xlsx.js';
import { readCsv, readSheet, readXlsx, columnIndex } from '../services/ooxml/xlsx-read.js';
import { mapHeaders, planImport, readRow } from '../services/findings-import.service.js';

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

/* ------------------------------------------------------------- the reader --- */

console.log('Reading a workbook:');

check('a column reference becomes an index', columnIndex('A1') === 0 && columnIndex('C7') === 2 && columnIndex('AA3') === 26, `${columnIndex('AA3')}`);

const workbook = buildXlsx({
  sheets: [
    {
      name: 'Findings',
      rows: [
        [
          { value: 'Title', style: STYLE.header },
          { value: 'Severity', style: STYLE.header },
          { value: 'Vector', style: STYLE.header },
          { value: 'Description', style: STYLE.header },
        ],
        /* An ampersand and angle brackets, which have to survive the XML they travel in. */
        ['SQL injection in <reporting> & export', 'High', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'Parameter id is concatenated.'],
        ['Missing security headers', 'Low', '', 'No CSP.'],
      ],
    },
  ],
});

const read = readXlsx(workbook);
check('the header row comes back', read[0].join('|') === 'Title|Severity|Vector|Description', read[0].join('|'));
check(
  'and the cells, with their punctuation intact',
  read[1][0] === 'SQL injection in <reporting> & export',
  read[1][0]
);
check('an empty cell reads as empty rather than shifting the row', read[2][2] === '' && read[2][3] === 'No CSP.', JSON.stringify(read[2]));

/* --------------------------------------------------------------- the CSV ---- */

console.log('\nReading a CSV:');
const csv = readCsv(
  'Title,Severity,Description\r\n' +
    '"Injection, blind","High","A comma, a ""quote"", and\na newline"\r\n' +
    'Plain,Low,Nothing special\r\n'
);
check('a quoted comma stays inside its field', csv[1][0] === 'Injection, blind', csv[1][0]);
check('a doubled quote becomes one', csv[1][2].includes('a "quote"'), csv[1][2]);
check(
  'a newline inside quotes does not end the row',
  csv[1][2].includes('and\na newline') && csv.length === 3,
  JSON.stringify(csv[1][2])
);
check('a byte-order mark does not become part of the first header', readCsv('﻿Title,X\r\na,b')[0][0] === 'Title');

check(
  'the format is chosen by the bytes, not the name',
  readSheet(workbook, 'anything.csv')[0][0] === 'Title',
  'a workbook named .csv was read as text'
);

/* ------------------------------------------------------------- the mapping -- */

console.log('\nUnderstanding the columns:');
const mapped = mapHeaders(['Title', 'Risk', 'CVSS Vector', 'Recommendation', 'Ticket number']);
check('the export’s own headers map', mapHeaders(['Title', 'Severity', 'Vector']).mapping.cvssv3 === 2);
check('and so do the words other people use', mapped.mapping.severity === 1 && mapped.mapping.remediation === 3, JSON.stringify(mapped.mapping));
check('a column nobody knows is reported rather than dropped in silence', mapped.unknown.join() === 'Ticket number', mapped.unknown.join());
check('headers are matched whatever their case or spacing', mapHeaders(['  TITLE ', 'affected_assets']).mapping.scope === 1);

/* ----------------------------------------------------------------- the rows - */

console.log('\nJudging the rows:');
const header = ['Title', 'Severity', 'Vector', 'Description', 'References'];
const mapping = mapHeaders(header).mapping;

const good = readRow(['Stored XSS', 'High', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:N', 'It is stored.', 'https://a.example\nhttps://b.example'], mapping, 2);
check('a complete row is new', good.status === 'new' && good.finding.title === 'Stored XSS');
check('its text becomes a paragraph rather than a bare line', good.finding.description === '<p>It is stored.</p>', good.finding.description);
check('and its references become a list', good.finding.references.length === 2, JSON.stringify(good.finding.references));

const noTitle = readRow(['', 'High', '', 'Something'], mapping, 3);
check('a row with no title is invalid, and says so', noTitle.status === 'invalid' && noTitle.reasons[0] === 'No title');

const blank = readRow(['', '', '', ''], mapping, 4);
check('a blank line is a blank line, not an error', blank.status === 'blank');

const disagrees = readRow(['Weak TLS', 'Low', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', ''], mapping, 5);
check(
  'a severity that contradicts its vector is flagged, and the vector wins',
  disagrees.warnings.some((w) => /vector scores Critical/.test(w)) && disagrees.finding.severity === undefined,
  JSON.stringify(disagrees.warnings)
);

const nonsense = readRow(['Odd one', '', 'not a vector', ''], mapping, 6);
check(
  'a vector that is not one is refused rather than stored',
  nonsense.finding.cvssv3.startsWith('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N') &&
    nonsense.warnings.some((w) => /not a CVSS vector/.test(w)),
  JSON.stringify(nonsense.warnings)
);

const wordOnly = readRow(['Rated by hand', 'Medium', '', ''], mapping, 7);
check('a severity word with no vector is kept as the rating', wordOnly.finding.severity === 'Medium');
check(
  'and a row with neither says it arrives unrated',
  readRow(['Bare', '', '', ''], mapping, 8).warnings.some((w) => /unrated/.test(w))
);

/* ------------------------------------------------------------- the whole file */

console.log('\nPlanning a file:');
const existing = [{ _id: 'aaa', identifier: 'VULN-01', title: 'Stored XSS (admin search)' }];
const file = Buffer.from(
  [
    'Title,Severity,Vector,Description',
    'Stored XSS (export view),High,,Already written up under another name',
    'Missing security headers,Low,,No CSP',
    'Missing Security Headers,Low,,The same thing twice in one sheet',
    ',,,',
    ',High,,A row with no title',
  ].join('\n'),
  'utf8'
);
const plan = planImport(file, 'findings.csv', existing);

check('the blank line is not counted at all', plan.rows.length === 4, `${plan.rows.length} rows`);
check(
  'a title this engagement already has is a duplicate, and names it',
  plan.rows[0].status === 'duplicate' && plan.rows[0].duplicateOf.identifier === 'VULN-01',
  JSON.stringify(plan.rows[0].duplicateOf)
);
check(
  'the same title twice inside one sheet is caught too',
  plan.rows[2].status === 'duplicate' && plan.rows[2].duplicateOfLine === 3,
  JSON.stringify([plan.rows[2].status, plan.rows[2].duplicateOfLine])
);
check('a row with no title is invalid', plan.rows[3].status === 'invalid');
check(
  'and the counts add up',
  plan.counts.new === 1 && plan.counts.duplicate === 2 && plan.counts.invalid === 1,
  JSON.stringify(plan.counts)
);
check(
  'line numbers are the spreadsheet’s own, so a person can find the row',
  plan.rows[0].line === 2 && plan.rows[3].line === 6,
  JSON.stringify(plan.rows.map((row) => row.line))
);

let refused = null;
try {
  planImport(Buffer.from('Reference,Notes\na,b', 'utf8'), 'x.csv', []);
} catch (error) {
  refused = error;
}
check(
  'a file with no Title column is refused with an explanation',
  /No Title column/.test(refused?.message ?? ''),
  refused?.message
);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
