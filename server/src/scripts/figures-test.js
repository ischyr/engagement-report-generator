/**
 * Checks the figure surgery.
 *
 *   npm run test:figures
 *
 * Everything a report needs to know about a picture: where it is, whether it is a figure, what
 * number it gets, and whether a sentence pointing at it still has something to point at.
 *
 * The failure this guards against is the quiet one. A picture that stops being numbered, or a
 * number assigned in the wrong order, produces a document that looks entirely normal until page
 * twelve — so the checks are on whole rendered fragments rather than on the part that moved.
 */
import {
  danglingReferences,
  figuresIn,
  numberFiguresHtml,
  referencesIn,
} from '../services/figures.service.js';
import {
  captionPrefix,
  MISSING_FIGURE,
  numberFigures,
  referenceField,
} from '../services/ooxml/figure-fields.js';
import { htmlToOoxml } from '../services/ooxml/html2ooxml.js';
import { encodePng } from '../utils/png.js';
import { referenceableFigures } from '../../../client/src/lib/figures.js';

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

const IMG = (id, extra = '') =>
  `<img src="/api/media/${id}" alt="shot ${id.slice(-2)}"${extra}>`;
const FIG = (id, caption) => `<figure>${IMG(id)}<figcaption>${caption}</figcaption></figure>`;

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';

const html =
  `<p>First the request.</p>${FIG(A, 'The request')}` +
  `<p>Then the response, which is the interesting one.</p>${FIG(B, 'The response')}` +
  `<p>And a bare one nobody captioned.</p>${IMG(C)}`;

console.log('Finding the pictures:');

const found = figuresIn(html, 'poc');
check('every picture is found, in reading order', found.length === 3, `${found.length}`);
check(
  'each knows its media id',
  found.map((f) => f.media).join() === `${A},${B},${C}`,
  found.map((f) => f.media).join()
);
check('and its caption', found[0].caption === 'The request' && found[1].caption === 'The response');
check('a bare image has none, and says so', found[2].caption === '' && found[2].isFigure === false);
check('the alt text is not mistaken for a caption', found[2].alt === 'shot cc', found[2].alt);
check('the field is carried on each one', found.every((f) => f.field === 'poc'));

/*
 * The bug the editor's own comment records: reaching up to the parent for a figcaption gave three
 * screenshots the first one's caption. Asserted here as well, because this is the other reader.
 */
const nested = `<div>${FIG(A, 'One')}${FIG(B, 'Two')}</div>`;
check(
  'two figures in one block keep their own captions',
  figuresIn(nested).map((f) => f.caption).join() === 'One,Two',
  figuresIn(nested).map((f) => f.caption).join()
);

/* -------------------------------------------------------------------------- */
console.log('\nNumbering, in the order the document is read:');

/*
 * The whole point of doing this after the render rather than per finding: the number depends on
 * where a figure lands in the finished document, and a reference written before it still has to
 * come out right. The XML below deliberately puts a reference *ahead* of the figure it names.
 */
const cap = (key, id) =>
  `<w:p>${captionPrefix({ name: `_EngyFig_${key}`, id, label: 'Figure' })}<w:r><w:t>${key}</w:t></w:r></w:p>`;
const ref = (key) => `<w:p>${referenceField(`_EngyFig_${key}`)}</w:p>`;

const doc = numberFigures(
  `<w:body>${ref('bbb')}${cap('aaa', 4001)}${ref('aaa')}${cap('bbb', 4002)}${ref('zzz')}</w:body>`,
  { label: 'Figure' }
);

check('every figure is counted once', doc.count === 2, String(doc.count));
check('numbered in document order, not in the order they were written', /Figure <\/w:t><\/w:r><w:fldSimple w:instr=" SEQ Figure \\\* ARABIC "><w:r><w:t>1<\/w:t>/.test(doc.xml), 'the first caption is not figure 1');
check(
  'a reference written before its figure still resolves',
  doc.xml.indexOf('Figure 2') < doc.xml.indexOf('>1</w:t>'),
  'the forward reference did not resolve'
);
check('every reference that had a figure resolved', doc.referenced === 2, String(doc.referenced));
check('and no token survived into the document', !doc.xml.includes('@@'), 'a token leaked');

check(
  'a reference to a figure that is gone names itself rather than breaking Word',
  doc.xml.includes(MISSING_FIGURE) && doc.missing.length === 1,
  JSON.stringify(doc.missing)
);
check(
  'and the dead field is removed, not left pointing at nothing',
  !doc.xml.includes('REF _EngyFig_zzz'),
  'a REF to a missing bookmark survived'
);

/*
 * The label reaches a caption through the converter and a reference through this pass — one is
 * written while a finding is converted, the other only once the document exists. They read the
 * same setting; this is the check that both honour it.
 */
const housed = numberFigures(
  `<w:body><w:p>${captionPrefix({ name: '_EngyFig_aaa', id: 4001, label: 'Screenshot' })}</w:p>${ref('aaa')}</w:body>`,
  { label: 'Screenshot' }
);
check('a house that says Screenshot gets it on the caption', housed.xml.includes('Screenshot </w:t>'));
check('and on every reference to it', housed.xml.includes('>Screenshot 1</w:t>'), housed.xml.slice(-200));

/* The same picture printed twice is one figure: a reader has already been shown it. */
const twice = numberFigures(`<w:body>${cap('aaa', 4001)}${cap('aaa', 4002)}${ref('aaa')}</w:body>`, {});
check('a screenshot printed twice keeps one number', twice.count === 1, String(twice.count));

/* -------------------------------------------------------------------------- */
console.log('\nWhat the converter emits:');

/* A real one: the converter drops an empty buffer long before it reaches the caption. */
const PNG = encodePng(Buffer.alloc(4 * 4 * 4, 0x40), 4, 4);

const makeParts = () => ({
  bookmarks: new Map(),
  captioned: new Set(),
  nextId: 5000,
  figureBookmark(key) {
    const existing = this.bookmarks.get(key);
    if (existing) return existing;
    this.nextId += 1;
    const entry = { name: `_EngyFig_${key}`, id: this.nextId };
    this.bookmarks.set(key, entry);
    return entry;
  },
  claimFigureCaption(key) {
    if (this.captioned.has(key)) return false;
    this.captioned.add(key);
    return true;
  },
  addImage: () => ({ rId: 'rId9', docPrId: 1001, name: 'x.png' }),
});
const parts = makeParts();

const converted = htmlToOoxml(
  `<p>As shown in <span data-figref="${A}">The request</span>.</p>` +
    `<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>`,
  { parts, media: new Map([[A, { buffer: PNG, ext: 'png' }]]), availableStyles: null }
);
check(
  'a reference becomes a field pointing at the caption\u2019s bookmark',
  converted.includes(`REF _EngyFig_${A}`),
  converted.slice(0, 200)
);
check(
  'and the caption carries that same bookmark, whichever was converted first',
  converted.includes(`w:name="_EngyFig_${A}"`),
  'the bookmark names do not match'
);
check('with a SEQ field, so Word renumbers when somebody edits', converted.includes('SEQ Figure'));

const plain = htmlToOoxml(`<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>`, {
  parts: makeParts(),
  media: new Map([[A, { buffer: PNG, ext: 'png' }]]),
  figureNumbering: false,
});
check('numbering off means no field and no bookmark', !plain.includes('SEQ Figure') && !plain.includes('_EngyFig_'));

/*
 * The case that matters on a real engagement: fifty screenshots, none of them captioned.
 *
 * A picture nobody wrote a caption for is still a figure — it still needs a number, because that
 * is the only way the prose can point at it and the only way a reader can find it again. What it
 * must not get is an empty caption line with a dash on the end.
 */
const bare = htmlToOoxml(
  `<p><img src="/api/media/${A}"></p><p><img src="/api/media/${B}"></p>`,
  { parts: makeParts(), media: new Map([[A, { buffer: PNG, ext: 'png' }], [B, { buffer: PNG, ext: 'png' }]]) }
);
check(
  'a screenshot nobody captioned is still numbered',
  (bare.match(/SEQ Figure/g) ?? []).length === 2,
  String((bare.match(/SEQ Figure/g) ?? []).length)
);
check('with no dash hanging off the end of it', !bare.includes('\u2014'), 'a separator was written');

/*
 * Every picture, in every place a picture can be.
 *
 * The rule was once "a picture alone in its block", which read well for the cases it covered and
 * silently skipped a screenshot after a label, one in a list, one in a table cell. On a report
 * where fifty pictures are all evidence, a picture without a number is the bug.
 */
const CONTAINERS = [
  ['alone in a paragraph', (id) => `<p><img src="/api/media/${id}"></p>`],
  ['after a label', (id) => `<p>Screenshot: <img src="/api/media/${id}"></p>`],
  ['in a sentence', (id) => `<p>See <img src="/api/media/${id}"> here.</p>`],
  ['in a figure', (id) => `<figure><img src="/api/media/${id}"><figcaption>Cap</figcaption></figure>`],
  ['in a list item', (id) => `<ul><li>Evidence <img src="/api/media/${id}"></li></ul>`],
  ['in a table cell', (id) => `<table><tr><td><img src="/api/media/${id}"></td></tr></table>`],
  ['with no wrapper at all', (id) => `<img src="/api/media/${id}">`],
];

for (const [where, build] of CONTAINERS) {
  const rendered = htmlToOoxml(build(A), {
    parts: makeParts(),
    media: new Map([[A, { buffer: PNG, ext: 'png' }]]),
    availableStyles: new Set(['Caption']),
  });
  check(`a picture ${where} is captioned`, rendered.includes('SEQ Figure'), rendered.slice(0, 120));
}

const sentence = htmlToOoxml(`<p>See <img src="/api/media/${A}"> here.</p>`, {
  parts: makeParts(),
  media: new Map([[A, { buffer: PNG, ext: 'png' }]]),
});
check('and the sentence it was in survives intact', sentence.includes('See ') && sentence.includes(' here.'));
check(
  'with its caption after the sentence rather than inside it',
  sentence.indexOf(' here.') < sentence.indexOf('SEQ Figure'),
  'the caption interrupted the sentence'
);

const twoInOne = htmlToOoxml(
  `<p><img src="/api/media/${A}"><img src="/api/media/${B}"></p>`,
  { parts: makeParts(), media: new Map([[A, { buffer: PNG, ext: 'png' }], [B, { buffer: PNG, ext: 'png' }]]) }
);
check(
  'two pictures in one paragraph get two captions',
  (twoInOne.match(/SEQ Figure/g) ?? []).length === 2,
  String((twoInOne.match(/SEQ Figure/g) ?? []).length)
);

/*
 * A picture and its caption are one block on the page.
 *
 * Both halves of this were wrong in ways that only show on paper: the picture was left aligned
 * under a centred caption, so "Figure 12" floated off towards the middle of the page away from
 * what it named; and nothing held them together, so Word would put a screenshot at the foot of one
 * page and its caption at the head of the next.
 */
const laidOut = htmlToOoxml(`<p><img src="/api/media/${A}"></p>`, {
  parts: makeParts(),
  media: new Map([[A, { buffer: PNG, ext: 'png' }]]),
  availableStyles: new Set(['Caption']),
});
check(
  'the picture is centred, like the caption under it',
  laidOut.startsWith('<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr>'),
  laidOut.slice(0, 90)
);
check('and cannot be separated from it by a page break', laidOut.includes('<w:keepNext/>'));

const asFigure = htmlToOoxml(
  `<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>`,
  { parts: makeParts(), media: new Map([[A, { buffer: PNG, ext: 'png' }]]), availableStyles: new Set(['Caption']) }
);
check(
  'a figure block gets the same treatment as a loose screenshot',
  asFigure.startsWith('<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr>'),
  asFigure.slice(0, 90)
);

/*
 * What the caption is dressed in, which depends on whether the template has a Caption style.
 *
 * With one, the paragraph style carries everything and nothing is written directly — that is the
 * whole point of using a named style, and a house that restyles Caption expects to win. Without
 * one, the formatting is written out to match what the shipped templates say, on every run
 * including the number: otherwise "Figure 12" is black upright text beside an italic grey caption.
 */
check(
  'with a Caption style, nothing is written over it',
  asFigure.includes('<w:pStyle w:val="Caption"/>') && !asFigure.includes('<w:i/>'),
  'direct formatting was written over the style'
);
check(
  'and the number carries no formatting of its own',
  asFigure.includes('<w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>'),
  'the number was formatted directly despite the style'
);

const unstyled = htmlToOoxml(
  `<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>`,
  { parts: makeParts(), media: new Map([[A, { buffer: PNG, ext: 'png' }]]), availableStyles: new Set() }
);
check(
  'without one, the caption is italic and grey anyway',
  unstyled.includes('<w:i/><w:color w:val="6B7280"/><w:sz w:val="17"/>'),
  'a template with no Caption style got plain body text'
);
check(
  'and so is the number in front of it',
  (unstyled.match(/<w:i\/><w:color w:val="6B7280"\/>/g) ?? []).length >= 3,
  String((unstyled.match(/<w:i\/><w:color w:val="6B7280"\/>/g) ?? []).length)
);

/* An enumeration write-up is converted by the same writer, so its screenshots number alongside. */
const step = htmlToOoxml(
  `<p>Five of six answer.</p><p><img src="/api/media/${B}"></p>`,
  { parts: makeParts(), media: new Map([[B, { buffer: PNG, ext: 'png' }]]) }
);
check('an enumeration screenshot is a figure like any other', step.includes('SEQ Figure'));

/* -------------------------------------------------------------------------- */
console.log('\nThe HTML deliverable:');

const page =
  `<p>See <span data-figref="${A}">The request</span> and <span data-figref="${C}">gone</span>.</p>` +
  `<figure><img src="/api/media/${B}"><figcaption>The response</figcaption></figure>` +
  `<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>`;
const numbered = numberFiguresHtml(page, { label: 'Figure' });

check('captions are numbered in document order', numbered.html.includes('>Figure 1</span> — The response'));
check('a reference resolves to the right one', numbered.html.includes('>Figure 2</a>'));
check('and it links to the caption, because nobody prints these', numbered.html.includes(`href="#fig-${A}"`));
check('a dead reference says so here too', numbered.html.includes('(figure removed)') && numbered.missing.length === 1);

/*
 * The same two rules as the Word path, because a client who gets both must not find them
 * disagreeing about which picture is figure 3.
 */
const loose = numberFiguresHtml(
  `<p><img src="/api/media/${A}"></p>` +
    `<figure><img src="/api/media/${B}"><figcaption>The response</figcaption></figure>` +
    `<p>Inline <img src="/api/media/${C}"> here.</p>`,
  { label: 'Figure' }
);
check('a loose screenshot becomes a numbered figure', loose.html.includes('>Figure 1</span></figcaption>'));
check(
  'numbered in document order, whichever kind came first',
  loose.html.indexOf('>Figure 1<') < loose.html.indexOf('>Figure 2<'),
  'the figure block was numbered before the loose one above it'
);
check(
  'and a picture in a sentence is captioned where it stands',
  loose.html.includes('Inline <img') && loose.count === 3,
  String(loose.count)
);
check(
  'with the caption at the end of the block, as the document does it',
  loose.html.indexOf('here.') < loose.html.indexOf('engy-figure-loose'),
  'the caption interrupted the sentence'
);

/* -------------------------------------------------------------------------- */
console.log('\nReferences with nothing to point at:');

const record = {
  description: `<p>See <span data-figref="${A}">The request</span> and <span data-figref="${C}">a deleted one</span>.</p>`,
  poc:
    `<figure><img src="/api/media/${A}"><figcaption>The request</figcaption></figure>` +
    `<p><img src="/api/media/${B}"></p>`,
};

check('a live reference is found', referencesIn(record.description).length === 2);
const dangling = danglingReferences(record, ['description', 'poc']);
check('and only the dead one is reported', dangling.length === 1 && dangling[0].media === C, JSON.stringify(dangling));
check('with the reason a person can act on', dangling[0].why === 'that picture is gone', dangling[0].why);

check(
  'a reference to an uncaptioned screenshot is fine, because it is still numbered',
  danglingReferences(
    { description: `<p><span data-figref="${B}">B</span></p>`, poc: `<p><img src="/api/media/${B}"></p>` },
    ['description', 'poc']
  ).length === 0
);
check(
  'and so is one to a picture inside a sentence, now that those are numbered too',
  danglingReferences(
    { description: `<p><span data-figref="${B}">B</span></p>`, poc: `<p>See <img src="/api/media/${B}"> here.</p>` },
    ['description', 'poc']
  ).length === 0
);

/* -------------------------------------------------------------------------- */
console.log('\nAnd the picker sees the same figures the server does:');

/*
 * The client has its own copy of this scan — there is no module both halves can import — so the
 * two are held to the same input here. A drift shows up as a failing test rather than as a menu
 * that quietly stops listing something.
 */
const offered = referenceableFigures(record, ['description', 'poc']);
check(
  'it offers every picture the report will number, captioned or not',
  offered.map((f) => f.media).join() === `${A},${B}`,
  JSON.stringify(offered.map((f) => f.media))
);
check('with the caption where there is one', offered[0].label === 'The request');
check('and something recognisable where there is not', offered[1].label === '', offered[1].label);

const everywhere = {
  description: `<p>See <span data-figref="${A}">x</span>.</p>`,
  poc: `<p><img src="/api/media/${A}"></p><p>An icon <img src="/api/media/${B}"> mid-sentence.</p>`,
};
check(
  'a picture inside a sentence is offered too, because the report numbers it',
  referenceableFigures(everywhere, ['description', 'poc']).map((f) => f.media).join() === `${A},${B}`,
  JSON.stringify(referenceableFigures(everywhere, ['description', 'poc']).map((f) => f.media))
);
check(
  'agreeing with the server about which pictures are in the report',
  referenceableFigures(everywhere, ['poc']).map((f) => f.media).join() ===
    figuresIn(everywhere.poc).map((f) => f.media).join()
);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
