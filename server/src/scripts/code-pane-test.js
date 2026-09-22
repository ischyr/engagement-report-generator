/**
 * Checks the code panes: the colours, the line numbers, and the lines somebody marked.
 *
 *   npm run test:code-pane
 *
 * Three features that share one function, which is why they share one suite. Highlighting gives
 * each token a colour, the gutter counts the lines beside them, and a marked line is picked out in
 * the accent — and all three are drawn by `#codeBlock` out of the same split of the same text.
 *
 * The failures worth guarding against here are all the same kind: **a pane that looks right and
 * says something false**. Evidence quietly reflowed by a highlighter, a gutter whose numbers have
 * walked one out from the lines they count, a pane that skips from line 40 to line 187 without
 * saying so. None of those break anything; all of them put a wrong claim in a client deliverable.
 *
 * So the load-bearing check is the first one, and it is asserted over every rule and every sample
 * rather than on one example: the tokens must rejoin to exactly the text that went in.
 */
import { highlight, detectLanguage, KINDS } from '../services/ooxml/code-highlight.js';
import { htmlToOoxml, CODE_THEMES } from '../services/ooxml/html2ooxml.js';
import { compactRanges, paneRows } from '../services/report.service.js';

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

/*
 * The text of every `<w:t>` in document order — what a reader of the pane actually sees.
 *
 * The lookahead is load-bearing: `<w:t[^>]*>` also matches `<w:tbl>`, `<w:tr>`, `<w:tcW/>` and
 * `<w:tblW/>`, which made this return XML and every comparison against it fail while printing two
 * strings that looked identical.
 */
const textOf = (xml) =>
  [...xml.matchAll(/<w:t(?=[ >])[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1])
    .join('')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/** The runs, each as {colour, text}, so a check can ask what colour a given word came out. */
const runsOf = (xml) =>
  [...xml.matchAll(/<w:r>(?:(?!<w:r>)[\s\S])*?<\/w:r>/g)].map((m) => ({
    color: /<w:color w:val="([0-9A-F]{6})"\/>/.exec(m[0])?.[1] ?? null,
    bold: m[0].includes('<w:b/>'),
    text: textOf(m[0]),
  }));

const colourOf = (xml, word) => runsOf(xml).find((run) => run.text === word)?.color ?? null;

/** The two cells of a pane, gutter first. A pane without a gutter has one. */
const cellsOf = (xml) => [...xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => m[1]);

const pane = (text, attrs = '', options = {}) =>
  htmlToOoxml(
    `<pre${attrs}><code>${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</code></pre>`,
    { codeTheme: 'terminal', ...options }
  );

/* ------------------------------------------------------------------ the text survives --- */

console.log('The text is never changed:');

const SAMPLES = [
  ['http', 'HTTP/1.1 200 OK\nServer: nginx/1.18.0\nContent-Type: application/json\n\n{"ok":true}'],
  ['json', '{\n  "user": "admin",\n  "id": 42,\n  "roles": ["a", "b"],\n  "active": true\n}'],
  ['shell', '$ nmap -sV --top-ports 100 10.0.0.5\nStarting Nmap 7.94\n# id\nuid=0(root)'],
  ['sql', "SELECT * FROM users WHERE name = 'admin' -- and a comment\nORDER BY id LIMIT 10;"],
  /* The awkward ones: empty lines, tabs, trailing spaces, CR, and characters the XML cares about. */
  ['http', 'GET /a?b=1&c=<2> HTTP/1.1\n\n\tX: "y"   \n'],
  ['json', ''],
  ['shell', '   '],
  ['sql', 'no keywords here at all'],
];

for (const [language, text] of SAMPLES) {
  const rejoined = highlight(text, language)
    .map((t) => t.text)
    .join('');
  check(
    `${language}: tokens rejoin to the input (${JSON.stringify(text.slice(0, 24))}…)`,
    rejoined === text,
    JSON.stringify(rejoined.slice(0, 60))
  );
}

check(
  'an unknown language is one plain token, not an error',
  highlight('anything at all', 'cobol').every((t) => t.kind === 'plain'),
  JSON.stringify(highlight('anything at all', 'cobol'))
);

check(
  'every kind a rule can produce is one the themes colour',
  SAMPLES.every(([language, text]) =>
    highlight(text, language).every(
      (t) => KINDS.includes(t.kind) && (t.kind === 'plain' || CODE_THEMES.terminal.tokens[t.kind])
    )
  )
);

/* Reinstating the fault: a tokeniser that trims is exactly what this is here to catch. */
const trimmed = highlight('  spaced  ', 'shell')
  .map((t) => t.text.trim())
  .join('');
check(
  'the check would notice a tokeniser that trimmed',
  trimmed !== '  spaced  ',
  'the rejoin assertion is not load-bearing'
);

/* ------------------------------------------------------------------------ detection --- */

console.log('\nWorking out what it is:');

check('a request line is http', detectLanguage('POST /login HTTP/1.1\nHost: x') === 'http');
check('a status line is http', detectLanguage('HTTP/1.1 401 Unauthorized') === 'http');
check('an object is json', detectLanguage('{"a":1}') === 'json');
check('an array is json', detectLanguage('[1,2,3]') === 'json');
check('a prompt is shell', detectLanguage('$ whoami\nroot') === 'shell');
check('a query is sql', detectLanguage('SELECT 1') === 'sql');
check('the class wins over the text', detectLanguage('SELECT 1', 'language-json') === 'json');
check('bash means shell', detectLanguage('anything', 'language-bash') === 'shell');
check(
  'nmap output is nothing in particular, and says so',
  detectLanguage('Starting Nmap 7.94 ( https://nmap.org )\nNmap scan report for 10.0.0.5') === ''
);
check('an unknown class is not a guess', detectLanguage('Starting Nmap', 'language-klingon') === '');
check('empty is nothing', detectLanguage('') === '' && detectLanguage(null) === '');

/* ------------------------------------------------------------------------- colours --- */

console.log('\nColouring:');

const theme = CODE_THEMES.terminal;
const http = pane('HTTP/1.1 200 OK\nServer: nginx\nX-Powered-By: PHP/8.1');

check('the status code takes the accent', colourOf(http, '200') === theme.tokens.accent, colourOf(http, '200'));
check('the protocol is a keyword', colourOf(http, 'HTTP/1.1') === theme.tokens.keyword, colourOf(http, 'HTTP/1.1'));
check('a header name is a key', colourOf(http, 'Server') === theme.tokens.key, colourOf(http, 'Server'));
check(
  'a hyphenated header name is one run, not three',
  colourOf(http, 'X-Powered-By') === theme.tokens.key,
  JSON.stringify(runsOf(http).map((r) => r.text))
);
check(
  'the version is not mistaken for the status',
  !runsOf(http).some((run) => run.text === '.1' && run.color === theme.tokens.keyword),
  'the capture-group bug is back'
);

const json = pane('{\n  "user": "admin",\n  "id": 42,\n  "ok": true\n}');
check('a json key is a key', colourOf(json, '"user"') === theme.tokens.key, colourOf(json, '"user"'));
check('a json value is a string', colourOf(json, '"admin"') === theme.tokens.string, colourOf(json, '"admin"'));
check('a number is a number', colourOf(json, '42') === theme.tokens.number, colourOf(json, '42'));
check('true is a keyword', colourOf(json, 'true') === theme.tokens.keyword, colourOf(json, 'true'));
check(
  'the colon after a key is not part of it',
  runsOf(json).every((run) => !/^"[^"]*"\s*:$/.test(run.text)),
  JSON.stringify(runsOf(json).map((r) => r.text))
);

const shell = pane('$ nmap -sV --top-ports 100 10.0.0.5');
check('the prompt is punctuation', colourOf(shell, '$') === theme.tokens.punct, colourOf(shell, '$'));
check('a long flag is a keyword', colourOf(shell, '--top-ports') === theme.tokens.keyword, colourOf(shell, '--top-ports'));
check('a short flag is a keyword', colourOf(shell, '-sV') === theme.tokens.keyword, colourOf(shell, '-sV'));

const light = pane('HTTP/1.1 500 Internal Server Error', '', { codeTheme: 'light' });
check(
  'the light theme has its own palette, not the dark one',
  colourOf(light, '500') === CODE_THEMES.light.tokens.accent &&
    CODE_THEMES.light.tokens.accent !== theme.tokens.accent,
  colourOf(light, '500')
);

const dull = pane('HTTP/1.1 200 OK\nServer: nginx', '', { codeHighlight: false });
check(
  'highlighting off is one colour again',
  runsOf(dull)
    .filter((run) => run.text.trim())
    .every((run) => run.color === theme.text),
  JSON.stringify(runsOf(dull).map((r) => r.color))
);
check('and the text is still all there', textOf(dull) === 'HTTP/1.1 200 OKServer: nginx');

const unknown = pane('Starting Nmap 7.94\nNmap scan report for 10.0.0.5');
check(
  'output nothing recognises stays one colour',
  runsOf(unknown)
    .filter((run) => run.text.trim())
    .every((run) => run.color === theme.text)
);

const markup = pane('').replace('<code></code>', '<code>plain <b>bold</b></code>');
check(
  'a hand-written <pre> with markup in it still renders',
  htmlToOoxml('<pre><code>a <b>b</b> c</code></pre>', { codeTheme: 'terminal' }).includes('<w:tbl>') &&
    textOf(htmlToOoxml('<pre><code>a <b>b</b> c</code></pre>', { codeTheme: 'terminal' })) === 'a b c',
  markup.slice(0, 40)
);

/* --------------------------------------------------------------------- the gutter --- */

console.log('\nCounting the lines:');

const plain = pane('one\ntwo\nthree');
check('no gutter unless asked', cellsOf(plain).length === 1, `${cellsOf(plain).length} cells`);

const numbered = pane('one\ntwo\nthree', '', { codeLineNumbers: true });
check('asked for, a gutter appears', cellsOf(numbered).length === 2, `${cellsOf(numbered).length} cells`);
check('and it counts from one', textOf(cellsOf(numbered)[0]) === '123', textOf(cellsOf(numbered)[0]));
check('the code is in the other cell', textOf(cellsOf(numbered)[1]) === 'onetwothree');
check(
  'the gutter is dimmer than the code',
  runsOf(cellsOf(numbered)[0])[0].color === theme.gutter && theme.gutter !== theme.text
);
check(
  'one break per line in each cell, so the rows line up',
  (cellsOf(numbered)[0].match(/<w:br\/>/g) ?? []).length ===
    (cellsOf(numbered)[1].match(/<w:br\/>/g) ?? []).length,
  `${(cellsOf(numbered)[0].match(/<w:br\/>/g) ?? []).length} vs ${(cellsOf(numbered)[1].match(/<w:br\/>/g) ?? []).length}`
);
check(
  'the gutter is right-aligned, or the numbers do not stack',
  cellsOf(numbered)[0].includes('<w:jc w:val="right"/>')
);

const blanks = pane('a\n\nb', '', { codeLineNumbers: true });
check('a blank line is still a line', textOf(cellsOf(blanks)[0]) === '123', textOf(cellsOf(blanks)[0]));
check(
  'and the blank line is still blank',
  (cellsOf(blanks)[1].match(/<w:br\/>/g) ?? []).length === 2,
  `${(cellsOf(blanks)[1].match(/<w:br\/>/g) ?? []).length} breaks`
);

const trailing = pane('a\nb\n', '', { codeLineNumbers: true });
check(
  'a trailing newline does not become a numbered empty row',
  textOf(cellsOf(trailing)[0]) === '12',
  textOf(cellsOf(trailing)[0])
);

const wide = pane('a\nb', ' data-line-numbers="1,4000"', { codeLineNumbers: true });
const narrow = pane('a\nb', '', { codeLineNumbers: true });
const widthOf = (xml) => Number(/<w:gridCol w:w="(\d+)"\/>/.exec(xml)[1]);
check(
  'the gutter is sized for the largest number, not the row count',
  widthOf(wide) > widthOf(narrow),
  `${widthOf(wide)} vs ${widthOf(narrow)}`
);
check(
  'and the two columns still add up to the pane',
  [...wide.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].reduce((sum, m) => sum + Number(m[1]), 0) ===
    Number(/<w:tblW w:w="(\d+)"/.exec(wide)[1]),
  wide.slice(0, 200)
);

/* ------------------------------------------------------------------ real line numbers --- */

console.log('\nSaying which lines these are:');

const skipped = pane('a\nb\n… 183 lines not printed\nz', ' data-line-numbers="1-2,0,187"');
check(
  'a pane that skips numbers itself even though nobody asked it to',
  cellsOf(skipped).length === 2,
  `${cellsOf(skipped).length} cells`
);
check(
  'and the numbers are the real ones',
  textOf(cellsOf(skipped)[0]) === '12…187',
  textOf(cellsOf(skipped)[0])
);
check(
  'the notice gets an ellipsis rather than a number of its own',
  !textOf(cellsOf(skipped)[0]).includes('3'),
  textOf(cellsOf(skipped)[0])
);

const contiguous = pane('a\nb\nc', ' data-line-numbers="1-3"');
check(
  'a pane that does not skip is left alone',
  cellsOf(contiguous).length === 1,
  `${cellsOf(contiguous).length} cells`
);

/*
 * A map that does not describe this pane is thrown away whole.
 *
 * Checked with the gutter on, and deliberately: with it off the pane has no numbers to be wrong
 * about, so a suite that only looked at the cell count would pass whether the map was rejected or
 * applied — which is what the first version of these three did.
 */
const short = pane('a\nb\nc', ' data-line-numbers="1-2"', { codeLineNumbers: true });
check(
  'a map naming fewer lines than the pane has is ignored, not applied',
  textOf(cellsOf(short)[0]) === '123',
  textOf(cellsOf(short)[0])
);
const long = pane('a\nb', ' data-line-numbers="10-20"', { codeLineNumbers: true });
check(
  'and so is one naming more',
  textOf(cellsOf(long)[0]) === '12',
  textOf(cellsOf(long)[0])
);
const rubbish = pane('a\nb', ' data-line-numbers="one,two"', { codeLineNumbers: true });
check('and so is rubbish', textOf(cellsOf(rubbish)[0]) === '12', textOf(cellsOf(rubbish)[0]));
const backwards = pane('a\nb', ' data-line-numbers="9-2"', { codeLineNumbers: true });
check('and so is a range that runs backwards', textOf(cellsOf(backwards)[0]) === '12', textOf(cellsOf(backwards)[0]));

/* ---------------------------------------------------------------- the marked lines --- */

console.log('\nThe lines somebody marked:');

const marked = pane('a\nb\nc', ' data-mark-lines="2"');
check(
  'the marked line takes the accent',
  runsOf(marked).find((run) => run.text === 'b')?.color === theme.accent,
  JSON.stringify(runsOf(marked).map((r) => [r.text, r.color]))
);
check(
  'and only it',
  runsOf(marked).find((run) => run.text === 'a')?.color === theme.text,
  runsOf(marked).find((run) => run.text === 'a')?.color
);
check('it is bold as well as coloured', runsOf(marked).find((run) => run.text === 'b')?.bold === true);

const markedFar = pane('a\n… 183 lines not printed\nSECRET', ' data-line-numbers="1,0,187" data-mark-lines="187"');
check(
  'a marked line carried past the cut is marked where it lands',
  runsOf(markedFar).find((run) => run.text === 'SECRET')?.color === theme.accent,
  JSON.stringify(runsOf(markedFar).map((r) => [r.text, r.color]))
);
check(
  'and its number in the gutter says 187, not 3',
  textOf(cellsOf(markedFar)[0]) === '1…187',
  textOf(cellsOf(markedFar)[0])
);
check(
  'the marked number is picked out in the gutter too',
  runsOf(cellsOf(markedFar)[0]).find((run) => run.text === '187')?.color === theme.accent
);

const markedHttp = pane('HTTP/1.1 200 OK\nSet-Cookie: session=1', ' data-mark-lines="2"');
check(
  'a marked line is one colour, not half accent and half syntax',
  runsOf(markedHttp).filter((run) => run.text.includes('Set-Cookie')).every((run) => run.color === theme.accent),
  JSON.stringify(runsOf(markedHttp).map((r) => [r.text, r.color]))
);
check(
  'and the unmarked lines are still highlighted',
  colourOf(markedHttp, '200') === theme.tokens.accent
);

/* Reinstating the fault: without the accent the pane cannot say which line was marked. */
const unmarked = pane('a\nb\nc');
check(
  'the check would notice the accent going away',
  runsOf(unmarked).every((run) => run.color !== theme.accent),
  'the accent assertion is not load-bearing'
);

/* ------------------------------------------------------------------- the range list --- */

console.log('\nWriting the line map:');

check('a run becomes a range', compactRanges([1, 2, 3, 4]) === '1-4', compactRanges([1, 2, 3, 4]));
check('a single stays single', compactRanges([7]) === '7', compactRanges([7]));
check(
  'a gap starts a new range',
  compactRanges([1, 2, 3, 0, 187, 0, 203, 204]) === '1-3,0,187,0,203-204',
  compactRanges([1, 2, 3, 0, 187, 0, 203, 204])
);
check('two notices stay two', compactRanges([0, 0]) === '0,0', compactRanges([0, 0]));
check('nothing is nothing', compactRanges([]) === '', JSON.stringify(compactRanges([])));
check(
  'a jump with no notice is still two ranges',
  compactRanges([1, 2, 9]) === '1-2,9',
  compactRanges([1, 2, 9])
);

/* And the round trip, which is the only thing that matters about the encoding. */
const cases = [
  [1, 2, 3],
  [1, 0, 187],
  [5],
  [1, 2, 0, 40, 41, 0, 400],
];
for (const numbers of cases) {
  const rendered = pane(numbers.map((_n, i) => `line ${i}`).join('\n'), ` data-line-numbers="${compactRanges(numbers)}"`, {
    codeLineNumbers: true,
  });
  const shown = textOf(cellsOf(rendered)[0]);
  const expected = numbers.map((n) => (n === 0 ? '…' : String(n))).join('');
  check(`round trip ${compactRanges(numbers)}`, shown === expected, `${shown} vs ${expected}`);
}

/* --------------------------------------------------------------- the print policy --- */

console.log('\nWhat the document gets:');

const four_hundred = Array.from({ length: 400 }, (_line, i) => `line ${i + 1}`);

const whole = paneRows(four_hundred, { mode: 'all' });
check('all means all', whole.rows.length === 400 && whole.omitted === 0, `${whole.rows.length}`);
check('and nothing is invented', whole.rows.every((row) => row.n > 0));

const none = paneRows(four_hundred, { mode: 'none' });
check('none means none', none.rows.length === 0 && none.omitted === 0);
check('table means none in the pane', paneRows(four_hundred, { mode: 'table' }).rows.length === 0);

const head = paneRows(four_hundred, { mode: 'head', keep: 40 });
check('head keeps forty and says so', head.rows.length === 41, `${head.rows.length} rows`);
check('the last row is the notice', head.rows.at(-1).n === 0, JSON.stringify(head.rows.at(-1)));
check(
  'and the notice counts what it cut',
  head.rows.at(-1).text === '… 360 more lines not printed',
  head.rows.at(-1).text
);
check('the count agrees', head.omitted === 360, `${head.omitted}`);

/* The point of the whole exercise. */
const carried = paneRows(four_hundred, { mode: 'head', keep: 40, marked: [187, 203] });
check(
  'a marked line past the cut is carried in anyway',
  carried.rows.some((row) => row.n === 187) && carried.rows.some((row) => row.n === 203),
  JSON.stringify(carried.rows.filter((r) => r.n > 40).map((r) => r.n))
);
check(
  'the gap before it is spelled out, not closed over',
  carried.rows.find((row) => row.n === 187 && true) &&
    carried.rows[carried.rows.indexOf(carried.rows.find((row) => row.n === 187)) - 1].text ===
      '… 146 lines not printed',
  carried.rows[carried.rows.indexOf(carried.rows.find((row) => row.n === 187)) - 1]?.text
);
check(
  'the rows stay in order',
  carried.rows.filter((row) => row.n > 0).every((row, i, all) => i === 0 || row.n > all[i - 1].n)
);
check(
  'and the trailing count is right after the last one carried',
  carried.rows.at(-1).text === '… 197 more lines not printed',
  carried.rows.at(-1).text
);
check('the omitted count excludes what was carried', carried.omitted === 358, `${carried.omitted}`);

check(
  'a marked line inside the head needs no notice',
  paneRows(four_hundred, { mode: 'head', keep: 40, marked: [7] }).rows.filter((row) => row.n === 0)
    .length === 1
);
check(
  'a marked line past the end of the output is ignored',
  paneRows(four_hundred, { mode: 'head', keep: 40, marked: [9999] }).rows.length === 41
);
check(
  'adjacent marked lines share one notice',
  paneRows(four_hundred, { mode: 'head', keep: 40, marked: [187, 188] }).rows.filter(
    (row) => row.n === 0
  ).length === 2,
  JSON.stringify(
    paneRows(four_hundred, { mode: 'head', keep: 40, marked: [187, 188] })
      .rows.filter((row) => row.n === 0)
      .map((r) => r.text)
  )
);
check(
  'a marked last line means no trailing notice',
  paneRows(four_hundred, { mode: 'head', keep: 40, marked: [400] }).rows.at(-1).n === 400
);
check('nothing in, nothing out', paneRows([], { mode: 'head', keep: 40 }).rows.length === 0);
check(
  'a pane shorter than the cap is not truncated',
  paneRows(['a', 'b'], { mode: 'head', keep: 40 }).rows.length === 2
);

/* End to end: the policy's rows, through the encoding, into a pane. */
const endToEnd = pane(
  carried.rows.map((row) => row.text).join('\n'),
  ` data-line-numbers="${compactRanges(carried.rows.map((row) => row.n))}" data-mark-lines="187,203"`
);
check(
  'the finished pane numbers the carried lines correctly',
  textOf(cellsOf(endToEnd)[0]).endsWith('…187…203…'),
  textOf(cellsOf(endToEnd)[0]).slice(-30)
);
check(
  'and picks them both out',
  runsOf(endToEnd).filter((run) => run.text === 'line 187' || run.text === 'line 203').length === 2 &&
    runsOf(endToEnd)
      .filter((run) => run.text === 'line 187' || run.text === 'line 203')
      .every((run) => run.color === theme.accent)
);

/* -------------------------------------------------------------- the template theme --- */

console.log('\nThe template theme still defers:');

const templated = htmlToOoxml('<pre><code>HTTP/1.1 200 OK</code></pre>', {
  codeTheme: 'template',
  availableStyles: new Set(['CodeBlock']),
  codeHighlight: true,
  codeLineNumbers: true,
});
check('no table, so the paragraph style decides', !templated.includes('<w:tbl>'), templated.slice(0, 120));
check('no colours of ours on it', !templated.includes('<w:color'), templated.slice(0, 200));
check('and it names the style', templated.includes('CodeBlock'));

/* ------------------------------------------------------------ lines too longPane --- */

console.log('\nA line wider than the column:');

/**
 * A cell's display rows — what the reader sees as separate lines.
 *
 * The rows of a pane are runs joined by `<w:r><w:br/></w:r>`, in both cells. Everything in this
 * section rests on the two cells having the same number of them, because that is the only thing
 * holding a number beside the line it counts.
 */
const rowsOf = (cellXml) => cellXml.split('<w:r><w:br/></w:r>').map(textOf);

const LONG = 'x'.repeat(400);
const longPane = pane(`short\n${LONG}\nafter`, '', { codeLineNumbers: true });
const [longGutter, longCode] = cellsOf(longPane).map(rowsOf);

/* Derived rather than hard-coded: the first row of a 400-character line is exactly the column. */
const COLUMNS = Math.max(...longCode.map((row) => row.length));

check('a long line occupies more than one row', longCode.length > 3, `${longCode.length} rows`);
check(
  'the gutter has exactly as many rows as the code',
  longGutter.length === longCode.length,
  `gutter ${longGutter.length}, code ${longCode.length}`
);
check('no row is wider than the column', longCode.every((row) => row.length <= COLUMNS));
check(
  'the numbers sit beside the lines they count',
  longGutter.filter(Boolean).join(',') === '1,2,3',
  longGutter.join('|')
);
check(
  'and the continuations are blank, not numbered',
  longGutter[0] === '1' && longGutter[1] === '2' && longGutter[2] === '' && longGutter.at(-1) === '3',
  longGutter.join('|')
);
check(
  'not one character of the line is lost',
  longCode.join('') === `short${LONG}after`,
  `${longCode.join('').length} characters`
);

/*
 * The failure this replaced, stated as the thing that must not come back: with the code wrapped by
 * Word and the gutter not, the line numbered 3 was three rows above the line it named.
 */
check(
  'the last row of the pane is the last line of the input',
  longCode.at(-1) === 'after' && longGutter.at(-1) === '3'
);

/* A line that exactly fills the column must not gain an empty continuation row. */
const exact = pane('a'.repeat(COLUMNS), '', { codeLineNumbers: true });
check(
  'a line exactly the width of the column stays one row',
  rowsOf(cellsOf(exact)[1]).length === 1,
  JSON.stringify(rowsOf(cellsOf(exact)[1]))
);
const oneOver = pane('a'.repeat(COLUMNS + 1), '', { codeLineNumbers: true });
check('one character more is two rows', rowsOf(cellsOf(oneOver)[1]).length === 2);

/* An empty line is a line: it keeps its number, which is what tells it apart from a continuation. */
const blankLines = pane('one\n\nthree', '', { codeLineNumbers: true });
check(
  'an empty line still carries its own number',
  rowsOf(cellsOf(blankLines)[0]).join('|') === '1|2|3',
  rowsOf(cellsOf(blankLines)[0]).join('|')
);

/* ------------------------------------------------------------------ and the rest --- */

console.log('\nWhat wrapping must not disturb:');

/*
 * The highlighter sees whole lines, never the pieces.
 *
 * Several of its rules are anchored to the start of a line. Colouring each wrapped chunk on its own
 * would read the `POST` inside this URL as a request method and paint it like one — a pane that
 * claims a second request was made.
 */
/* `POST` exactly at the wrap, which is the only place a start-of-line rule could wrongly fire.
 * The first line is a real request so the pane is detected as HTTP at all. */
const anchored = pane(
  `GET / HTTP/1.1\n${'x'.repeat(COLUMNS)}POST /admin HTTP/1.1`,
  '',
  { codeHighlight: true, codeLineNumbers: true }
);
check(
  'a wrapped line is coloured as one line, not as its pieces',
  colourOf(anchored, 'POST') === null,
  JSON.stringify(runsOf(anchored).filter((r) => r.text.includes('POST')).map((r) => [r.text.slice(0, 12), r.color]))
);

/* A marked line that wraps is marked all the way down, or half of it reads as ordinary output. */
const markedWide = pane(`first\n${LONG}`, ' data-mark-lines="2"', { codeLineNumbers: true });
const markedRuns = runsOf(cellsOf(markedWide)[1]);
check(
  'every row of a marked line is accented',
  markedRuns.filter((run) => run.text.startsWith('x')).every((run) => run.bold),
  JSON.stringify(markedRuns.map((r) => [r.text.slice(0, 6), r.bold]))
);

/* A tab cannot be measured, and in a fixed table cell it lands on tab stops nobody chose. */
const tabbed = pane('ab\tcd\n\tx', '', { codeLineNumbers: true });
check(
  'tabs become the spaces a terminal would have shown',
  rowsOf(cellsOf(tabbed)[1]).join('|') === `ab${' '.repeat(6)}cd|${' '.repeat(8)}x`,
  JSON.stringify(rowsOf(cellsOf(tabbed)[1]))
);

/* A pane with no gutter has the whole width, so it wraps later than a numbered one. */
const bare = pane(LONG, '', { codeLineNumbers: false });
check('a pane without a gutter has one cell', cellsOf(bare).length === 1);
check(
  'and fits more on a row than a numbered pane does',
  Math.max(...rowsOf(cellsOf(bare)[0]).map((row) => row.length)) > COLUMNS
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
