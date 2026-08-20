/**
 * Builds the starter .docx template, tags and all.
 *
 *   npm run make:template            → server/storage/templates/…  + repo root
 *   npm run make:template -- out.docx
 *
 * Editing this script is not the intended workflow — open the generated file in
 * Word and restyle it. It exists so there is always a known-good, fully tagged
 * document to start from (and to regenerate if one gets mangled).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

import env, { ROOT_DIR } from '../config/env.js';
import { log } from '../utils/logger.js';

/* -------------------------------------------------------------------------- */
/* Palette & helpers                                                          */
/* -------------------------------------------------------------------------- */

const INK = '1F2937';
const MUTED = '6B7280';
const ACCENT = '1F3864';
const RULE = 'D1D5DB';
const HEADER_FILL = 'F3F4F6';

const text = (value, options = {}) => new TextRun({ text: value, ...options });

const para = (value, options = {}) => {
  const { runs, ...rest } = options;
  return new Paragraph({
    children: runs ?? (value === undefined ? [] : [text(value, options.run ?? {})]),
    ...rest,
  });
};

const h1 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_1 });
const h2 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_2 });
const h3 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_3 });
const spacer = (after = 120) => new Paragraph({ spacing: { after }, children: [] });

/**
 * A short explanatory note for whoever edits the template.
 *
 * These must never contain live placeholder syntax: the renderer would try to
 * evaluate the example and fail with an unclosed-loop error. Describe the
 * syntax in words and point at the in-app Tag Reference instead.
 */
const hint = (value) =>
  new Paragraph({
    spacing: { before: 40, after: 160 },
    children: [text(value, { italics: true, size: 16, color: MUTED })],
  });

const cell = (children, options = {}) => {
  const {
    width,
    fill,
    bold = false,
    align,
    columnSpan,
    size = 20,
    color = INK,
  } = options;
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    columnSpan,
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: (Array.isArray(children) ? children : [children]).map((entry) =>
      typeof entry === 'string'
        ? new Paragraph({
            alignment: align,
            spacing: { after: 0 },
            children: [text(entry, { bold, size, color })],
          })
        : entry
    ),
  });
};

const thinBorders = () => {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: edge, insideVertical: edge };
};

const table = (rows, options = {}) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: thinBorders(),
    columnWidths: options.columnWidths,
    rows,
  });

/** Two-column key/value table used for the cover and document-control blocks. */
const infoTable = (pairs) =>
  table(
    pairs.map(
      ([label, value]) =>
        new TableRow({
          children: [
            cell(label, { width: 30, fill: HEADER_FILL, bold: true }),
            cell(value, { width: 70 }),
          ],
        })
    )
  );

/* -------------------------------------------------------------------------- */
/* Document body                                                              */
/* -------------------------------------------------------------------------- */

function coverPage() {
  return [
    spacer(1200),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [text('PENETRATION TEST REPORT', { bold: true, size: 44, color: ACCENT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [text('{{ .auditType }}', { size: 26, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [text('{{ .name }}', { bold: true, size: 32, color: INK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 720 },
      children: [text('{{ .company.name }}', { size: 26, color: INK })],
    }),
    infoTable([
      ['Reference', "{{ .reference | default:'—' }}"],
      ['Report date', '{{ .date }}'],
      ['Testing window', '{{ .date_start }} — {{ .date_end }}'],
      ['Prepared for', '{{ .client.fullname }}, {{ .client.title }}'],
      ['Prepared by', '{{ .creator.fullname }}'],
      ['Status', '{{ .state }}'],
      ['Classification', "{{ .custom.classification | default:'CONFIDENTIAL' }}"],
    ]),
    spacer(480),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        text(
          'This document contains confidential information and is intended solely for the recipient named above.',
          { italics: true, size: 18, color: MUTED }
        ),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function documentControl() {
  return [
    h1('Document Control'),
    infoTable([
      ['Client', '{{ .company.name }}'],
      ['Client address', '{{ .company.address }}'],
      ['Primary contact', '{{ .client.fullname }} — {{ .client.email }}'],
      ['Contact phone', "{{ .client.phone | default:'—' }}"],
      ['Engagement type', '{{ .auditType }}'],
      ['Report author', '{{ .creator.fullname }} — {{ .creator.email }}'],
      ['Generated', '{{ .now }}'],
    ]),
    spacer(320),

    h2('Assessment Team'),
    table([
      new TableRow({
        tableHeader: true,
        children: [
          cell('Name', { width: 34, fill: HEADER_FILL, bold: true }),
          cell('Role', { width: 33, fill: HEADER_FILL, bold: true }),
          cell('Email', { width: 33, fill: HEADER_FILL, bold: true }),
        ],
      }),
      // Loop tags opening and closing inside one row make Word repeat that row.
      new TableRow({
        children: [
          cell('{{#collaborators}}{{ .fullname }}', { width: 34 }),
          cell("{{ .title | default:'Security Consultant' }}", { width: 33 }),
          cell('{{ .email }}{{/collaborators}}', { width: 33 }),
        ],
      }),
    ]),
    hint(
      'The row above repeats once per collaborator, because the loop opens in its first cell and closes in its last. The reviewers and approvals lists work the same way.'
    ),

    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function tableOfContents() {
  return [
    h1('Contents'),
    new TableOfContents('Table of Contents', {
      hyperlink: true,
      headingStyleRange: '1-3',
    }),
    hint('Word builds this list on open — right-click and choose "Update Field" if it looks empty.'),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function executiveSummary() {
  return [
    h1('Executive Summary'),
    para('{{@sections.executive_summary.rich.text}}'),
    hint(
      'The placeholder above pulls in the Executive Summary with full Word formatting — headings, bullet lists, tables and screenshots all survive. A plain-text variant is available too; see Templates → Tag Reference in the app.'
    ),

    h2('Findings at a Glance'),
    table(
      [
        new TableRow({
          tableHeader: true,
          children: [
            cell('Severity', { width: 60, fill: HEADER_FILL, bold: true }),
            cell('Findings', { width: 40, fill: HEADER_FILL, bold: true, align: AlignmentType.CENTER }),
          ],
        }),
        new TableRow({
          children: [
            cell('{{#stats.bySeverity}}{{ .label }}', { width: 60 }),
            cell('{{ .count }}{{/stats.bySeverity}}', { width: 40, align: AlignmentType.CENTER }),
          ],
        }),
        new TableRow({
          children: [
            cell('Total', { width: 60, fill: HEADER_FILL, bold: true }),
            cell('{{ .stats.total }}', {
              width: 40,
              fill: HEADER_FILL,
              bold: true,
              align: AlignmentType.CENTER,
            }),
          ],
        }),
      ],
      { columnWidths: [5600, 3760] }
    ),
    spacer(320),

    h2('Summary of Findings'),
    table(
      [
        new TableRow({
          tableHeader: true,
          children: [
            cell('ID', { width: 10, fill: HEADER_FILL, bold: true }),
            cell('Finding', { width: 44, fill: HEADER_FILL, bold: true }),
            cell('Severity', { width: 15, fill: HEADER_FILL, bold: true }),
            cell('CVSS', { width: 11, fill: HEADER_FILL, bold: true, align: AlignmentType.CENTER }),
            cell('Priority', { width: 20, fill: HEADER_FILL, bold: true }),
          ],
        }),
        new TableRow({
          children: [
            cell('{{#findings}}{{ .id }}', { width: 10 }),
            cell('{{ .title }}', { width: 44 }),
            cell('{{ .severity }}', { width: 15 }),
            cell('{{ .cvssScore }}', { width: 11, align: AlignmentType.CENTER }),
            cell("{{ .priorityLabel | default:'—' }}{{/findings}}", { width: 20 }),
          ],
        }),
      ],
      { columnWidths: [936, 4118, 1404, 1030, 1872] }
    ),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function scopeAndMethodology() {
  return [
    h1('Scope and Approach'),
    para('{{@sections.scope_and_approach.rich.text}}'),

    h2('Assets in Scope'),
    table(
      [
        new TableRow({
          tableHeader: true,
          children: [
            cell('Hostname', { width: 34, fill: HEADER_FILL, bold: true }),
            cell('IP address', { width: 26, fill: HEADER_FILL, bold: true }),
            cell('Operating system', { width: 40, fill: HEADER_FILL, bold: true }),
          ],
        }),
        new TableRow({
          children: [
            cell('{{#hosts}}{{ .hostname }}', { width: 34 }),
            cell('{{ .ip }}', { width: 26 }),
            cell('{{ .os }}{{/hosts}}', { width: 40 }),
          ],
        }),
      ],
      { columnWidths: [3182, 2434, 3744] }
    ),
    hint(
      'This table lists every host flat. To group hosts under their scope name instead, swap it for the scope loop shown in Templates → Tag Reference.'
    ),

    h1('Methodology'),
    para('{{@sections.methodology.rich.text}}'),

    h1('Risk Rating'),
    para('{{@sections.risk_rating.rich.text}}'),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function findingDetail() {
  const metricsTable = table(
    [
      new TableRow({
        children: [
          cell('Severity', { width: 22, fill: HEADER_FILL, bold: true }),
          cell('{{ .severity }} ({{ .cvssScore }})', { width: 28 }),
          cell('Category', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .category | default:'—' }}", { width: 28 }),
        ],
      }),
      new TableRow({
        children: [
          cell('Priority', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .priorityLabel | default:'—' }}", { width: 28 }),
          cell('Remediation effort', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .remediationComplexityLabel | default:'—' }}", { width: 28 }),
        ],
      }),
      new TableRow({
        children: [
          cell('Type', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .vulnType | default:'—' }}", { width: 28 }),
          cell('CWE', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .custom.cwe | default:'—' }}", { width: 28 }),
        ],
      }),
      new TableRow({
        children: [
          // Version-neutral: a finding may be scored with 3.1 or 4.0, and
          // `cvss.version` prints whichever this one used.
          cell('CVSS vector', { width: 22, fill: HEADER_FILL, bold: true }),
          cell('v{{ .cvss.version }} — {{ .cvssv3 }}', { width: 78, columnSpan: 3, size: 18 }),
        ],
      }),
    ],
    { columnWidths: [2059, 2621, 2059, 2621] }
  );

  return [
    h1('Detailed Findings'),
    hint(
      'Everything between the two loop markers below repeats once per finding, ordered by CVSS score. The markers themselves disappear when the report is generated.'
    ),
    para('{{#findings}}'),
    h2('{{ .id }} — {{ .title }}'),
    metricsTable,
    spacer(240),

    h3('Description'),
    para('{{@rich.description}}'),

    h3('Affected Assets'),
    para('{{@rich.scope}}'),

    h3('Proof of Concept'),
    para('{{@rich.poc}}'),

    h3('Impact'),
    para('{{@rich.observation}}'),

    h3('Remediation'),
    para('{{@rich.remediation}}'),

    h3('References'),
    para('{{@rich.references}}'),

    para('{{/findings}}'),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function closing() {
  return [
    h1('Conclusion'),
    para('{{@sections.conclusion.rich.text}}'),

    h1('Appendix'),
    para('{{@sections.appendix.rich.text}}'),

    h2('About This Template'),
    para(undefined, {
      runs: [
        text(
          'This is an ordinary Word document. Restyle it however you like — change fonts, colours, page layout, add a cover image, move sections around. Only two things matter: keep the placeholders you want filled in, and keep the built-in Heading, List Paragraph, Quote and Caption styles available, because rich text from the app maps onto them.',
          { size: 19 }
        ),
      ],
    }),
    para(undefined, {
      runs: [
        text(
          'For the complete list of placeholders — every field, loop and filter, with copy-paste examples — open Templates → Tag Reference in Engy Report. Examples are deliberately not printed here: the generator would try to evaluate them.',
          { size: 19 }
        ),
      ],
    }),
    hint('Delete this section once you have made the template your own.'),
  ];
}

/* -------------------------------------------------------------------------- */

function buildDocument() {
  const heading = (size, color = ACCENT, extra = {}) => ({
    run: { font: 'Calibri Light', size, bold: true, color },
    paragraph: { spacing: { before: 320, after: 140 }, ...extra },
  });

  return new Document({
    creator: 'Engy Report',
    title: 'Penetration Test Report Template',
    description: 'Starter template for Engy Report — every placeholder uses {{ .tag }} syntax.',
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 21, color: INK },
          paragraph: { spacing: { line: 276, after: 140 } },
        },
        heading1: heading(32),
        heading2: heading(26),
        heading3: heading(23, INK),
        heading4: heading(21, INK),
      },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { italics: true, color: '4B5563' },
          paragraph: { indent: { left: 720 }, spacing: { before: 120, after: 120 } },
        },
        {
          id: 'Caption',
          name: 'Caption',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 17, italics: true, color: MUTED },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240 } },
        },
        {
          id: 'ListParagraph',
          name: 'List Paragraph',
          basedOn: 'Normal',
          quickFormat: true,
          paragraph: { spacing: { after: 60 }, contextualSpacing: true },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { after: 0 },
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
                children: [
                  text('{{ .company.name }}  ·  {{ .auditType }}', { size: 16, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0 },
                children: [
                  text("{{ .custom.classification | default:'CONFIDENTIAL' }}  ·  Page ", {
                    size: 16,
                    color: MUTED,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
                  text(' of ', { size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...coverPage(),
          ...documentControl(),
          ...tableOfContents(),
          ...executiveSummary(),
          ...scopeAndMethodology(),
          ...findingDetail(),
          ...closing(),
        ],
      },
    ],
  });
}

async function main() {
  const buffer = await Packer.toBuffer(buildDocument());

  const explicit = process.argv[2];
  const targets = explicit
    ? [path.resolve(explicit)]
    : [
        path.join(env.storage.templates, 'engy-default-template.docx'),
        path.join(ROOT_DIR, 'DEFAULT_PENTEST_REPORT.docx'),
      ];

  for (const target of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    log.info(`Wrote ${target} (${(buffer.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
