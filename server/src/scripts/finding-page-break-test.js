/**
 * One finding, one page.
 *
 *   npm run test:page-break
 *
 * The setting is a checkbox; the work is surgery on somebody's template, done before docxtemplater
 * unrolls the loop and while the findings loop is still one paragraph rather than forty. Two things
 * can go wrong quietly, and both are checked here more than once:
 *
 *   - **the wrong loop.** Nearly every template has two `{{#findings}}` loops, and the other one is
 *     a row in the summary table. Breaking the page there gives a forty-page table.
 *   - **the wrong place in `<w:pPr>`.** Word validates paragraph properties against an ordered
 *     sequence and refuses to open a document whose children are shuffled — so an insertion that
 *     looks right in a diff produces a file the client cannot open at all.
 *
 * So half of what is below is what the pass must *not* touch.
 */
import { startFindingsOnNewPage, withPageBreakBefore } from '../services/ooxml/finding-page-break.js';

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

/** A paragraph, the way Word writes one. */
const para = (text, props = '') =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

const heading = (text) => para(text, '<w:pStyle w:val="Heading2"/>');

const body = (...parts) => `<w:document><w:body>${parts.join('')}</w:body></w:document>`;

/** Where `<w:pageBreakBefore/>` ended up, by the paragraph that carries it. */
const breakingParagraphs = (xml) =>
  [...xml.matchAll(/<w:p\b(?![a-zA-Z])[^>]*>[\s\S]*?<\/w:p>/g)]
    .filter((m) => m[0].includes('<w:pageBreakBefore/>'))
    .map((m) => (/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/.exec(m[0])?.[1] ?? '(empty)'));

/* --------------------------------------------------------------- the usual shape --- */

console.log('The shape every template has:');

const usual = body(
  heading('Findings'),
  para('{{#findings}}'),
  heading('{{ .id }} — {{ .title }}'),
  para('{{ .description }}'),
  para('{{/findings}}'),
  heading('Appendix')
);

const done = startFindingsOnNewPage(usual);

check('it applies', done.applied, done.reason);
check(
  'the break lands on the finding heading, not on the loop marker',
  breakingParagraphs(done.xml).join('|') === '{{ .id }} — {{ .title }}',
  breakingParagraphs(done.xml).join('|')
);
check('exactly one paragraph is changed', breakingParagraphs(done.xml).length === 1);
check(
  'nothing else in the document moves',
  done.xml.replace('<w:pageBreakBefore/>', '') === usual,
  'the part differs by more than the insertion'
);

/* A marker paragraph that is dropped by `paragraphLoop` must not be the one marked: the break
 * would vanish with it and the setting would do nothing at all. */
check(
  'the loop marker paragraph is left alone',
  !/<w:p>[^]*?\{\{#findings\}\}[^]*?<\/w:p>/.exec(done.xml)?.[0].includes('pageBreakBefore')
);

/* --------------------------------------------------------- the summary table trap --- */

console.log('\nThe other findings loop:');

const withSummary = body(
  heading('Summary'),
  `<w:tbl><w:tr><w:tc>${para('{{#findings}}{{ .id }}')}</w:tc><w:tc>${para(
    '{{ .severity }}{{/findings}}'
  )}</w:tc></w:tr></w:tbl>`,
  heading('Findings'),
  para('{{#findings}}'),
  heading('{{ .id }} — {{ .title }}'),
  para('{{ .description }}'),
  para('{{/findings}}')
);

const avoided = startFindingsOnNewPage(withSummary);
check('it applies', avoided.applied, avoided.reason);
check(
  'the summary row is not broken onto its own page',
  breakingParagraphs(avoided.xml).join('|') === '{{ .id }} — {{ .title }}',
  breakingParagraphs(avoided.xml).join('|')
);
check(
  'no table cell is touched',
  !(/<w:tbl>[\s\S]*?<\/w:tbl>/.exec(avoided.xml)?.[0] ?? '').includes('pageBreakBefore')
);

/* A loop opened and closed in one paragraph is a sentence listing ids, not a chapter — and with
 * no table around it, only the same-paragraph rule keeps it from winning. */
const inline = body(
  para('Affected: {{#findings}}{{ .id }} {{/findings}}'),
  para('{{#findings}}'),
  heading('{{ .title }}'),
  para('{{/findings}}')
);
check(
  'a loop that opens and closes in one paragraph is not the write-up loop',
  breakingParagraphs(startFindingsOnNewPage(inline).xml).join('|') === '{{ .title }}',
  breakingParagraphs(startFindingsOnNewPage(inline).xml).join('|')
);

/* "Findings at a glance" — a real thing templates do, and the only case where the pick between
 * two loops is decided by nothing except which of them is the chapter. */
const glance = body(
  heading('At a glance'),
  para('{{#findings}}'),
  para('• {{ .id }}'),
  para('{{/findings}}'),
  heading('Findings'),
  para('{{#findings}}'),
  heading('{{ .id }} — {{ .title }}'),
  para('{{ .description }}'),
  para('{{ .remediation }}'),
  para('{{/findings}}')
);
check(
  'the write-ups win over a short list of the same findings',
  breakingParagraphs(startFindingsOnNewPage(glance).xml).join('|') === '{{ .id }} — {{ .title }}' &&
    (startFindingsOnNewPage(glance).xml.match(/pageBreakBefore/g) ?? []).length === 1,
  breakingParagraphs(startFindingsOnNewPage(glance).xml).join('|')
);

/* ------------------------------------------------------------------ Word's habits --- */

console.log('\nWhat Word does to a template that was saved once:');

/* The grammar checker splits a tag across runs whenever it sees a sentence boundary inside one.
 * A literal search for `{{#findings}}` finds nothing here, and the setting silently does nothing. */
const split = body(
  `<w:p><w:r><w:t>{{#find</w:t></w:r><w:r><w:t>ings}}</w:t></w:r></w:p>`,
  heading('{{ .title }}'),
  para('{{/findings}}')
);
check(
  'a tag split across runs is still found',
  breakingParagraphs(startFindingsOnNewPage(split).xml).join('|') === '{{ .title }}'
);

check(
  'spaces inside the marker do not hide it',
  startFindingsOnNewPage(
    body(para('{{ # findings }}'), heading('{{ .title }}'), para('{{ / findings }}'))
  ).applied
);

/* A marker sharing its paragraph with real text is not dropped, so that paragraph is the repeat. */
const shared = body(para('{{#findings}}{{ .id }} — {{ .title }}'), para('{{/findings}}'));
check(
  'a marker sharing a paragraph marks that paragraph',
  breakingParagraphs(startFindingsOnNewPage(shared).xml).join('|') === '{{#findings}}{{ .id }} — {{ .title }}',
  breakingParagraphs(startFindingsOnNewPage(shared).xml).join('|')
);

/* ------------------------------------------------------------- the order in pPr --- */

console.log('\nWhere it goes inside the paragraph properties:');

/* Word's own sequence, as far as it matters here. Out of order, the document does not open. */
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'spacing', 'ind', 'jc'];
const orderOf = (paragraph) => {
  const props = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paragraph)?.[1] ?? '';
  const seen = [...props.matchAll(/<w:(\w+)/g)].map((m) => m[1]).filter((n) => PPR_ORDER.includes(n));
  return seen.every((name, i) => i === 0 || PPR_ORDER.indexOf(seen[i - 1]) < PPR_ORDER.indexOf(name));
};

check(
  'after pStyle',
  orderOf(withPageBreakBefore(para('x', '<w:pStyle w:val="Heading2"/>'))),
  withPageBreakBefore(para('x', '<w:pStyle w:val="Heading2"/>'))
);
check(
  'after keepNext, before spacing',
  orderOf(
    withPageBreakBefore(
      para('x', '<w:pStyle w:val="Heading2"/><w:keepNext/><w:spacing w:before="240"/><w:jc w:val="left"/>')
    )
  ),
  withPageBreakBefore(
    para('x', '<w:pStyle w:val="Heading2"/><w:keepNext/><w:spacing w:before="240"/><w:jc w:val="left"/>')
  )
);
check(
  'before everything when there is nothing it must follow',
  withPageBreakBefore(para('x', '<w:spacing w:before="240"/>')).includes(
    '<w:pPr><w:pageBreakBefore/><w:spacing'
  )
);
check(
  'properties are created for a paragraph that has none',
  withPageBreakBefore(para('x')) === '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>',
  withPageBreakBefore(para('x'))
);
check(
  'a self-closing <w:pPr/> is opened up',
  withPageBreakBefore('<w:p><w:pPr/><w:r><w:t>x</w:t></w:r></w:p>') ===
    '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>'
);
check(
  'an empty <w:p/> gains properties rather than being mangled',
  withPageBreakBefore('<w:p/>') === '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>'
);

/* A template that says "explicitly off" should follow the setting, and must not end up with two. */
const alreadyOff = withPageBreakBefore(para('x', '<w:pageBreakBefore w:val="0"/>'));
check(
  'an explicit "off" is turned on rather than duplicated',
  alreadyOff.includes('<w:pageBreakBefore/>') &&
    (alreadyOff.match(/<w:pageBreakBefore/g) ?? []).length === 1,
  alreadyOff
);
check(
  'running twice changes nothing the second time',
  startFindingsOnNewPage(startFindingsOnNewPage(usual).xml).xml === startFindingsOnNewPage(usual).xml
);

/* ------------------------------------------------------------ when it cannot ------ */

console.log('\nWhat it refuses to guess at:');

const noLoop = body(heading('Findings'), para('Nothing repeats here.'));
const none = startFindingsOnNewPage(noLoop);
check('a template with no findings loop is untouched', none.xml === noLoop && !none.applied);
check('and says why', /no findings loop/.test(none.reason ?? ''), none.reason);

const tableFirst = body(
  para('{{#findings}}'),
  `<w:tbl><w:tr><w:tc>${heading('{{ .title }}')}</w:tc></w:tr></w:tbl>`,
  para('{{/findings}}')
);
const refused = startFindingsOnNewPage(tableFirst);
check(
  'a loop that opens with a table is left exactly as it was',
  refused.xml === tableFirst && !refused.applied
);
check('and says why', /table/.test(refused.reason ?? ''), refused.reason);

/* The only findings loop being a table row is not a template we can help, and saying "no findings
 * loop" about a template that visibly has one would send somebody looking for the wrong thing. */
const onlySummary = body(
  `<w:tbl><w:tr>` +
    `<w:tc>${para('{{#findings}}')}${para('{{ .id }}')}</w:tc>` +
    `<w:tc>${para('{{ .title }}')}</w:tc>` +
    `<w:tc>${para('{{ .severity }}')}${para('{{/findings}}')}</w:tc>` +
    `</w:tr></w:tbl>`
);
const rowOnly = startFindingsOnNewPage(onlySummary);
check('a summary-row-only template is untouched', rowOnly.xml === onlySummary && !rowOnly.applied);
check(
  'and is not described as having no loop at all',
  /table rows or single paragraphs/.test(rowOnly.reason ?? ''),
  rowOnly.reason
);

check('an empty part does not throw', startFindingsOnNewPage('').applied === false);
check('a missing part does not throw', startFindingsOnNewPage(undefined).applied === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
