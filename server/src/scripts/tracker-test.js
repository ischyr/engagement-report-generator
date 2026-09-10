/**
 * Checks the tracker CSV export.
 *
 *   npm run test:tracker
 *
 * Against the same fixture engagement the render smoke uses, so the findings here are the ones
 * the report prints.
 *
 * Two kinds of failure are worth guarding. The obvious one is a mapping that a tracker's importer
 * refuses — a column name that is not a field, a priority outside its list — and every check below
 * on headers and vocabularies is that. The quiet one is the CSV itself: a finding's write-up
 * contains commas, quotation marks, newlines and, this being a penetration test, whatever somebody
 * pasted out of a terminal. A file that breaks on the first comma imports twenty-three tickets as
 * three, and nobody notices until the client says so.
 */
import { buildTrackerCsv, csvField, toCsv, TRACKERS } from '../services/tracker-export.service.js';

const { sampleAudit: audit, sampleReportSettings: settings } = await import(
  '../fixtures/sample-engagement.js'
);

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

const user = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'tester', role: 'admin' };

/**
 * A CSV reader that understands quoting, so the checks below read the file the way an importer
 * does rather than the way it was written. Deliberately not the writer in reverse.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[at + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      at += 1;
    } else field += character;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/* -------------------------------------------------------------------------- */
console.log('The CSV itself:');

check('a plain value is left alone', csvField('api.acme.example') === 'api.acme.example');
check('a comma forces quotes', csvField('a, b') === '"a, b"');
check('a quotation mark is doubled', csvField('say "no"') === '"say ""no"""', csvField('say "no"'));
check('a newline is quoted, not escaped', csvField('one\ntwo') === '"one\ntwo"', csvField('one\ntwo'));
check('nothing is an empty field, not the word null', csvField(null) === '' && csvField(undefined) === '');
check(
  'a value a spreadsheet would run as a formula is defused',
  csvField('=1+1') === "'=1+1" && csvField('@SUM(A1)') === "'@SUM(A1)",
  `${csvField('=1+1')} ${csvField('@SUM(A1)')}`
);
check(
  'and one that only looks like it is left readable',
  csvField('-- see appendix B') === '-- see appendix B',
  csvField('-- see appendix B')
);
check('rows are joined with CRLF', toCsv([['a'], ['b']]) === 'a\r\nb');

{
  /* The whole point of the quoting, checked by reading it back. */
  const nasty = 'Payload: {"id": 1, "q": "a,b"}\nand a second line';
  const round = parseCsv(toCsv([['Title', 'Body'], ['x', nasty]]));
  check(
    'a write-up full of commas, quotes and newlines survives a round trip',
    round.length === 2 && round[1][1] === nasty,
    JSON.stringify(round)
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nEvery tracker:');

const built = {};
for (const [key, shape] of Object.entries(TRACKERS)) {
  const result = buildTrackerCsv({ audit, settings, user, tracker: key });
  built[key] = parseCsv(result.text);
  const rows = built[key];

  check(
    `${shape.label}: one row a finding, plus the header`,
    rows.length === result.findings + 1,
    `${rows.length} rows for ${result.findings} findings`
  );
  check(
    `${shape.label}: every row has as many fields as there are columns`,
    rows.every((row) => row.length === shape.columns.length),
    JSON.stringify(rows.map((row) => row.length))
  );
  check(
    `${shape.label}: the headers are the ones it declares`,
    rows[0].join('|') === shape.columns.map((column) => column.header).join('|'),
    rows[0].join('|')
  );
  check(
    `${shape.label}: the filename says which tracker it is for`,
    result.filename.endsWith(`-${shape.suffix}.csv`) && !/[^\w.\-]/.test(result.filename),
    result.filename
  );
  check(
    `${shape.label}: no row is empty`,
    rows.slice(1).every((row) => row.some((field) => field.trim() !== ''))
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nWhat lands in the ticket:');

const jira = built.jira;
const heads = (rows) => rows[0];
const cell = (rows, header, row = 1) => rows[row][heads(rows).indexOf(header)];

check(
  'a Jira summary carries the report id, so a ticket can be traced to a paragraph',
  /^[A-Z0-9-]+: .+/.test(cell(jira, 'Summary')),
  cell(jira, 'Summary')
);
check(
  'the description states the severity and the vector',
  /^Severity: /.test(cell(jira, 'Description')) && /Vector: CVSS/.test(cell(jira, 'Description')),
  cell(jira, 'Description').slice(0, 80)
);
check(
  'and ends by naming the engagement and the finding',
  /From .+\. Finding [A-Z0-9-]+\.$/.test(cell(jira, 'Description').trim()),
  cell(jira, 'Description').trim().slice(-90)
);
check(
  'the body is text, not the markup the document renders',
  !/<\/?(p|strong|ul|li|table)\b/i.test(built.jira.map((row) => row.join(' ')).join(' ')),
  'markup reached the CSV'
);
check(
  'every issue is a Bug and carries a priority Jira knows',
  jira
    .slice(1)
    .every(
      (row) =>
        row[heads(jira).indexOf('Issue Type')] === 'Bug' &&
        ['Highest', 'High', 'Medium', 'Low', 'Lowest'].includes(row[heads(jira).indexOf('Priority')])
    ),
  JSON.stringify(jira.slice(1).map((row) => row[heads(jira).indexOf('Priority')]))
);
check(
  'labels are labels — no spaces in any of them',
  jira
    .slice(1)
    .every((row) =>
      heads(jira)
        .map((header, index) => (header === 'Labels' ? row[index] : null))
        .filter((value) => value !== null)
        .every((value) => !/\s/.test(value))
    ),
  JSON.stringify(jira.slice(1).map((row) => row.filter((_, i) => heads(jira)[i] === 'Labels')))
);
check(
  'the affected assets go in the field Jira has for them',
  heads(jira).includes('Environment')
);

const now = built.servicenow;
check(
  'a ServiceNow priority is one of its five numbers',
  now.slice(1).every((row) => ['1', '2', '3', '4', '5'].includes(cell(now, 'priority', now.indexOf(row)))),
  JSON.stringify(now.slice(1).map((row) => row[heads(now).indexOf('priority')]))
);
check(
  'and its columns are descriptive, because an import set is mapped by hand',
  heads(now).every((header) => /^[a-z][a-z0-9_]*$/.test(header)),
  heads(now).join('|')
);

const devops = built.devops;
check(
  'Azure DevOps gets Repro Steps rather than Description, which a Bug does not have',
  heads(devops).includes('Repro Steps') && !heads(devops).includes('Description'),
  heads(devops).join('|')
);
check(
  'its severity is one of the four strings the field accepts',
  devops
    .slice(1)
    .every((row) =>
      ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'].includes(
        row[heads(devops).indexOf('Severity')]
      )
    ),
  JSON.stringify(devops.slice(1).map((row) => row[heads(devops).indexOf('Severity')]))
);
check(
  'and an informational finding still says so in the body, where nothing flattens it',
  devops
    .slice(1)
    .filter((row) => row[heads(devops).indexOf('Severity')] === '4 - Low')
    .every((row) => /^Severity: (Low|None)/.test(row[heads(devops).indexOf('Repro Steps')])),
  JSON.stringify(
    devops.slice(1).map((row) => [
      row[heads(devops).indexOf('Severity')],
      row[heads(devops).indexOf('Repro Steps')].slice(0, 20),
    ])
  )
);

/* -------------------------------------------------------------------------- */
console.log('\nAnd the refusals:');

let refused = '';
try {
  buildTrackerCsv({ audit, settings, user, tracker: 'trello' });
} catch (error) {
  refused = error.message;
}
check('a tracker nobody has mapped is refused by name', /trello/.test(refused), refused);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
