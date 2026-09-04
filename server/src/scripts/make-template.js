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
  Document,
  PageBreak,
  Packer,
  Paragraph,
  TableOfContents,
  TableRow,
} from 'docx';

import env, { ROOT_DIR } from '../config/env.js';
import { log } from '../utils/logger.js';
import {
  ACCENT,
  HEADER_FILL,
  INK,
  MUTED,
  cell,
  h1,
  h2,
  h3,
  hint,
  infoTable,
  para,
  spacer,
  starterDocument,
  table,
  text,
} from '../services/docx-starter-kit.js';

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
    para('{{@rich.severityChart}}'),
    hint(
      'The ring above is drawn by the app from the severity counts, in the colours set under Settings, with its own legend underneath. Delete the placeholder if you would rather have the table alone — and see Templates → Tag Reference for the one-line variant.'
    ),
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

    /*
     * Where it came from, when enumeration was recorded.
     *
     * "How did you find this" is the first question in a red team readout, and the answer used to
     * live in somebody's memory of the week. Silent on an engagement with no enumeration.
     */
    para('{{#hasDiscoveredBy}}'),
    h3('How it was found'),
    para('{{#discoveredBy}}{{ .title }}{{#tool}} — {{ .tool }}{{/tool}}{{/discoveredBy}}'),
    para('{{/hasDiscoveredBy}}'),

    para('{{/findings}}'),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function enumerationDetail() {
  return [
    /*
     * The whole section is conditional.
     *
     * A standard web application test records no enumeration, and a template that printed the
     * heading regardless would put "Enumeration" above nothing on every report that is not a red
     * team — which is worse than not offering the section at all.
     */
    para('{{#hasEnumeration}}'),
    h1('Enumeration'),
    hint(
      'How the ground was mapped, in the order it was mapped. Everything between the loop markers repeats once per step. Nothing here appears on an engagement with no enumeration recorded, so this section is safe to leave in place even if you never run red team work.'
    ),
    para('Tooling used: {{ enumerationSummary.toolList }}'),
    para(
      '{{ enumerationSummary.steps }} steps recorded, {{ enumerationSummary.withOutput }} with tool output, {{ enumerationSummary.ledToFindings }} written up as findings.'
    ),
    para('Outcomes: {{#enumerationSummary.byStatus}}{{ .count }} {{ .label }}. {{/enumerationSummary.byStatus}}'),
    para(
      '{{#enumerationSummary.internal}}{{ enumerationSummary.internal }} further step(s) were recorded internally and are not reproduced here.{{/enumerationSummary.internal}}'
    ),
    spacer(240),

    para('{{#enumeration}}'),

    /*
     * A heading and a step print differently.
     *
     * The tab is a tree: "Subdomain Enumeration" is a section and the tools under it are the runs.
     * `isGroup` is true for the first and false for the second, so the report can keep the shape
     * without guessing from the depth — and the inverted section is how a template asks, since the
     * language has no comparison operator.
     */
    para('{{#isGroup}}'),
    h2('{{ .title }}'),
    /* The section's own sentence, so the part reads as writing rather than as a list of tools. */
    para('{{#hasSummary}}{{ .summary }}{{/hasSummary}}'),
    para('{{/isGroup}}'),

    para('{{^isGroup}}'),
    /* The hierarchical number, so a nested tree does not read as a flat list that lost its shape. */
    h3('{{ .number }}  {{ .title }}'),
    para("Tool: {{ .tool | default:'—' }}   ·   Target: {{ .target | default:'—' }}   ·   {{ .ranAt }}"),
    para('{{#phaseLabel}}Phase: {{ .phaseLabel }}{{/phaseLabel}}'),
    para('{{#statusLabel}}Outcome: {{ .statusLabel }}{{/statusLabel}}'),

    /* Each part is guarded: a step that is a screenshot and a sentence has no command and no output. */
    para('{{#hasCommand}}'),
    para('{{ .command }}'),
    para('{{/hasCommand}}'),

    /*
     * A table when the output's shape was recognised, the raw pane when it was not.
     *
     * `hasTable` and its inverse are how a template asks, since the language has no comparison
     * operator. Most output does not parse, so the pane is the common path and the table is the
     * upgrade for the tools whose format is knowable.
     */
    para('{{#hasTable}}'),
    para('{{@rich.outputTable}}'),
    para('{{/hasTable}}'),

    para('{{^hasTable}}'),
    para('{{#hasOutput}}'),
    para('{{@rich.output}}'),
    para('{{/hasOutput}}'),
    para('{{/hasTable}}'),

    /*
     * After the choice, not inside it: either the pane or the table can be an extract, and a
     * silently truncated sweep reads as a complete one.
     */
    para(
      '{{#printTruncated}}Extract only — {{ .printOmitted }} of {{ .printTotal }} {{ .printUnit }} are not printed.{{/printTruncated}}'
    ),

    para('{{#hasContent}}'),
    para('{{@rich.content}}'),
    para('{{/hasContent}}'),

    /* Closing the loop the operator opened: this run became a finding. */
    para('{{#hasLedTo}}'),
    para('Written up as: {{#ledToFindings}}{{ .identifier }} {{ .title }}{{/ledToFindings}}'),
    para('{{/hasLedTo}}'),

    para('{{/isGroup}}'),
    para('{{/enumeration}}'),
    para('{{/hasEnumeration}}'),
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
  return starterDocument({
    title: 'Penetration Test Report Template',
    description: 'Starter template for Engy Report — every placeholder uses {{ .tag }} syntax.',
    body: [
      ...coverPage(),
      ...documentControl(),
      ...tableOfContents(),
      ...executiveSummary(),
      ...scopeAndMethodology(),
      ...findingDetail(),
      ...enumerationDetail(),
      ...closing(),
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
