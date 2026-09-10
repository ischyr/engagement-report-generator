/**
 * Checks what gets turned into a table, and — mostly — what does not.
 *
 *   npm run test:table-paste
 *
 * The interesting half of this feature is the refusals. Converting a real grid is what it is for,
 * but converting a *sentence* is a mangling somebody has to undo by hand, in a finding they were
 * halfway through writing. So the false-positive cases outnumber the positive ones here, on purpose,
 * and every one of them is something an operator genuinely pastes into a write-up.
 */
const { parsePastedTable, looksLikeTable, tableHtml } = await import('../src/lib/table-paste.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

const tsv = (rows) => rows.map((row) => row.join('\t')).join('\n');

/* -------------------------------------------------------------------------- */
/* What it takes                                                              */
/* -------------------------------------------------------------------------- */
console.log('\nOut of a spreadsheet:');
{
  const table = parsePastedTable(
    tsv([
      ['Host', 'Port', 'Service'],
      ['10.0.0.5', '445', 'SMB'],
      ['10.0.0.9', '3389', 'RDP'],
    ])
  );
  check('a tab-separated grid is a table', table !== null);
  check('the first row is the header', JSON.stringify(table?.header) === '["Host","Port","Service"]');
  check('and the rest are rows', table?.rows.length === 2, JSON.stringify(table?.rows));
  check('recognised as coming from a spreadsheet', table?.kind === 'tsv');

  const html = tableHtml(table);
  check('the HTML has a head and a body', /<thead>.*<tbody>/s.test(html));
  check('with a th per heading', (html.match(/<th>/g) ?? []).length === 3, html.slice(0, 90));
  check('and a td per cell', (html.match(/<td>/g) ?? []).length === 6);
  check(
    'nothing in a cell can inject markup',
    tableHtml(parsePastedTable(tsv([['a', 'b'], ['<img src=x onerror=alert(1)>', 'y']]))).includes(
      '&lt;img'
    ),
    'a pasted cell was inserted as HTML'
  );
}

console.log('\nAnd a markdown table, as half the tools print one:');
{
  const table = parsePastedTable(
    ['| User | Cracked |', '| --- | --- |', '| svc_backup | yes |', '| jsmith | no |'].join('\n')
  );
  check('is a table', table !== null && table.kind === 'markdown');
  check('with its header read off the row above the rule', JSON.stringify(table?.header) === '["User","Cracked"]');
  check('the rule itself is not a row', table?.rows.length === 2, JSON.stringify(table?.rows));
  check(
    'and the outer pipes do not become empty cells',
    table?.rows.every((row) => row.length === 2),
    JSON.stringify(table?.rows)
  );

  const aligned = parsePastedTable(
    ['| a | b |', '|:--|--:|', '| 1 | 2 |'].join('\n')
  );
  check('an alignment rule is still a rule', aligned !== null && aligned.rows.length === 1);
}

/* -------------------------------------------------------------------------- */
/* What it leaves alone                                                       */
/* -------------------------------------------------------------------------- */
console.log('\nWhat it refuses, which is the point:');
{
  const refuses = (label, text) => check(label, !looksLikeTable(text), JSON.stringify(String(text).slice(0, 60)));

  refuses('a sentence', 'The application returns the document without checking the session.');
  refuses(
    'a paragraph with commas in it',
    'We found 1,024 hosts, most of them Windows, and three of them unpatched.\nThe rest were fine.'
  );
  refuses(
    'comma-separated values, deliberately — a sentence looks the same',
    'host,port,service\n10.0.0.5,445,SMB'
  );
  refuses(
    'space-aligned command output, which a code block already handles',
    'Group name    Domain Admins\nComment       Designated administrators\nMembers\n-------\nadministrator'
  );
  refuses('one line with a tab in it', 'Host\t10.0.0.5');
  refuses('a single column of values', 'a\nb\nc');
  refuses('an empty paste', '');
  refuses('nothing at all', null);
  refuses(
    'a ragged grid, where guessing would put words in the wrong column',
    'a\tb\tc\nd\te'
  );
  refuses(
    'a data file rather than evidence',
    tsv(Array.from({ length: 250 }, (_unused, index) => [`row${index}`, 'x']))
  );
  refuses(
    'prose that happens to contain a pipe',
    'Try `cat /etc/passwd | grep root` and see.\nIt returns the file.'
  );
  refuses(
    'a markdown-ish block with no rule row',
    '| a | b |\n| c | d |'
  );
}

/* -------------------------------------------------------------------------- */
/* The awkward shapes                                                         */
/* -------------------------------------------------------------------------- */
console.log('\nAnd the awkward ones:');
{
  const padded = parsePastedTable(`\n\n${tsv([['a', 'b'], ['1', '2']])}\n\n`);
  check(
    'blank lines around a selection are not rows',
    padded !== null && padded.rows.length === 1,
    JSON.stringify(padded)
  );

  const empties = parsePastedTable(tsv([['Host', 'Note'], ['10.0.0.5', ''], ['', 'orphaned']]));
  check(
    'an empty cell is a cell, not a ragged row',
    empties !== null && empties.rows.length === 2,
    JSON.stringify(empties?.rows)
  );
  check(
    'and comes out as an empty td rather than a missing one',
    (tableHtml(empties).match(/<td><\/td>/g) ?? []).length === 2,
    tableHtml(empties)
  );

  const noHeader = parsePastedTable(['|---|---|', '| 1 | 2 |'].join('\n'));
  check(
    'a markdown table opening with its rule has no header',
    noHeader !== null && noHeader.header.length === 0,
    JSON.stringify(noHeader)
  );
  check(
    'and renders without an empty stripe across the top',
    !tableHtml(noHeader).includes('<thead>'),
    tableHtml(noHeader)
  );
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
