/**
 * Checks the captions a report puts on its tables, and the lists it puts at the front.
 *
 *   npm run test:captions
 *
 * Figures have been numbered for a while; tables have not, and a report whose prose could point at
 * a screenshot but not at the table on the facing page was half a feature. This covers the other
 * half, and the two lists that make either number worth having — a reader told "as shown in
 * Figure 7" needs somewhere to look it up.
 *
 * The failures here are the quiet kind, again. A table numbered off the figure counter produces a
 * document where Figure 7 is the eleventh picture; a list built in writing order instead of
 * document order produces a front page that disagrees with the body. Neither breaks anything, and
 * both are wrong in a file with somebody's name on it — so the checks are on whole rendered
 * fragments and on the relationship between two of them, not on the part that moved.
 */
import {
  captionPrefix,
  listOfCaptions,
  numberFigures,
  referenceField,
  FIGURE_BOOKMARK,
  TABLE_BOOKMARK,
} from '../services/ooxml/figure-fields.js';
import { htmlToOoxml } from '../services/ooxml/html2ooxml.js';
import { tableToHtml } from '../services/enumeration-table.service.js';
import { numberFiguresHtml } from '../services/figures.service.js';

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
    .replace(/&amp;/g, '&')
    .replace(/&#8212;|&mdash;/g, '—');

/** Paragraphs, in document order, as their visible text. */
const paragraphsOf = (xml) =>
  [...String(xml).matchAll(/<w:p(?=[ >])[^>]*>(?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g)]
    .map((m) => textOf(m[0]))
    .filter(Boolean);

/**
 * A minimal stand-in for the part of `DocxAssembler` the converter uses for captions.
 *
 * Real enough to be worth testing against: it allocates the same two bookmark shapes and answers
 * `claimFigureCaption` the same way, which is what decides whether a caption carries a number.
 */
const assembler = () => {
  let bookmarkId = 4000;
  let tables = 0;
  const captioned = new Set();
  return {
    figureBookmarks: new Map(),
    figureBookmark(key) {
      bookmarkId += 1;
      return { name: `${FIGURE_BOOKMARK}${String(key).replace(/[^A-Za-z0-9_]/g, '')}`, id: bookmarkId };
    },
    claimFigureCaption(key) {
      if (captioned.has(key)) return false;
      captioned.add(key);
      return true;
    },
    tableBookmark() {
      tables += 1;
      bookmarkId += 1;
      return { name: `${TABLE_BOOKMARK}${tables}`, id: bookmarkId };
    },
    addImage: () => ({ rId: 'rId9', docPrId: 1, name: 'x.png' }),
    addHyperlink: () => 'rId8',
  };
};

const convert = (html, options = {}) =>
  htmlToOoxml(html, { parts: assembler(), captionStyle: 'Caption', ...options });

/* ------------------------------------------------------------------ table captions --- */

console.log('A table gets a caption:');

const captioned = convert('<table><caption>Hosts in scope</caption><tr><td>a</td></tr></table>');
check('the caption is drawn', textOf(captioned).includes('Hosts in scope'), textOf(captioned));
check('with the word in front of it', textOf(captioned).includes('Table'), textOf(captioned));
check(
  'and it counts on Word’s table sequence, not the figure one',
  captioned.includes('SEQ Table'),
  /SEQ \w+/.exec(captioned)?.[0]
);
check('the bookmark says it is a table', captioned.includes(TABLE_BOOKMARK));
check(
  'the caption comes before the table, where a table caption belongs',
  captioned.indexOf('Hosts in scope') < captioned.indexOf('<w:tbl>'),
  `${captioned.indexOf('Hosts in scope')} vs ${captioned.indexOf('<w:tbl>')}`
);
check(
  'and is kept with it, so a page break cannot come between',
  /<w:p><w:pPr>[^]*?<w:keepNext\/>/.test(captioned.slice(0, captioned.indexOf('<w:tbl>'))),
  captioned.slice(0, 200)
);

const bare = convert('<table><tr><td>a</td></tr></table>');
check('a table nobody named gets no number', !bare.includes('SEQ Table'), bare.slice(0, 120));
check('and no caption line', !bare.includes('<w:p><w:pPr><w:pStyle w:val="Caption"'), bare.slice(0, 160));

const off = convert('<table><caption>Hosts</caption><tr><td>a</td></tr></table>', {
  tableNumbering: false,
});
check('numbering off leaves the words alone', textOf(off).includes('Hosts'), textOf(off));
check('and takes the number away', !off.includes('SEQ Table'), off.slice(0, 160));

const renamed = convert('<table><caption>Hosts</caption><tr><td>a</td></tr></table>', {
  tableLabel: 'Tabel',
});
check('the label is the house’s word', textOf(renamed).startsWith('Tabel'), textOf(renamed));
check(
  'but the sequence is still Word’s, or no list would find it',
  renamed.includes('SEQ Table'),
  /SEQ \w+/.exec(renamed)?.[0]
);

/* The paragraph form, which is what the editor can actually write. */
const authored = convert(
  '<p data-table-caption="">Affected hosts</p><table><tr><td>a</td></tr></table>'
);
check(
  'a marked paragraph before a table is that table’s caption',
  textOf(authored).includes('Table') && textOf(authored).includes('Affected hosts'),
  textOf(authored)
);
check('and is not also printed as a paragraph', paragraphsOf(authored).length === 2, JSON.stringify(paragraphsOf(authored)));

const stranded = convert('<p data-table-caption="">Not a caption</p><p>Body.</p>');
check(
  'the same paragraph with no table after it is just a paragraph',
  textOf(stranded).includes('Not a caption') && !textOf(stranded).includes('Table'),
  textOf(stranded)
);

/*
 * The second table deliberately has no caption of its own.
 *
 * With one, it would ignore the stranded paragraph whether or not anything cleared it, and the
 * check would pass while proving nothing — which is what the first version of it did.
 */
const declined = convert(
  '<p data-table-caption="">Orphan</p><table></table><table><tr><td>a</td></tr></table>'
);
check(
  'a caption whose table turned out to be empty is not handed to the next one',
  !textOf(declined).includes('Orphan'),
  textOf(declined)
);
check('and that next table stays unnumbered', !declined.includes('SEQ Table'), textOf(declined));

const kept = convert(
  '<p data-table-caption="">Orphan</p><table></table><table><caption>Real</caption><tr><td>a</td></tr></table>'
);
check('a table with its own caption uses it', textOf(kept).includes('Real'), textOf(kept));

console.log('\nThe table a report builds for itself:');

const parsed = { columns: ['host', 'port'], rows: [['10.0.0.5', '443']], parser: 'generic' };
check(
  'the output table can carry a caption',
  tableToHtml(parsed, 'nmap — 10.0.0.5').includes('<caption>nmap — 10.0.0.5</caption>'),
  tableToHtml(parsed, 'nmap — 10.0.0.5').slice(0, 80)
);
check('and has none when it is given none', !tableToHtml(parsed).includes('<caption>'));
check(
  'a caption with markup in it is escaped, not obeyed',
  !tableToHtml(parsed, '<b>x</b>').includes('<b>'),
  tableToHtml(parsed, '<b>x</b>').slice(0, 80)
);

/* ---------------------------------------------------------------- the two counters --- */

console.log('\nFigures and tables are counted apart:');

const cap = (name, id, sequence) =>
  `<w:p>${captionPrefix({ name, id, label: sequence, sequence })}<w:r><w:t>${name}</w:t></w:r></w:p>`;

const mixed = numberFigures(
  '<w:body>' +
    cap(`${FIGURE_BOOKMARK}a`, 4001, 'Figure') +
    cap(`${TABLE_BOOKMARK}1`, 4002, 'Table') +
    cap(`${FIGURE_BOOKMARK}b`, 4003, 'Figure') +
    cap(`${TABLE_BOOKMARK}2`, 4004, 'Table') +
    '</w:body>',
  {}
);
check('two figures', mixed.count === 2, `${mixed.count}`);
check('and two tables', mixed.tables === 2, `${mixed.tables}`);
check(
  'the second figure is Figure 2, not Figure 3',
  paragraphsOf(mixed.xml)[2].startsWith('Figure 2'),
  paragraphsOf(mixed.xml)[2]
);
check(
  'and the second table is Table 2',
  paragraphsOf(mixed.xml)[3].startsWith('Table 2'),
  paragraphsOf(mixed.xml)[3]
);

const refMixed = numberFigures(
  `<w:body>${cap(`${TABLE_BOOKMARK}1`, 4001, 'Table')}<w:p>${referenceField(`${TABLE_BOOKMARK}1`)}</w:p></w:body>`,
  {}
);
check(
  'a reference to a table says Table, not Figure',
  paragraphsOf(refMixed.xml)[1] === 'Table 1',
  paragraphsOf(refMixed.xml)[1]
);
check('and it counted as a reference', refMixed.referenced === 1, `${refMixed.referenced}`);

/* ------------------------------------------------------------------- the list --- */

console.log('\nThe list at the front:');

const body =
  '<w:body>' +
  listOfCaptions('Figure') +
  cap(`${FIGURE_BOOKMARK}a`, 4001, 'Figure') +
  cap(`${FIGURE_BOOKMARK}b`, 4002, 'Figure') +
  cap(`${TABLE_BOOKMARK}1`, 4003, 'Table') +
  '</w:body>';
const listed = numberFigures(body, {});

check('every figure is listed', listed.listed === 2, `${listed.listed}`);
check(
  'the list is a real TOC field, so Word can rebuild it',
  listed.xml.includes('TOC \\h \\z \\c "Figure"'),
  /TOC[^<]*/.exec(listed.xml)?.[0]
);
check(
  'and carries a readable copy for anything that will not evaluate one',
  paragraphsOf(listed.xml)[0].startsWith('Figure 1'),
  paragraphsOf(listed.xml)[0]
);
check(
  'the numbers in the list are the numbers in the body',
  paragraphsOf(listed.xml).slice(0, 2).join('|') ===
    `${paragraphsOf(listed.xml)[2]}|${paragraphsOf(listed.xml)[3]}`,
  paragraphsOf(listed.xml).join(' / ')
);
check(
  'each entry links to its caption',
  listed.xml.includes(`<w:hyperlink w:anchor="${FIGURE_BOOKMARK}a"`),
  listed.xml.slice(listed.xml.indexOf('hyperlink'), listed.xml.indexOf('hyperlink') + 80)
);
check(
  'the table is not in the list of figures',
  !paragraphsOf(listed.xml).slice(0, 2).some((line) => line.startsWith('Table')),
  paragraphsOf(listed.xml).slice(0, 2).join(' / ')
);
check('the placeholder is gone', !listed.xml.includes('@@FIGLIST'), listed.xml.slice(0, 120));
check(
  'the field is opened once and closed once',
  (listed.xml.match(/fldCharType="begin"/g) ?? []).length === 1 &&
    (listed.xml.match(/fldCharType="end"/g) ?? []).length === 1
);

const tablesListed = numberFigures(
  `<w:body>${listOfCaptions('Table')}${cap(`${TABLE_BOOKMARK}1`, 4001, 'Table')}${cap(`${FIGURE_BOOKMARK}a`, 4002, 'Figure')}</w:body>`,
  {}
);
check(
  'a list of tables lists the tables',
  paragraphsOf(tablesListed.xml)[0].startsWith('Table 1'),
  paragraphsOf(tablesListed.xml)[0]
);
check(
  'and only the tables',
  paragraphsOf(tablesListed.xml).filter((line) => line.startsWith('Figure')).length === 1,
  paragraphsOf(tablesListed.xml).join(' / ')
);
check(
  'and asks Word for the table sequence',
  tablesListed.xml.includes('TOC \\h \\z \\c "Table"'),
  /TOC[^<]*/.exec(tablesListed.xml)?.[0]
);

const empty = numberFigures(`<w:body>${listOfCaptions('Figure')}<w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body>`, {});
check(
  'a report with no figures prints no list rather than an empty one',
  !empty.xml.includes('TOC') && !empty.xml.includes('@@FIGLIST'),
  empty.xml
);
check('and nothing else is disturbed', paragraphsOf(empty.xml).join('') === 'Body.', paragraphsOf(empty.xml).join(''));

/*
 * Document order, not writing order — the thing the whole post-render design exists for.
 *
 * The bookmarks are laid out b-then-a here, which is what a template that puts the appendix first
 * produces. A list built as the captions were written would say a, b.
 */
const reordered = numberFigures(
  '<w:body>' +
    listOfCaptions('Figure') +
    cap(`${FIGURE_BOOKMARK}b`, 4002, 'Figure') +
    cap(`${FIGURE_BOOKMARK}a`, 4001, 'Figure') +
    '</w:body>',
  {}
);
check(
  'the list follows the finished document, not the order things were built in',
  paragraphsOf(reordered.xml)[0].endsWith(`${FIGURE_BOOKMARK}b`),
  paragraphsOf(reordered.xml)[0]
);
check(
  'and so the list agrees with the body',
  paragraphsOf(reordered.xml)[0] === paragraphsOf(reordered.xml)[2],
  `${paragraphsOf(reordered.xml)[0]} vs ${paragraphsOf(reordered.xml)[2]}`
);

/* Reinstating the fault: a list that does not renumber is the failure this design prevents. */
check(
  'the check would notice a list stuck on writing order',
  paragraphsOf(reordered.xml)[0] !== paragraphsOf(reordered.xml)[3],
  'the ordering assertion is not load-bearing'
);

/* --------------------------------------------------------------- the HTML report --- */

console.log('\nThe page says the same as the document:');

const page = numberFiguresHtml(
  '<p data-table-caption="">Hosts in scope</p><table><tr><td>a</td></tr></table>' +
    '<table><caption>Open ports</caption><tr><td>b</td></tr></table>' +
    '<table><tr><td>uncaptioned</td></tr></table>',
  {}
);
check('both shapes are numbered', page.tables === 2, `${page.tables}`);
check(
  'the paragraph form gets Table 1',
  page.html.includes('>Table 1</span> — Hosts in scope'),
  page.html.slice(0, 140)
);
check(
  'the caption form gets Table 2',
  page.html.includes('>Table 2</span> — Open ports'),
  page.html.slice(page.html.indexOf('Open ports') - 80, page.html.indexOf('Open ports') + 20)
);
check('and the unnamed table gets nothing', !page.html.includes('Table 3'), page.html.slice(-90));

const pageOff = numberFiguresHtml('<table><caption>Ports</caption><tr><td>b</td></tr></table>', {
  numberTables: false,
});
check('numbering off leaves the page alone', pageOff.tables === 0 && !pageOff.html.includes('Table'), pageOff.html);

const figuresOnly = numberFiguresHtml(
  `<figure><img src="/api/media/${'a'.repeat(24)}"><figcaption>A shot</figcaption></figure>` +
    '<table><caption>Ports</caption><tr><td>b</td></tr></table>',
  { numberFigures: true, numberTables: false }
);
check(
  'the two halves switch independently — figures on, tables off',
  figuresOnly.count === 1 && figuresOnly.tables === 0,
  JSON.stringify({ figures: figuresOnly.count, tables: figuresOnly.tables })
);
const tablesOnly = numberFiguresHtml(
  `<figure><img src="/api/media/${'a'.repeat(24)}"><figcaption>A shot</figcaption></figure>` +
    '<table><caption>Ports</caption><tr><td>b</td></tr></table>',
  { numberFigures: false, numberTables: true }
);
check(
  'and the other way round',
  tablesOnly.count === 0 && tablesOnly.tables === 1,
  JSON.stringify({ figures: tablesOnly.count, tables: tablesOnly.tables })
);
check(
  'with figures off, the picture keeps the caption its author wrote',
  tablesOnly.html.includes('A shot') && !tablesOnly.html.includes('Figure 1'),
  tablesOnly.html.slice(0, 160)
);

/* ------------------------------------------------------- how wide each column is --- */

console.log('\nThe widths the author dragged:');

/** The grid, as numbers — what Word lays the columns out from. */
const gridOf = (xml) =>
  [...(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(xml)?.[1] ?? '').matchAll(
    /<w:gridCol w:w="(\d+)"\/>/g
  )].map((m) => Number(m[1]));

/** And what each cell claims for itself, which has to agree with the grid. */
const cellWidthsOf = (xml) =>
  [...xml.matchAll(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/g)].map((m) => Number(m[1]));

/* The default text column, from the converter's own fallback. */
const COLUMN = 9360;

const dragged = convert(
  '<table><tbody>' +
    '<tr><th colwidth="400">Host</th><th colwidth="100">Port</th><th colwidth="100">Service</th></tr>' +
    '<tr><td>10.0.0.5</td><td>443</td><td>https</td></tr>' +
    '</tbody></table>'
);
const grid = gridOf(dragged);

check('every column is in the grid', grid.length === 3, JSON.stringify(grid));
check(
  'the grid adds up to the text column',
  grid.reduce((a, b) => a + b, 0) === COLUMN,
  String(grid.reduce((a, b) => a + b, 0))
);
/*
 * The ratio is the thing that survives, not the pixels: 400:100:100 is four times as wide, and the
 * absolute numbers were a fact about somebody's browser window.
 */
check(
  'the first column is four times the others',
  Math.abs(grid[0] / grid[1] - 4) < 0.02 && Math.abs(grid[1] - grid[2]) <= 1,
  JSON.stringify(grid)
);
check(
  'and no column is the equal split it used to be',
  grid[0] !== Math.floor(COLUMN / 3),
  JSON.stringify(grid)
);

/* A table nobody resized must come out exactly as it always did. */
const untouched = convert('<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>');
check(
  'a table nobody sized is still an equal split',
  new Set(gridOf(untouched)).size === 1,
  JSON.stringify(gridOf(untouched))
);

/* Only some columns sized: the rest share what is left rather than collapsing to nothing. */
const partial = convert(
  '<table><tbody><tr><td colwidth="600">wide</td><td>?</td><td>?</td></tr></tbody></table>'
);
const partialGrid = gridOf(partial);
check(
  'a column nobody sized is still a column',
  partialGrid[1] > 400 && partialGrid[2] > 400,
  JSON.stringify(partialGrid)
);
/*
 * Deliberately not "the sized one is widest". With only one column sized there is no honest way
 * to know how wide the others were meant to be, so they are given the average of what *is* known
 * — which here makes all three equal. What can be asserted is that the untouched ones agree with
 * each other, because the alternative is one of them silently becoming a sliver.
 */
check(
  'and the columns nobody sized agree with each other',
  Math.abs(partialGrid[1] - partialGrid[2]) <= 1,
  JSON.stringify(partialGrid)
);

/* A spanning cell must be as wide as the columns it covers, which is only the same as "one column
 * times n" while every column is the same width — the bug this replaced. */
/*
 * Three columns, unequal, and a cell over the first two.
 *
 * Two columns would prove nothing: a cell spanning all of them is the whole table whichever way it
 * is worked out. The width has to be the sum of the columns it really covers, which on an unequal
 * grid is a different number from "one column times two".
 */
const spanning = convert(
  '<table><tbody>' +
    '<tr><td colwidth="600">a</td><td colwidth="200">b</td><td colwidth="200">c</td></tr>' +
    '<tr><td colspan="2">first two</td><td>c</td></tr>' +
    '</tbody></table>'
);
const spanGrid = gridOf(spanning);
const spanCells = cellWidthsOf(spanning);
const spanned = spanCells.at(-2);
check(
  'a spanning cell covers the columns it actually spans',
  spanned === spanGrid[0] + spanGrid[1],
  `${spanned} vs ${spanGrid[0] + spanGrid[1]}`
);
check(
  'which on an unequal grid is not one column times two',
  spanned !== Math.floor(COLUMN / 3) * 2,
  `${spanned} vs ${Math.floor(COLUMN / 3) * 2}`
);

/* Nonsense must not produce a table Word refuses to lay out. */
for (const [label, markup] of [
  ['zero widths', '<td colwidth="0">a</td><td colwidth="0">b</td>'],
  ['a negative', '<td colwidth="-50">a</td><td colwidth="100">b</td>'],
  ['not a number', '<td colwidth="wide">a</td><td colwidth="100">b</td>'],
  ['one wildly larger', '<td colwidth="1">a</td><td colwidth="9000">b</td>'],
]) {
  const odd = gridOf(convert(`<table><tbody><tr>${markup}</tr></tbody></table>`));
  check(
    `${label}: every column still has a usable width`,
    odd.length === 2 && odd.every((w) => w >= 400),
    JSON.stringify(odd)
  );
  check(
    `${label}: and the grid still adds up to the column`,
    odd.reduce((a, b) => a + b, 0) === COLUMN,
    String(odd.reduce((a, b) => a + b, 0))
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
