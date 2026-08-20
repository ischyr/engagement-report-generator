/**
 * Renders a real .docx through every template filter and checks what came out.
 *
 *   npm run test:tags
 *
 * The filters are the one part of this app a user writes code against, and half of them emit
 * WordprocessingML — a filter that produces slightly wrong XML does not fail loudly, it
 * produces a document Word refuses to open, usually on somebody else's machine. So this builds
 * a template, renders it through the same docxtemplater configuration `generateReport` uses,
 * and asserts on the XML that comes back out.
 *
 * No database and no fixtures: the point is the language, not the report.
 */

import { Document, Packer, Paragraph } from 'docx';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

import { createParser, createTagNormaliser, DELIMITERS } from '../services/template-parser.js';
import { log } from '../utils/logger.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A template whose body is one paragraph per line given. */
async function templateFrom(lines) {
  const doc = new Document({
    sections: [{ children: lines.map((text) => new Paragraph(text)) }],
  });
  return Packer.toBuffer(doc);
}

/** Renders it exactly as the report pipeline does, and hands back `word/document.xml`. */
function render(buffer, data) {
  const zip = new PizZip(buffer);
  const doc = new Docxtemplater(zip, {
    delimiters: DELIMITERS,
    parser: createParser({ dateFormat: 'yyyy-MM-dd' }),
    modules: [createTagNormaliser()],
    paragraphLoop: true,
    linebreaks: true,
    nullGetter(part) {
      return part.module === 'rawxml' ? '<w:p/>' : '';
    },
  });
  doc.render(data);
  return doc.getZip().file('word/document.xml').asText();
}

/**
 * The text a reader would see: markup off, entities back.
 *
 * docxtemplater escapes every value it inserts, so a host called "10.0.0.2 & friends" is
 * `&amp;` in the file and an ampersand on the page. Reading the raw XML as if it were text
 * would make a correct render look wrong.
 */
const textOf = (xml) =>
  xml
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const DATA = {
  name: 'Northwind external test',
  client: 'Smith & <Sons>',
  url: 'https://northwind.test/?a=1&b=2',
  email: 'security@northwind.test',
  start: '2026-08-12',
  end: '2026-08-16',
  crossYear: '2027-01-04',
  tester: 'Iulian Schifirnet',
  hosts: '<p>10.0.0.1</p><p>10.0.0.2 &amp; friends</p>',
  plain: 'one\ntwo\nthree',
  severityCounts: { critical: 2, high: 1, medium: 0 },
  effort: [{ who: 'a', hours: 0.25 }, { who: 'b', hours: 7 }],
  findings: [
    { id: 'VULN-01', title: 'Stored XSS', severity: 'Low', category: 'Web' },
    { id: 'VULN-02', title: 'Weak TLS', severity: 'Critical', category: 'Network' },
    { id: 'VULN-03', title: 'IDOR', severity: 'Low', category: 'Web' },
  ],
};

async function main() {
  /* ------------------------------------------------------------------ text + dates */
  {
    const xml = render(
      await templateFrom([
        '{{ tester | initials }}',
        '{{ start | fromTo:end }}',
        '{{ start | fromTo:crossYear }}',
        '{{ start | fromTo:start }}',
        '{{ findings | count }} findings, {{ findings | count:"severity":"Low" }} low',
        '{{ effort | sum:"hours" }} hours',
        '{{ findings | select:"title" | join:", " }}',
        '{{ findings | select:"severity" | unique | join:"/" }}',
        '{{ findings | select:"title" | map:"upper" | join:" " }}',
      ]),
      DATA
    );
    const text = textOf(xml);
    check('initials', text.includes('I.S.'), text.slice(0, 80));
    check(
      'a date range inside one month prints the month once',
      text.includes('12 – 16 August 2026'),
      text
    );
    check(
      'and across a year prints both in full',
      text.includes('12 August 2026 – 4 January 2027'),
      text
    );
    check('a single day is not a range', text.includes('12 August 2026,') || text.includes('12 August 2026'), text);
    check('count, with and without a filter', text.includes('3 findings, 2 low'), text);
    check('sum adds a field without floating-point litter', text.includes('7.25 hours'), text);
    check('select plucks a field', text.includes('Stored XSS, Weak TLS, IDOR'), text);
    check('unique drops repeats and keeps order', text.includes('Low/Critical'), text);
    check('map applies another filter to every item', text.includes('STORED XSS WEAK TLS IDOR'), text);
  }

  /* ------------------------------------------------------------------ collections */
  {
    const xml = render(
      await templateFrom([
        '{{#findings | groupBy:"severity"}}',
        '{{ label }} ({{ count }})',
        '{{#value}}{{ id }} {{/value}}',
        '{{/findings | groupBy:"severity"}}',
        '{{#severityCounts | loopObject}}{{ key }}={{ value }} {{/severityCounts | loopObject}}',
        '{{#hosts | lines}}[{{.}}]{{/hosts | lines}}',
        '{{#plain | lines}}({{.}}){{/plain | lines}}',
      ]),
      DATA
    );
    const text = textOf(xml);
    check(
      'groupBy returns a key, a label and the members',
      text.includes('Critical (1)') && text.includes('Low (2)'),
      text
    );
    check(
      'and severity groups come back in severity order, not alphabetically',
      text.indexOf('Critical (1)') < text.indexOf('Low (2)'),
      text
    );
    check('the members of a group can be looped', text.includes('VULN-01') && text.includes('VULN-03'), text);
    check('loopObject turns an object into rows', text.includes('critical=2') && text.includes('high=1'), text);
    check(
      'lines splits a rich-text field by paragraph, entities decoded',
      text.includes('[10.0.0.1]') && text.includes('[10.0.0.2 & friends]'),
      text
    );
    check('and splits plain text by newline', text.includes('(one)(two)(three)'), text);
  }

  /* ------------------------------------------------------------------ loop position */
  {
    const xml = render(
      await templateFrom([
        '{{#findings}}{{ $number }}/{{ $total }}{{#$last}} last{{/$last}}{{^$last}}, {{/$last}}{{/findings}}',
        '{{#findings}}',
        '{{ id }}',
        '{{@$pageBreakExceptLast}}',
        '{{/findings}}',
      ]),
      DATA
    );
    const text = textOf(xml);
    check('$number and $total', text.includes('1/3') && text.includes('3/3'), text);
    check('$last is true only on the last item', text.includes('3/3 last') && !text.includes('1/3 last'), text);
    /*
     * Two breaks for three findings. A hard page break inside the loop gives three and a
     * blank final page, which is the failure this tag exists to prevent.
     */
    const breaks = (xml.match(/w:type="page"/g) ?? []).length;
    check('a page break between items but not after the last', breaks === 2, `${breaks} breaks`);
  }

  /* ------------------------------------------------------------------ markup filters */
  {
    const xml = render(
      await templateFrom([
        '{{@ client | run | p }}',
        '{{@ client | p:"Quote" }}',
        '{{@ name | link:url | p }}',
        '{{@ email | mailto | p }}',
        '{{#findings}}',
        '{{@ title | bookmark:id | p:"Heading2" }}',
        '{{/findings}}',
        '{{@ "see VULN-02" | bookmarkLink:"VULN-02" | p }}',
        '{{@ "VULN-02" | ref | p }}',
        '{{@ "VULN-02" | pageRef | p }}',
      ]),
      DATA
    );

    check(
      'a value that emits markup is escaped, not injected',
      xml.includes('Smith &amp; &lt;Sons&gt;') && !xml.includes('<Sons>'),
      xml.slice(xml.indexOf('Smith') - 60, xml.indexOf('Smith') + 60)
    );
    check(
      'p can put the paragraph in one of the template’s styles',
      xml.includes('<w:pStyle w:val="Quote"/>'),
      'no Quote style applied'
    );
    check(
      'link emits a HYPERLINK field with the url escaped',
      xml.includes('HYPERLINK "https://northwind.test/?a=1&amp;b=2"'),
      'hyperlink field missing'
    );
    check(
      'mailto builds its own target',
      xml.includes('HYPERLINK "mailto:security@northwind.test"'),
      'mailto missing'
    );
    check(
      'bookmark names are sanitised to what Word accepts',
      xml.includes('w:name="VULN_01"') && xml.includes('w:name="VULN_03"'),
      'bookmarks missing'
    );
    check(
      'bookmark ids are a sequence, so two renders of one engagement match',
      xml.includes('w:bookmarkStart w:id="1"') && xml.includes('w:bookmarkStart w:id="3"'),
      'ids are not sequential'
    );
    check(
      'every bookmarkStart is closed',
      (xml.match(/<w:bookmarkStart/g) ?? []).length === (xml.match(/<w:bookmarkEnd/g) ?? []).length,
      'unbalanced bookmarks'
    );
    check(
      'bookmarkLink points at an anchor',
      xml.includes('<w:hyperlink w:anchor="VULN_02">'),
      'anchor missing'
    );
    check('ref is a REF field Word can refresh', xml.includes('REF VULN_02'), 'REF missing');
    check('pageRef asks for the page', xml.includes('PAGEREF VULN_02'), 'PAGEREF missing');
    check(
      'and the document is still well-formed XML',
      wellFormed(xml),
      'the rendered document.xml does not parse'
    );
  }

  /* ------------------------------------------------------------------ safety */
  {
    // A name used twice resolves to one bookmark: Word takes the first and ignores the rest,
    // so emitting both would silently point cross-references at the wrong place.
    const xml = render(
      await templateFrom(['{{@ "a" | bookmark:"dup" | p }}', '{{@ "b" | bookmark:"dup" | p }}']),
      {}
    );
    check(
      'a bookmark name used twice is written once',
      (xml.match(/w:name="dup"/g) ?? []).length === 1,
      `${(xml.match(/w:name="dup"/g) ?? []).length} bookmarks named dup`
    );

    // Filters on absent or wrongly-typed values must produce a document, not an exception:
    // half-written templates are the normal state of a template being written.
    const empty = render(
      await templateFrom([
        '[{{ missing | groupBy:"x" | count }}]',
        '[{{ missing | lines | join:"," }}]',
        '[{{ missing | select:"a" | join:"," }}]',
        '[{{ missing | sum:"a" }}]',
        '[{{ name | groupBy:"x" | count }}]',
        '[{{ missing | initials }}]',
        '[{{ missing | fromTo:missing }}]',
      ]),
      DATA
    );
    check(
      'filters on a missing value render empty rather than failing',
      textOf(empty).includes('[0][][][0][0][][]'),
      textOf(empty)
    );
  }

  /* ------------------------------------------------------------------ the reference */
  {
    /*
     * The tag reference is the only documentation a template author has, and it is served to
     * the Templates page rather than written in prose — so a filter that exists and is not
     * listed is a filter nobody will ever use, and a listed filter that does not exist is an
     * example that silently renders nothing.
     */
    const { FILTERS } = await import('../services/tag-reference.js');
    const { registerFilters } = await import('../services/template-parser.js');
    const implemented = Object.keys(registerFilters({}));
    const documented = FILTERS.flatMap((entry) => entry.name.split('/').map((n) => n.trim()));

    const undocumented = implemented.filter((name) => !documented.includes(name));
    const imaginary = documented.filter((name) => !implemented.includes(name));
    check('every filter is documented', undocumented.length === 0, undocumented.join(', '));
    check('and every documented filter exists', imaginary.length === 0, imaginary.join(', '));

    const { knownTagRoots } = await import('../services/tag-reference.js');
    const roots = knownTagRoots();
    /*
     * The page break the syntax notes recommend was not in this list, so the test render called
     * a template that used it broken. Anything the parser answers by name belongs here.
     */
    for (const helper of ['$pageBreakExceptLast', '$pageBreakExceptFirst', '$index', '$first', '$last']) {
      check(`the reference knows ${helper}`, roots.has(helper), 'reported as not a tag');
    }

    /*
     * The offer vocabulary too. It was documented and never added to this list, so the lint
     * reported a proposal template's own tags — `validUntil`, `constraints`, the firm block — as
     * tags that do not exist: the templates the app ships warned about themselves.
     */
    for (const tag of ['validUntil', 'constraints', 'retainer', 'isRetainer', 'requestedOn']) {
      check(`and the proposal tag ${tag}`, roots.has(tag), 'reported as not a tag');
    }

    /* Every documented proposal tag resolves against a proposal with nothing filled in. */
    const { buildProposalData } = await import('../services/proposal-data.service.js');
    const { PROPOSAL_TAG_GROUPS } = await import('../services/tag-reference.js');
    const sample = buildProposalData({ contacts: [] }, {}, {}, {});
    const missing = PROPOSAL_TAG_GROUPS.flatMap((group) => group.tags.map((entry) => entry.tag))
      .filter((tag) => !tag.includes('|') && !tag.startsWith('$'))
      .filter((tag) => {
        // Dotted tags are nested objects, except the `rich.*` pair which are literal keys.
        if (Object.prototype.hasOwnProperty.call(sample, tag)) return false;
        return tag.split('.').reduce((scope, part) => {
          if (scope === undefined || scope === null) return undefined;
          return Object.prototype.hasOwnProperty.call(scope, part) ? scope[part] : undefined;
        }, sample) === undefined;
      });
    check(
      'every documented proposal tag is something the offer data actually carries',
      missing.length === 0,
      missing.join(', ')
    );
  }

  /* ------------------------------------ the package Word refused to open ------ */
  {
    /*
     * A report went out that Word would not open: "an error trying to open the file — check the file
     * permissions, make sure there is sufficient free memory and disk space." None of that was true.
     * The package held `docProps/custom.xml` — the provenance stamp — with no content type declaring
     * what it was, and that is the message Word gives for it.
     *
     * The write of `[Content_Types].xml` was guarded by a comparison against a value that the
     * provenance step had *already updated*, so the part was only written when something else also
     * changed it — a new image extension, in practice. One engagement's report contained a .jpg and
     * opened; the other's contained only .png files, and did not.
     *
     * Every test passed throughout, because every fixture template already declared that override.
     * So this one takes it away first, which is the state a real template is in.
     */
    const { packageProblems } = await import('../services/ooxml/docx-validate.js');
    const { DocxAssembler } = await import('../services/ooxml/docx-parts.js');
    const { customPropertiesXml } = await import('../services/provenance.service.js');

    const buffer = await templateFrom(['A report with no images at all.']);
    const zip = new PizZip(buffer);

    /* As a template written by Word looks: no override for a part it does not have. */
    const stripped = zip
      .file('[Content_Types].xml')
      .asText()
      .replace(/<Override\b[^>]*custom-properties[^>]*\/>|<Override\b[^>]*docProps\/custom\.xml[^>]*\/>/gi, '');
    zip.file('[Content_Types].xml', Buffer.from(stripped, 'utf8'));
    zip.remove('docProps/custom.xml');
    check(
      'a template with no custom properties of its own',
      !zip.file('docProps/custom.xml') && !stripped.includes('docProps/custom.xml'),
      'the fixture was not stripped'
    );

    const parts = new DocxAssembler(zip).load();
    parts.ensureNumbering();
    parts.setCustomProperties(
      customPropertiesXml({
        renderId: 'zz-render-id',
        at: new Date('2026-01-01T00:00:00Z'),
        byName: 'Somebody',
        templateName: 'zz',
        templateVersion: 'abcdef0123',
        build: '1.0.0',
        subject: 'zz',
      })
    );
    parts.commit();

    const types = zip.file('[Content_Types].xml').asText();
    check(
      'stamping a document with where it came from also declares the part it added',
      types.includes('PartName="/docProps/custom.xml"') &&
        types.includes('custom-properties+xml'),
      types.slice(-300)
    );
    check(
      // The failure exactly: the part is in the package, and nothing says what it is.
      'so the package has nothing in it Word would refuse',
      packageProblems(zip).length === 0,
      packageProblems(zip).join(' / ')
    );

    /* And the validator has to actually catch that state, or it is decoration. */
    const broken = new PizZip(await templateFrom(['x']));
    broken.file('docProps/custom.xml', Buffer.from('<Properties/>', 'utf8'));
    broken.file(
      '[Content_Types].xml',
      Buffer.from(
        broken
          .file('[Content_Types].xml')
          .asText()
          .replace(/<Override\b[^>]*custom-properties[^>]*\/>|<Override\b[^>]*docProps\/custom\.xml[^>]*\/>/gi, ''),
        'utf8'
      )
    );
    const found = packageProblems(broken);
    check(
      'and a package in the state that shipped is reported, not passed',
      found.some((line) => /custom\.xml/.test(line)),
      found.join(' / ') || 'the validator saw nothing wrong'
    );

    /* The other package rules, each broken on purpose. */
    const dangling = new PizZip(await templateFrom(['x']));
    dangling.file(
      'word/document.xml',
      Buffer.from(
        dangling.file('word/document.xml').asText().replace('<w:body>', '<w:body><w:p><w:hyperlink r:id="rIdNope"/></w:p>'),
        'utf8'
      )
    );
    check(
      'a relationship the document uses but nothing declares is caught',
      packageProblems(dangling).some((line) => /rIdNope/.test(line)),
      packageProblems(dangling).join(' / ')
    );

    const missing = new PizZip(await templateFrom(['x']));
    missing.file(
      'word/_rels/document.xml.rels',
      Buffer.from(
        missing
          .file('word/_rels/document.xml.rels')
          .asText()
          .replace('</Relationships>', '<Relationship Id="rIdX" Type="http://x" Target="gone.xml"/></Relationships>'),
        'utf8'
      )
    );
    check(
      'and so is a relationship pointing at a part that is not there',
      packageProblems(missing).some((line) => /gone\.xml/.test(line)),
      packageProblems(missing).join(' / ')
    );

    const illFormed = new PizZip(await templateFrom(['x']));
    illFormed.file(
      'word/document.xml',
      Buffer.from(illFormed.file('word/document.xml').asText().replace('</w:body>', ''), 'utf8')
    );
    check(
      'and XML that does not close',
      packageProblems(illFormed).some((line) => /not well-formed/.test(line)),
      packageProblems(illFormed).join(' / ')
    );
  }

  /* ---------------------------------------- one house style, several documents */
  {
    /*
     * A base with a letterhead, a footer and a style of its own, and a child that has none of them.
     *
     * Built with the `docx` package rather than by hand because the point of the check is the
     * *substitution*, and a hand-rolled package would be testing the fixture as much as the code.
     * The base gets A4 landscape so the page setup is unmistakably its own: if the child comes out
     * landscape, the section properties really were adopted.
     */
    const { Document: Doc2, Packer: Pack2, Paragraph: P2, Header, Footer, TextRun } = await import('docx');

    const baseBuffer = await Pack2.toBuffer(
      new Doc2({
        styles: {
          paragraphStyles: [
            {
              id: 'HouseNote',
              name: 'House Note',
              basedOn: 'Normal',
              run: { color: 'AA0000', size: 18 },
            },
          ],
        },
        sections: [
          {
            properties: {
              page: { size: { orientation: 'landscape' } },
            },
            headers: { default: new Header({ children: [new P2('THE HOUSE LETTERHEAD')] }) },
            footers: { default: new Footer({ children: [new P2('house footer, page')] }) },
            children: [new P2({ children: [new TextRun('base body, never copied')] })],
          },
        ],
      })
    );

    const childBuffer = await templateFrom(['Child body: {{ name }}']);

    const { applyInheritedParts } = await import('../services/template-inheritance.service.js');
    const childZip = new PizZip(childBuffer);
    const baseZip = new PizZip(baseBuffer);

    /* Nothing asked for, nothing changed — the case nearly every template is in. */
    const untouchedDoc = childZip.file('word/document.xml').asText();
    const nothing = applyInheritedParts(new PizZip(childBuffer), baseZip, {});
    check('inheriting nothing applies nothing', nothing.applied.length === 0, nothing.applied.join(', '));

    const result = applyInheritedParts(childZip, baseZip, {
      styles: true,
      numbering: true,
      theme: true,
      page: true,
    });
    check(
      'a template can take the styles, the numbering and the page setup from a base',
      ['styles', 'numbering', 'page'].every((part) => result.applied.includes(part)),
      `applied ${result.applied.join(', ')} — ${result.warnings.join(' / ')}`
    );
    check(
      /*
       * The fixture has no theme part — a document only carries one when something in it uses the
       * theme's colours — so this is the missing-part path, and it has to name what it skipped
       * rather than quietly applying three of the four things that were asked for.
       */
      'and a part the base does not have is named as skipped rather than silently dropped',
      !result.applied.includes('theme') &&
        result.warnings.some((line) => /theme/i.test(line)),
      result.warnings.join(' / ')
    );

    const styles = childZip.file('word/styles.xml').asText();
    check(
      'the base’s own style is now defined in the child',
      /w:styleId="HouseNote"/.test(styles),
      'HouseNote was not carried across'
    );

    const doc = childZip.file('word/document.xml').asText();
    check(
      // The words are the child's; only the furniture is inherited.
      'while the child keeps its own body and its own tags',
      /Child body/.test(doc) && /\{\{ name \}\}/.test(doc) && !/base body/.test(doc),
      doc.slice(0, 200)
    );
    check(
      'the page setup is the base’s — landscape, which the child never was',
      /w:orient="landscape"/.test(doc) && !/w:orient="landscape"/.test(untouchedDoc),
      'the orientation did not come across'
    );

    const headerRef = /<w:headerReference[^>]*r:id="(rId\d+)"/.exec(doc);
    check('with a header reference in the adopted section', Boolean(headerRef), doc.slice(-400));
    const rels = childZip.file('word/_rels/document.xml.rels').asText();
    const headerTarget = headerRef
      ? new RegExp(`Id="${headerRef[1]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      : null;
    check(
      // Under a name of its own: the child may already have a header2.xml that something else uses.
      'pointing at a part copied in under its own name',
      headerTarget === 'engy-header-default.xml',
      String(headerTarget)
    );
    check(
      'which holds the base’s letterhead',
      /THE HOUSE LETTERHEAD/.test(childZip.file('word/engy-header-default.xml')?.asText() ?? ''),
      'the header part is missing or empty'
    );
    check(
      'and the footer came with it',
      /house footer/.test(childZip.file('word/engy-footer-default.xml')?.asText() ?? ''),
      'the footer part is missing'
    );

    const types = childZip.file('[Content_Types].xml').asText();
    check(
      // A part with no content type is a part Word refuses to open the file over.
      'every part copied in is declared in the content types',
      types.includes('/word/engy-header-default.xml') &&
        types.includes('/word/engy-footer-default.xml'),
      types.slice(-300)
    );
    check(
      'and the relationship ids do not collide with the child’s own',
      new Set([...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1])).size ===
        [...rels.matchAll(/Id="rId\d+"/g)].length,
      'a duplicate relationship id was written'
    );

    /* And it still renders, which is the only thing that matters at the end of it. */
    const rendered = render(
      childZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
      { name: 'Northwind' }
    );
    check(
      'a template with an inherited house style still renders its own tags',
      /Northwind/.test(textOf(rendered)),
      textOf(rendered).slice(0, 120)
    );

    /*
     * A section break inside the document is a landscape appendix somebody built on purpose, and
     * adopting the house page setup must not straighten it out. The first version of this replaced
     * the last sectPr it could find, wherever it was.
     */
    const withBreak = await Pack2.toBuffer(
      new Doc2({
        sections: [
          { children: [new P2('first section')] },
          {
            properties: { page: { size: { orientation: 'landscape' } } },
            children: [new P2('the appendix, sideways on purpose')],
          },
        ],
      })
    );
    const breakZip = new PizZip(withBreak);
    const breaksBefore = (breakZip.file('word/document.xml').asText().match(/<w:sectPr/g) ?? []).length;
    applyInheritedParts(breakZip, baseZip, { page: true });
    const breakDoc = breakZip.file('word/document.xml').asText();
    check(
      'a section break inside the document is left alone',
      (breakDoc.match(/<w:sectPr/g) ?? []).length === breaksBefore,
      `sections went from ${breaksBefore} to ${(breakDoc.match(/<w:sectPr/g) ?? []).length}`
    );

    /*
     * A base with no letterhead. Its page setup is still worth having — the paper size and the
     * margins are the house's — and saying so is better than either failing or implying a header
     * came across when there was none to take.
     */
    const bare = new PizZip(await templateFrom(['nothing here']));
    const bareResult = applyInheritedParts(new PizZip(childBuffer), bare, { page: true });
    check(
      'a base with no header or footer gives its page setup and says that is all',
      bareResult.applied.includes('page') &&
        bareResult.warnings.some((line) => /page size and margins/.test(line)),
      bareResult.warnings.join(' / ')
    );
  }

  /* ------------------------------------------------------------- HTML partials */
  {
    const { expandPartials } = await import('../services/template-inheritance.service.js');
    const library = {
      'house header': '<header><img src="logo.png"><h1>{{ company.name }}</h1></header>',
      'house footer': '<footer>{{ reference }} · confidential</footer>',
      wrapper: '{{> house header }}<main>wrapped</main>{{> house footer }}',
      selfish: 'before {{> selfish }} after',
    };
    const resolve = async (name) => library[name.toLowerCase()] ?? null;

    const flat = await expandPartials('{{> house header }}<p>body</p>{{> house footer }}', resolve);
    check(
      'an HTML template can include another by name',
      /house header|<h1>/.test(flat.html) && /confidential/.test(flat.html),
      flat.html.slice(0, 160)
    );
    check(
      // The tags inside a partial are the outer template's data, expanded before rendering.
      'and the tags inside the partial survive to be rendered',
      flat.html.includes('{{ company.name }}') && flat.html.includes('{{ reference }}'),
      flat.html
    );
    check('naming which partials were used', flat.used.length === 2, JSON.stringify(flat.used));

    const nested = await expandPartials('{{> wrapper }}', resolve);
    check(
      'a partial may include another',
      /<h1>/.test(nested.html) && /wrapped/.test(nested.html) && /confidential/.test(nested.html),
      nested.html.slice(0, 200)
    );

    const missing = await expandPartials('{{> nowhere }}', resolve);
    check(
      // A silently missing block is how a report goes out with no letterhead and nobody notices.
      'a partial that does not exist is left visible and reported',
      /nowhere/.test(missing.html) && missing.warnings.length === 1,
      JSON.stringify([missing.html, missing.warnings])
    );

    const cycle = await expandPartials('{{> selfish }}', resolve);
    check(
      'and one that includes itself is stopped rather than followed',
      cycle.warnings.some((line) => /includes itself/.test(line)) && /before/.test(cycle.html),
      JSON.stringify(cycle.warnings)
    );
  }

  /* ------------------------------------------------ a tag Word has split across runs */
  {
    /*
     * Word splits a run wherever its grammar checker sees a sentence boundary, and a tag is a
     * likely place for one. So the template a person uploads is frequently not the template they
     * were given: open it, save it, upload it, and `{{ stats.total }}` is now `{{ stats.total` in
     * one run and ` }}` in the next, with `<w:proofErr/>` and a fresh `<w:rPr>` between them.
     *
     * That has to render the number and keep the bold. It did neither: the normaliser folded the
     * markup between the runs into the tag name, so the value resolved to nothing and the run
     * properties it blanked took the formatting with them. A whole page of counts came out empty
     * in a report that had been checked against a template that looked right.
     */
    const buffer = await templateFrom(['Total: {{ stats.total }} findings.']);
    const zip = new PizZip(buffer);
    const before = zip.file('word/document.xml').asText();
    const split = before.replace(
      '{{ stats.total }}',
      '{{ stats.total</w:t></w:r>' +
        '<w:proofErr w:type="gramEnd"/>' +
        '<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve"> }}'
    );
    check('the split fixture really is split', split !== before, 'the replacement did not apply');
    zip.file('word/document.xml', split);

    const out = render(zip.generate({ type: 'nodebuffer' }), { stats: { total: 8 } });
    check(
      'a tag Word split across runs still renders its value',
      textOf(out).includes('Total: 8 findings.'),
      textOf(out).slice(0, 80)
    );
    check(
      'and the run properties either side survive',
      out.includes('<w:b/>'),
      'the bold was stripped with the tag'
    );
  }

  /* -------------------------------------------------- writing tags into a paragraph */
  {
    /*
     * Two replacements in one paragraph, where the first leaves an empty run behind. The second
     * must not treat that empty run as its anchor: what a blanked run still carries is the
     * `<w:br/>` that ended the line, so writing there puts the new text on the wrong side of the
     * break. The counters page read "TOTAL FIXED: 1TOTAL RETESTING: 1" on one line because of it.
     */
    const { replaceAcrossRuns } = await import('../services/ooxml/docx-surgery.js');
    const run = (inner) => `<w:r><w:rPr><w:b/></w:rPr>${inner}</w:r>`;
    const paragraph =
      `<w:p>${run('<w:t xml:space="preserve">FIXED: </w:t>')}${run('<w:t>0</w:t>')}` +
      `${run('<w:br/><w:t xml:space="preserve">RETESTING: </w:t>')}${run('<w:t>0</w:t>')}</w:p>`;

    let edited = replaceAcrossRuns(paragraph, 'FIXED: 0', 'FIXED: {{ fixed }}');
    check('the first replacement lands', Boolean(edited), 'no match');
    edited = replaceAcrossRuns(edited, 'RETESTING: 0', 'RETESTING: {{ retesting }}');
    check('the second replacement lands', Boolean(edited), 'no match');

    const breakAt = edited.indexOf('<w:br/>');
    check(
      'the line break still comes before the text that followed it',
      breakAt !== -1 && breakAt < edited.indexOf('RETESTING: {{ retesting }}'),
      breakAt === -1 ? 'the break was dropped' : 'the text was written before the break'
    );
  }

  /* ----------------------------------------------------------- the outline it shows */
  {
    /*
     * The playground looks each tag's verdict up in the lint's results, by scope and name. So the
     * two have to walk a document the same way — one shared scanner, which is what these check:
     * a tag inside a loop reports that loop as its scope in both, and a closing tag is bookkeeping
     * rather than something to resolve.
     */
    const { outlineTemplate, suggestTags } = await import('../services/template-outline.service.js');

    const html = [
      '<p>Report for {{ .company.name }}</p>',
      '{{#findings}}',
      '<h2>{{ .title }}</h2>',
      '{{/findings}}',
    ].join('\n');

    const outline = await outlineTemplate({
      template: { kind: 'html', html },
      tags: [
        { tag: 'company.name', where: '', status: 'ok', value: 'Acme' },
        { tag: 'findings', where: '', status: 'ok', value: '3 items' },
        { tag: 'title', where: 'findings', status: 'ok', value: 'A finding' },
      ],
    });
    const segments = outline.parts.flatMap((part) => part.blocks.flatMap((block) => block.segments));
    const segment = (tag, kind) => segments.find((s) => s.tag === tag && (!kind || s.kind === kind));

    check('the outline finds every placeholder', segments.filter((s) => s.tag).length === 4, `${segments.filter((s) => s.tag).length}`);
    check(
      'a tag inside a loop carries that loop as its scope',
      segment('title')?.scope?.join('>') === 'findings',
      JSON.stringify(segment('title')?.scope)
    );
    check(
      "and the verdict the lint gave it",
      segment('title')?.status === 'ok' && segment('title')?.value === 'A finding',
      `${segment('title')?.status} / ${segment('title')?.value}`
    );
    check(
      'a closing tag is marked as bookkeeping, not as an unknown tag',
      segment('findings', 'close')?.status === 'close',
      segment('findings', 'close')?.status ?? '(no closing segment)'
    );
    check(
      'the text either side of a tag is kept',
      segments.some((s) => (s.text ?? '').includes('Report for')),
      'the surrounding text was dropped'
    );
    check(
      'a paragraph with no tags in it is left out',
      outline.parts.every((part) => part.blocks.every((b) => b.segments.some((s) => s.tag))),
      'a block with no tags came back'
    );

    // And the part that turns "not a tag" into something actionable.
    check(
      'a misspelling suggests the tag it is one edit from',
      suggestTags('stats.totl')[0] === 'stats.total',
      suggestTags('stats.totl').join(', ')
    );
    check(
      'a misspelling under a real root suggests that root',
      suggestTags('clietn.email')[0] === 'client.email',
      suggestTags('clietn.email').join(', ')
    );
    check(
      'and a name nothing resembles suggests nothing',
      suggestTags('xyzzy').length === 0,
      suggestTags('xyzzy').join(', ')
    );
  }

  /* ---------------------------------------------------- what the test render reports */
  {
    /*
     * The Templates page's test render is the only tool that says whether a template is wired
     * up, so it being wrong is worse than it being absent: it sent me editing a correct
     * template three times over.
     */
    const { analyseTags } = await import('../services/template-test.service.js');
    const data = {
      hosts: [
        { label: 'a.example', os: 'Ubuntu 22.04' },
        { label: 'b.example' },
      ],
      checks: [{ title: 'not blocked' }, { title: 'blocked', blockedReason: 'no jump host' }],
    };
    const statusOf = (result, tag) => result.tags.find((entry) => entry.tag === tag)?.status;

    // A section over a plain value is a condition: it shows the block, it does not move the scope.
    const condition = analyseTags(
      [{ tag: 'os', scope: ['hosts', 'os'], kind: 'value' }],
      data
    );
    check(
      'a tag inside a condition resolves against the row, not the value',
      statusOf(condition, 'os') === 'ok',
      statusOf(condition, 'os')
    );

    // And a loop is sampled across its rows, not only at the first.
    const sampled = analyseTags(
      [{ tag: 'blockedReason', scope: ['checks'], kind: 'value' }],
      data
    );
    check(
      'a field only some rows carry is found on the row that carries it',
      statusOf(sampled, 'blockedReason') === 'ok',
      statusOf(sampled, 'blockedReason')
    );

    // A field inside its own condition is one fact, so it is one row.
    const twice = analyseTags(
      [
        { tag: 'blockedReason', scope: ['checks'], kind: 'section' },
        { tag: 'blockedReason', scope: ['checks', 'blockedReason'], kind: 'value' },
      ],
      data
    );
    check(
      'a field inside its own condition is listed once',
      twice.tags.filter((t) => t.tag === 'blockedReason').length === 1,
      `${twice.tags.length} rows`
    );

    // But a different field inside that condition is its own fact.
    const other = analyseTags(
      [{ tag: 'title', scope: ['checks', 'blockedReason'], kind: 'value' }],
      data
    );
    check(
      'and another field inside a condition still is',
      other.tags.some((t) => t.tag === 'title'),
      'it was swallowed with the duplicates'
    );

    // Without breaking the case the whole thing exists for: a real typo is still a typo.
    const typo = analyseTags([{ tag: 'hosts.nmae', scope: [], kind: 'value' }], data);
    check(
      'and a misspelt field is still reported',
      statusOf(typo, 'hosts.nmae') === 'unknown',
      statusOf(typo, 'hosts.nmae')
    );
  }

  log.info('');
  if (failed === 0) log.info(`RESULT: ${passed} checks passed`);
  else log.error(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * A cheap well-formedness check.
 *
 * Not a parser: counting tags catches the failure that matters here — a filter emitting an
 * unbalanced element — without adding an XML dependency for one assertion. The smoke test
 * validates a whole report properly.
 */
function wellFormed(xml) {
  const stack = [];
  for (const match of xml.matchAll(/<(\/?)([a-zA-Z0-9:]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing === '/' || name.startsWith('?') || name.startsWith('!')) continue;
    if (closing === '/') {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

main().catch((error) => {
  log.error(error.stack ?? error.message);
  process.exit(1);
});
