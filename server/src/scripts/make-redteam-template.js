/**
 * Builds the starter red team report template, tags and all.
 *
 *   npm run make:redteam-template            → server/storage/templates/…  + repo root
 *   npm run make:redteam-template -- out.docx
 *
 * The same paper as the penetration test starter — same palette, same headings, same cover shape,
 * all of it from `docx-starter-kit.js` — with the chapters a red team report needs instead.
 *
 * The difference is not decoration. A penetration test report is organised around findings: here is
 * what is wrong, ranked. A red team report has to answer two more questions that a findings list
 * cannot, and they are what the client is actually buying:
 *
 *   how did you get there   — the Enumeration chapter, and "how it was found" on every finding
 *   were we seen            — the Detection and Response chapter
 *
 * So those are chapters rather than appendices, and the executive summary leads with them.
 *
 * Editing this script is not the intended workflow — open the generated file in Word and restyle it.
 * It exists so there is always a known-good, fully tagged document to start from.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AlignmentType, PageBreak, Packer, Paragraph, TableOfContents, TableRow } from 'docx';

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
  headerRow,
  hint,
  infoTable,
  para,
  spacer,
  starterDocument,
  table,
  text,
} from '../services/docx-starter-kit.js';

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

/* -------------------------------------------------------------------------- */
/* Front matter                                                               */
/* -------------------------------------------------------------------------- */

function coverPage() {
  return [
    spacer(1200),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [text('RED TEAM OPERATION REPORT', { bold: true, size: 44, color: ACCENT })],
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
      ['Operation window', '{{ .date_start }} — {{ .date_end }}'],
      ['Prepared for', '{{ .client.fullname }}, {{ .client.title }}'],
      ['Operation lead', '{{ .creator.fullname }}'],
      ['Status', '{{ .state }}'],
      ['Classification', "{{ .custom.classification | default:'CONFIDENTIAL' }}"],
    ]),
    spacer(480),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        text(
          'This document describes adversarial activity conducted with written authorisation. It contains confidential information and is intended solely for the recipient named above.',
          { italics: true, size: 18, color: MUTED }
        ),
      ],
    }),
    pageBreak(),
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
      ['Engagement reference', "{{ .reference | default:'—' }}"],
      ['Engagement type', '{{ .auditType }}'],
      ['Operation window', '{{ .dateRange }} ({{ .durationLabel }})'],
      ['Report author', '{{ .creator.fullname }}{{#creator.title}}, {{ .creator.title }}{{/creator.title}} — {{ .creator.email }}'],
      /*
       * The status of the paper itself, which is the row a reader checks first and the one that
       * was missing. "In review" printed on a document somebody is about to forward to a board is
       * worth knowing, and so is the fact that nobody has approved it yet.
       */
      ['Report status', '{{ .stateLabel }}{{#isDraft}} — draft, not for distribution{{/isDraft}}'],
      ['Sign-off', '{{#approved}}Approved by {{ .approvalCount }} reviewer(s){{/approved}}{{^approved}}Not yet approved{{/approved}}{{#staleApprovalCount}} · {{ .staleApprovalCount }} approval(s) predate the latest edit{{/staleApprovalCount}}'],
      ['Issue', "{{#hasDeliveries}}{{ lastDelivery.version | default:'—' }}, issued {{ lastDelivery.date }}{{/hasDeliveries}}{{^hasDeliveries}}Not yet issued{{/hasDeliveries}}"],
      ['Generated', '{{ .now }} by {{ .generatedBy }}'],
      ['Template', '{{ .templateName }}'],
    ]),
    hint(
      'Report status, sign-off and issue come from the engagement itself rather than from anybody remembering to update a table. A document that says "In progress" says so because it is.'
    ),
    spacer(320),

    h2('Operation Team'),
    table([
      headerRow([
        ['Name', 34],
        ['Role', 33],
        ['Email', 33],
      ]),
      // Loop tags opening and closing inside one row make Word repeat that row.
      new TableRow({
        children: [
          cell('{{#collaborators}}{{ .fullname }}', { width: 34 }),
          cell("{{ .title | default:'Operator' }}", { width: 33 }),
          cell('{{ .email }}{{/collaborators}}', { width: 33 }),
        ],
      }),
    ]),
    hint(
      'The row above repeats once per operator, because the loop opens in its first cell and closes in its last. The reviewers and approvals lists work the same way.'
    ),

    /*
     * Who received which version. On a red team this matters more than on a test: the report names
     * live tradecraft, and "who has a copy" is a question somebody will ask months later.
     */
    para('{{#hasDeliveries}}'),
    h2('Distribution'),
    table([
      headerRow([
        ['Version', 16],
        ['Date', 20],
        ['Recipients', 44],
        ['File hash', 20],
      ]),
      new TableRow({
        children: [
          cell('{{#deliveries}}{{ .version }}', { width: 16 }),
          cell('{{ .date }}', { width: 20 }),
          cell('{{ .recipientList }}', { width: 44 }),
          cell('{{ .fileHashShort }}{{/deliveries}}', { width: 20 }),
        ],
      }),
    ]),
    para('{{/hasDeliveries}}'),

    pageBreak(),
  ];
}

function tableOfContents() {
  return [
    h1('Contents'),
    new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-3' }),
    hint('Word builds this list on open — right-click and choose "Update Field" if it looks empty.'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Executive summary                                                          */
/* -------------------------------------------------------------------------- */

function executiveSummary() {
  return [
    h1('Executive Summary'),

    /*
     * The verdict first, in one line, before any prose.
     *
     * An executive summary that opens with three paragraphs before saying how bad it was makes the
     * reader hunt for the answer they came for. The rating is the worst finding's severity, the
     * count beside it is what is still open, and the bar is the same numbers at a glance — a bar
     * rather than the ring here because a summary box is wide and short.
     */
    para('{{#hasFindings}}'),
    infoTable([
      ['Overall rating', '{{ .stats.riskRatingLabel }} — driven by the most serious finding'],
      ['Findings', '{{ .stats.total }} in total: {{ .stats.critical }} critical, {{ .stats.high }} high, {{ .stats.medium }} medium, {{ .stats.low }} low, {{ .stats.info }} informational'],
      ['Still open and serious', '{{ .stats.openSerious }} critical or high finding(s) not yet fixed'],
      ['Highest score', 'CVSS {{ .stats.maxScore }} (mean across all findings: {{ .stats.averageScore }})'],
    ]),
    para('{{@rich.severityBar}}'),
    hint(
      'The bar is drawn by the app from the same counts as the ring further down, in the colours set under Settings. One line, so it fits in a summary box; delete either placeholder if you only want one of them.'
    ),
    para('{{/hasFindings}}'),
    para('{{^hasFindings}}'),
    para(
      'No findings were recorded for this operation. That is a result, and the summary below should say so explicitly rather than leaving a reader to infer it.'
    ),
    para('{{/hasFindings}}'),
    spacer(200),

    para('{{@sections.executive_summary.rich.text}}'),
    hint(
      'The placeholder above pulls in the Executive Summary with full Word formatting — headings, bullet lists, tables and screenshots all survive.'
    ),

    /*
     * What it cost, which is the other number a client compares against what they bought.
     */
    para('{{#hasEffort}}'),
    para(
      'The operation took {{ effort.days }} person-days ({{ effort.hours }} hours) between {{ effort.firstDay }} and {{ effort.lastDay }}.'
    ),
    para('{{/hasEffort}}'),

    /*
     * And what changed about the scope while it was under way — as prose, because this is the
     * paragraph that answers "you never tested X" and a table is not an answer to an accusation.
     */
    para('{{#hasScopeChanges}}'),
    h2('Changes to Scope'),
    para('{{@rich.scopeTimeline}}'),
    hint(
      'One placeholder, the whole dated narrative: which day, what changed, who agreed it and how. The table of the same records is in Scope and Rules of Engagement; print whichever suits the reader, or both.'
    ),
    para('{{/hasScopeChanges}}'),

    /*
     * The two headline numbers a red team is judged on, before the severity table.
     *
     * A findings count answers "what is wrong". It cannot answer "did anybody notice", which on a
     * red team is half the point of having run it — so detection leads, guarded because an operation
     * with nothing logged should say nothing rather than imply a clean sheet.
     */
    para('{{#hasDetection}}'),
    h2('Were We Seen'),
    table(
      [
        headerRow([
          ['Actions taken', 25, AlignmentType.CENTER],
          ['Noticed', 25, AlignmentType.CENTER],
          ['Responded to', 25, AlignmentType.CENTER],
          ['Loud, unanswered', 25, AlignmentType.CENTER],
        ]),
        new TableRow({
          children: [
            cell('{{ detectionSummary.total }}', { width: 25, align: AlignmentType.CENTER }),
            cell('{{ detectionSummary.noticed }} ({{ detectionSummary.noticedPercent }}%)', {
              width: 25,
              align: AlignmentType.CENTER,
            }),
            cell('{{ detectionSummary.responded }} ({{ detectionSummary.respondedPercent }}%)', {
              width: 25,
              align: AlignmentType.CENTER,
            }),
            cell('{{ detectionSummary.loudMisses }} of {{ detectionSummary.loudTotal }}', {
              width: 25,
              align: AlignmentType.CENTER,
            }),
          ],
        }),
      ],
      { columnWidths: [2340, 2340, 2340, 2340] }
    ),
    para(
      'Typical time to notice: {{ detectionSummary.medianDetect }}. Typical time to respond: {{ detectionSummary.medianRespond }}.'
    ),
    hint(
      'Percentages are shares of the actions whose outcome the client actually confirmed, not of everything attempted. Say so in the narrative if the confirmed count is low — the unconfirmed figure is available as a placeholder.'
    ),
    para('{{/hasDetection}}'),

    h2('Findings at a Glance'),
    para('{{@rich.severityChart}}'),
    hint(
      'The ring above is drawn by the app from the severity counts, in the colours set under Settings, with its own legend underneath. Delete the placeholder if you would rather have the table alone — and see Templates → Tag Reference for the one-line variant.'
    ),
    table(
      [
        headerRow([
          ['Severity', 60],
          ['Findings', 40, AlignmentType.CENTER],
        ]),
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

    /*
     * The serious ones on their own, before the full list.
     *
     * A table of forty findings buries the four that matter. This one prints only critical and
     * high, and disappears when there are none — which is itself the most useful thing a summary
     * can say.
     */
    para('{{#hasSerious}}'),
    h2('The Serious Ones'),
    table(
      [
        headerRow([
          ['ID', 10],
          ['Finding', 52],
          ['Severity', 16],
          ['Status', 22],
        ]),
        new TableRow({
          children: [
            cell('{{#criticalFindings}}{{ .id }}', { width: 10 }),
            cell('{{ .title }}', { width: 52 }),
            cell('{{ .severity }}', { width: 16 }),
            cell('{{ .remediationStatusLabel }}{{/criticalFindings}}', { width: 22 }),
          ],
        }),
        new TableRow({
          children: [
            cell('{{#highFindings}}{{ .id }}', { width: 10 }),
            cell('{{ .title }}', { width: 52 }),
            cell('{{ .severity }}', { width: 16 }),
            cell('{{ .remediationStatusLabel }}{{/highFindings}}', { width: 22 }),
          ],
        }),
      ],
      { columnWidths: [936, 4868, 1498, 2058] }
    ),
    hint(
      'Two loops in one table: critical first, then high. Word repeats each row as many times as there are findings in it, so a run with no criticals prints only the high rows.'
    ),
    para('{{/hasSerious}}'),
    spacer(320),

    h2('Summary of Findings'),
    table(
      [
        headerRow([
          ['ID', 10],
          ['Finding', 44],
          ['Severity', 15],
          ['CVSS', 11, AlignmentType.CENTER],
          ['Priority', 12],
          ['Status', 15],
        ]),
        new TableRow({
          children: [
            cell('{{#findings}}{{ .id }}', { width: 10 }),
            cell('{{ .title }}', { width: 37 }),
            cell('{{ .severity }}', { width: 15 }),
            cell('{{ .cvssScore }}', { width: 11, align: AlignmentType.CENTER }),
            cell("{{ .priorityLabel | default:'—' }}", { width: 12 }),
            cell('{{ .remediationStatusLabel }}{{/findings}}', { width: 15 }),
          ],
        }),
      ],
      { columnWidths: [936, 3464, 1404, 1030, 1123, 1403] }
    ),

    /* Where remediation stands, which is the half a severity table cannot show. */
    para('{{#hasFixed}}'),
    para(
      '{{ stats.fixed }} of {{ stats.total }} findings are marked fixed ({{ stats.fixRate }}%), {{ stats.retesting }} are being retested and {{ stats.notFixed }} remain open.'
    ),
    para('{{/hasFixed}}'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Scope, authorisation, approach                                             */
/* -------------------------------------------------------------------------- */

function scopeAndRules() {
  return [
    h1('Scope and Rules of Engagement'),
    para('{{@sections.scope_and_approach.rich.text}}'),
    hint(
      'Say what was authorised and what was explicitly off limits, and where the operation started from — an account, a laptop, a network drop, or nothing at all. A red team report that does not state its starting position cannot be read as evidence of anything.'
    ),

    h2('Assets in Scope'),
    table(
      [
        headerRow([
          ['Hostname', 30],
          ['IP address', 22],
          ['Operating system', 28],
          ['Tested', 20],
        ]),
        new TableRow({
          children: [
            cell('{{#hosts}}{{ .hostname }}', { width: 30 }),
            cell('{{ .ip }}', { width: 22 }),
            cell('{{ .os }}', { width: 28 }),
            cell("{{ .statusLabel | default:'—' }}{{/hosts}}", { width: 20 }),
          ],
        }),
      ],
      { columnWidths: [2808, 2059, 2621, 1872] }
    ),

    /*
     * What changed mid-operation and who agreed to it. On a red team the scope moves — a host turns
     * out to be a third party's, something reachable was never listed — and the closeout argument
     * about it is much shorter when the report already says.
     */
    para('{{#hasScopeChanges}}'),
    h2('Changes During the Operation'),
    table([
      headerRow([
        ['Change', 16],
        ['Summary', 40],
        ['Targets', 20],
        ['Agreed with', 24],
      ]),
      new TableRow({
        children: [
          cell('{{#scopeChanges}}{{ .kindLabel }}', { width: 16 }),
          cell('{{ .summary }}', { width: 40 }),
          cell('{{ .targetList }}', { width: 20 }),
          cell('{{ .agreedBy }} — {{ .agreedOn }}{{/scopeChanges}}', { width: 24 }),
        ],
      }),
    ]),
    para('{{/hasScopeChanges}}'),

    h1('Approach and Tradecraft'),
    para('{{@sections.methodology.rich.text}}'),

    h1('Risk Rating'),
    para('{{@sections.risk_rating.rich.text}}'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Enumeration                                                                */
/* -------------------------------------------------------------------------- */

function enumerationDetail() {
  return [
    /*
     * A chapter, not an appendix.
     *
     * On a red team the route matters as much as the destination, and this is the only place the
     * report can show it. Guarded all the same, so the same template still works on an operation
     * where nothing was recorded here.
     */
    para('{{#hasEnumeration}}'),
    h1('Enumeration'),
    hint(
      'How the ground was mapped, in the order it was mapped. Everything between the loop markers repeats once per row — sections print as headings, the tools under them as steps.'
    ),
    para('Tooling used: {{ enumerationSummary.toolList }}'),
    para(
      '{{ enumerationSummary.steps }} steps recorded across {{ enumerationSummary.groups }} sections, {{ enumerationSummary.withOutput }} with tool output, {{ enumerationSummary.ledToFindings }} written up as findings.'
    ),
    para('Outcomes: {{#enumerationSummary.byStatus}}{{ .count }} {{ .label }}. {{/enumerationSummary.byStatus}}'),
    para(
      '{{#enumerationSummary.internal}}{{ enumerationSummary.internal }} further step(s) were recorded internally and are not reproduced here.{{/enumerationSummary.internal}}'
    ),
    spacer(240),

    para('{{#enumeration}}'),

    /* A heading and a step print differently; `isGroup` is how a template asks which this is. */
    para('{{#isGroup}}'),
    h2('{{ .number }}  {{ .title }}'),
    para('{{#hasSummary}}{{ .summary }}{{/hasSummary}}'),
    para('{{/isGroup}}'),

    para('{{^isGroup}}'),
    h3('{{ .number }}  {{ .title }}'),
    para("Tool: {{ .tool | default:'—' }}   ·   Target: {{ .target | default:'—' }}   ·   {{ .ranAt }}"),
    para('{{#phaseLabel}}Phase: {{ .phaseLabel }}{{/phaseLabel}}'),
    para('{{#statusLabel}}Outcome: {{ .statusLabel }}{{/statusLabel}}'),
    para('{{#hasSummary}}{{ .summary }}{{/hasSummary}}'),

    para('{{#hasCommand}}'),
    para('{{ .command }}'),
    para('{{/hasCommand}}'),

    /* A table where the output's shape was recognised, the raw pane where it was not. */
    para('{{#hasTable}}'),
    para('{{@rich.outputTable}}'),
    para('{{/hasTable}}'),

    para('{{^hasTable}}'),
    para('{{#hasOutput}}'),
    para('{{@rich.output}}'),
    para('{{/hasOutput}}'),
    para('{{/hasTable}}'),

    para(
      '{{#printTruncated}}Extract only — {{ .printOmitted }} of {{ .printTotal }} {{ .printUnit }} are not printed.{{/printTruncated}}'
    ),

    /*
     * The lines somebody marked, under the output they were marked in.
     *
     * Placed after the pane and before the write-up: the notes are about the output immediately
     * overhead, and the prose that follows is what they add up to. Each carries the line text as
     * well as the number, which is what makes them survive a capped pane — the note above may be
     * saying that most of the sweep was left out, and the marked line still reaches the reader.
     */
    para('{{#hasNotes}}'),
    para('Of note in the output above:'),
    para('{{@rich.notes}}'),
    para('{{/hasNotes}}'),

    para('{{#hasContent}}'),
    para('{{@rich.content}}'),
    para('{{/hasContent}}'),

    para('{{#hasLedTo}}'),
    para('Written up as: {{#ledToFindings}}{{ .identifier }} {{ .title }}{{/ledToFindings}}'),
    para('{{/hasLedTo}}'),

    para('{{/isGroup}}'),
    para('{{/enumeration}}'),
    para('{{/hasEnumeration}}'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Detection and response                                                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The operation, in one order                                                */
/* -------------------------------------------------------------------------- */

/**
 * What happened, when, and whether anybody noticed — the four logs as one chronology.
 *
 * A red team report has always been able to print four separate tables: the steps that were run,
 * the campaign's results, the detection log, and the scope changes. A reader wanting the story had
 * to interleave them by eye, which is the work the narrative was supposed to do for them. This is
 * that merge, and it goes *before* the detail chapters deliberately: the argument is made here and
 * evidenced there.
 *
 * The two sentences under the table are the ones a readout turns on — how long the operation ran
 * before anybody noticed anything, and the longest stretch in which nobody did. Neither is
 * knowable from any single one of the four logs.
 */
function operationTimeline() {
  return [
    para('{{#hasTimeline}}'),
    h1('The Operation'),
    hint(
      'Everything with a time on it, in one order: steps that were run, what the campaign did, what the client noticed, when the scope moved and when the report went. The chapters after this one are the detail behind it.'
    ),

    para(
      'The operation ran from {{ timelineSummary.firstAction | date }} to {{ timelineSummary.to | date }}. ' +
        '{{#timelineSummary.timeToFirstNoticedLabel}}The first action anybody noticed came ' +
        '{{ timelineSummary.timeToFirstNoticedLabel }} after the first action we took.{{/timelineSummary.timeToFirstNoticedLabel}}' +
        '{{^timelineSummary.timeToFirstNoticedLabel}}Nothing in this operation was noticed.{{/timelineSummary.timeToFirstNoticedLabel}}'
    ),
    para(
      '{{#timelineSummary.longestQuiet}}The longest stretch in which nothing was noticed lasted ' +
        '{{ timelineSummary.longestQuiet.label }}.{{/timelineSummary.longestQuiet}}'
    ),
    spacer(240),

    table(
      [
        headerRow([
          ['When', 18],
          ['What', 40],
          ['Detail', 24],
          ['Noticed', 18],
        ]),
        new TableRow({
          children: [
            cell('{{#timeline}}{{ .when }}', { width: 18 }),
            cell('{{ .label }}', { width: 40 }),
            cell('{{ .detail }}', { width: 24 }),
            cell('{{ .note }}{{/timeline}}', { width: 18 }),
          ],
        }),
      ],
      { columnWidths: [1690, 3630, 2180, 1660] }
    ),
    spacer(200),
    /*
     * Said rather than hidden. A step with no recorded run time is left out of the order above,
     * because placing it by when somebody wrote it up would put a false event in the one table
     * whose whole value is the sequence — so the count goes in the document instead.
     */
    para(
      '{{#timelineSkipped.runs}}{{ timelineSkipped.runs }} further step(s) were run without a ' +
        'recorded time and are not placed above; they appear in the Enumeration chapter.' +
        '{{/timelineSkipped.runs}}'
    ),

    para('{{/hasTimeline}}'),
    pageBreak(),
  ];
}

function detectionDetail() {
  return [
    para('{{#hasDetection}}'),
    h1('Detection and Response'),
    hint(
      'What the operators did and whether the client saw it. This is the half of a red team report a findings list cannot give, and the table clients read twice is the one below it.'
    ),

    h2('Outcomes'),
    table([
      headerRow([
        ['Outcome', 50],
        ['Actions', 25, AlignmentType.CENTER],
        ['Share', 25, AlignmentType.CENTER],
      ]),
      new TableRow({
        children: [
          cell('{{#detectionSummary.byOutcome}}{{ .label }}', { width: 50 }),
          cell('{{ .count }}', { width: 25, align: AlignmentType.CENTER }),
          cell('{{ .percent }}%{{/detectionSummary.byOutcome}}', {
            width: 25,
            align: AlignmentType.CENTER,
          }),
        ],
      }),
    ]),
    spacer(240),
    para(
      '{{ detectionSummary.confirmed }} of {{ detectionSummary.total }} outcomes were confirmed with the client; {{ detectionSummary.unconfirmed }} remain open questions.'
    ),
    spacer(320),

    h2('Timeline'),
    table(
      [
        headerRow([
          ['When', 16],
          ['Action', 30],
          ['Target', 22],
          ['Outcome', 18],
          ['Noticed after', 14],
        ]),
        new TableRow({
          children: [
            cell('{{#detection}}{{ .at }}', { width: 16 }),
            cell('{{ .action }}', { width: 30 }),
            cell('{{ .target }}', { width: 22 }),
            cell('{{ .outcomeLabel }}', { width: 18 }),
            cell("{{ .detectionLatency | default:'—' }}{{/detection}}", { width: 14 }),
          ],
        }),
      ],
      { columnWidths: [1498, 2808, 2059, 1685, 1310] }
    ),
    hint('Oldest first, so the table reads as the operation happened.'),

    /*
     * The deliberately loud actions nothing answered. Usually the most valuable page in the report:
     * it is the difference between "they did not see us" and "they could not have seen us".
     */
    h2('Loud Actions That Went Unanswered'),
    table([
      headerRow([
        ['When', 18],
        ['Action', 40],
        ['Target', 24],
        ['Noise', 18],
      ]),
      new TableRow({
        children: [
          cell('{{#detectionLoudMisses}}{{ .at }}', { width: 18 }),
          cell('{{ .action }}', { width: 40 }),
          cell('{{ .target }}', { width: 24 }),
          cell('{{ .noiseLabel }}{{/detectionLoudMisses}}', { width: 18 }),
        ],
      }),
    ]),
    para(
      '{{ detectionSummary.loudMisses }} of {{ detectionSummary.loudTotal }} deliberately loud actions drew no response. {{ detectionSummary.quietCatches }} quiet action(s) were caught anyway.'
    ),
    spacer(320),

    h2('Coverage by Technique'),
    table([
      headerRow([
        ['Technique', 34],
        ['Actions', 14, AlignmentType.CENTER],
        ['Confirmed', 16, AlignmentType.CENTER],
        ['Noticed', 18, AlignmentType.CENTER],
        ['Responded', 18, AlignmentType.CENTER],
      ]),
      new TableRow({
        children: [
          cell('{{#detectionSummary.techniques}}{{ .technique }}', { width: 34 }),
          cell('{{ .total }}', { width: 14, align: AlignmentType.CENTER }),
          cell('{{ .confirmed }}', { width: 16, align: AlignmentType.CENTER }),
          cell('{{#rated}}{{ .noticedPercent }}%{{/rated}}', {
            width: 18,
            align: AlignmentType.CENTER,
          }),
          cell('{{#rated}}{{ .respondedPercent }}%{{/rated}}{{/detectionSummary.techniques}}', {
            width: 18,
            align: AlignmentType.CENTER,
          }),
        ],
      }),
    ]),
    hint(
      'The percentage columns are wrapped in a guard, because a technique with nothing confirmed has no rate — printing 0% would accuse the client of a failure nobody established.'
    ),
    para('{{/hasDetection}}'),

    /* Social engineering, when the operation included a campaign. */
    para('{{#hasPhishing}}'),
    h1('Social Engineering'),
    para(
      '{{ phishingSummary.sent }} message(s) sent, {{ phishingSummary.reached }} delivered. {{ phishingSummary.opened }} opened ({{ phishingSummary.openedPercent }}%), {{ phishingSummary.clicked }} clicked ({{ phishingSummary.clickedPercent }}%), {{ phishingSummary.phished }} were phished ({{ phishingSummary.phishedPercent }}%), {{ phishingSummary.reported }} reported it ({{ phishingSummary.reportedPercent }}%).'
    ),
    para(
      'Typical time to a click: {{ phishingSummary.medianClick }}. First person phished after {{ phishingSummary.firstPhishMinutes }} minutes; first report after {{ phishingSummary.firstReportMinutes }} minutes.'
    ),
    para(
      '{{#phishingSummary.reportedBeforeFirstPhish}}Somebody reported the campaign before anybody was phished, which is the outcome worth saying out loud.{{/phishingSummary.reportedBeforeFirstPhish}}'
    ),
    spacer(240),
    h2('By Department'),
    table([
      headerRow([
        ['Department', 34],
        ['Sent', 16, AlignmentType.CENTER],
        ['Clicked', 16, AlignmentType.CENTER],
        ['Phished', 17, AlignmentType.CENTER],
        ['Reported', 17, AlignmentType.CENTER],
      ]),
      new TableRow({
        children: [
          cell('{{#phishingSummary.departments}}{{ .department }}', { width: 34 }),
          cell('{{ .sent }}', { width: 16, align: AlignmentType.CENTER }),
          cell('{{ .clicked }}', { width: 16, align: AlignmentType.CENTER }),
          cell('{{ .phished }}', { width: 17, align: AlignmentType.CENTER }),
          cell('{{ .reported }}{{/phishingSummary.departments}}', {
            width: 17,
            align: AlignmentType.CENTER,
          }),
        ],
      }),
    ]),
    hint(
      'Individual names are deliberately not printed here. The per-person list is available as a loop if your client has asked for it, but a report that names the people who clicked is a report that gets used for the wrong thing.'
    ),
    para('{{/hasPhishing}}'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function findingDetail() {
  const metricsTable = table(
    [
      new TableRow({
        children: [
          cell('Severity', { width: 22, fill: HEADER_FILL, bold: true }),
          cell('{{ .severityLabel }} ({{ .cvssScore }})', { width: 28 }),
          cell('Priority', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .priorityLabel | default:'—' }}", { width: 28 }),
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
      /*
       * Effort and status beside the score.
       *
       * "Critical" tells a client how bad it is; it does not tell them whether fixing it is an
       * afternoon or a quarter, and that is the pair a remediation meeting actually works from.
       * Status belongs here too, because a report is read months after it was written and a
       * finding marked fixed reads very differently from one that is not.
       */
      new TableRow({
        children: [
          cell('Remediation effort', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .remediationComplexityLabel | default:'—' }}", { width: 28 }),
          cell('Status', { width: 22, fill: HEADER_FILL, bold: true }),
          cell('{{ .remediationStatusLabel }}', { width: 28 }),
        ],
      }),
      /*
       * The vector, spelled out, with the version it was scored under.
       *
       * This is the row that makes a score arguable rather than asserted: a client who disagrees
       * with "High" can see exactly which metrics produced it. The sub-scores are 3.1 only and
       * print empty on 4.0, which publishes none — guarded so the row disappears instead.
       */
      new TableRow({
        children: [
          cell('CVSS v{{ .cvssVersion }}', { width: 22, fill: HEADER_FILL, bold: true }),
          cell('{{ .cvssVector }}', { width: 78, columnSpan: 3 }),
        ],
      }),
      new TableRow({
        children: [
          cell('Sub-scores', { width: 22, fill: HEADER_FILL, bold: true }),
          cell(
            "{{#cvss.impact}}Impact {{ .cvss.impact }} · Exploitability {{ .cvss.exploitability }}{{/cvss.impact}}{{^cvss.impact}}Not published for this CVSS version{{/cvss.impact}}",
            { width: 78, columnSpan: 3 }
          ),
        ],
      }),
      /* Evidence, so a reader knows whether there are screenshots below before scrolling. */
      new TableRow({
        children: [
          cell('Evidence', { width: 22, fill: HEADER_FILL, bold: true }),
          cell(
            "{{#hasEvidence}}{{ .evidenceCount }} figure(s){{/hasEvidence}}{{^hasEvidence}}None attached{{/hasEvidence}}",
            { width: 28 }
          ),
          cell('Written by', { width: 22, fill: HEADER_FILL, bold: true }),
          cell("{{ .author | default:'—' }}", { width: 28 }),
        ],
      }),
    ],
    { columnWidths: [2059, 2621, 2059, 2621] }
  );

  return [
    h1('Findings'),
    hint(
      'Everything between the two loop markers below repeats once per finding, ordered by CVSS score. The markers themselves disappear when the report is generated.'
    ),
    para('{{#findings}}'),
    h2('{{ .id }} — {{ .title }}'),
    metricsTable,
    spacer(240),

    /*
     * Told before, and not fixed.
     *
     * The single most consequential sentence a report can carry, and the one nobody could write
     * without going back through last year's PDFs. Silent unless this client really was told.
     */
    para('{{#previouslyReported}}'),
    para(
      'This client was first told about this issue on {{ .firstReported }}. Earlier reports: {{#previously}}{{ .reference }} ({{ .date }}, {{ .severity }}){{/previously}}'
    ),
    hint(
      'Matched on the finding title across this client\u2019s other engagements, so it is inference rather than a link — but it is the inference a renewal conversation turns on.'
    ),
    para('{{/previouslyReported}}'),

    h3('Description'),
    para('{{@rich.description}}'),

    h3('Affected Assets'),
    para('{{@rich.scope}}'),

    /*
     * Where it came from. The first question in a red team readout, and until the Enumeration tab
     * existed the answer lived in somebody's memory of the week. Silent when nothing was recorded.
     */
    para('{{#hasDiscoveredBy}}'),
    h3('How It Was Found'),
    para('{{#discoveredBy}}{{ .title }}{{#tool}} — {{ .tool }}{{/tool}}{{/discoveredBy}}'),
    para('{{/hasDiscoveredBy}}'),

    h3('Proof of Concept'),
    para('{{@rich.poc}}'),

    h3('Impact'),
    para('{{@rich.observation}}'),

    h3('Remediation'),
    para('{{@rich.remediation}}'),

    h3('References'),
    para('{{@rich.references}}'),

    para('{{/findings}}'),
    pageBreak(),
  ];
}

/* -------------------------------------------------------------------------- */
/* Closing                                                                    */
/* -------------------------------------------------------------------------- */

function closing() {
  return [
    /*
     * What was intended, and how much of it happened. On a red team an operation often stops early —
     * the objective was met, or the window closed — and a coverage table is what keeps "we did not
     * get to it" from reading as "it was fine".
     */
    para('{{#hasChecks}}'),
    h1('Coverage'),
    para(
      '{{ checkStats.done }} of {{ checkStats.total }} planned checks were completed ({{ checkStats.percent }}%); {{ checkStats.outstanding }} outstanding.'
    ),
    table([
      headerRow([
        ['Area', 30],
        ['Check', 44],
        ['Done', 12, AlignmentType.CENTER],
        ['Verified by', 14],
      ]),
      new TableRow({
        children: [
          cell('{{#testChecks}}{{ .category }}', { width: 30 }),
          cell('{{ .title }}{{#blockedReason}} — blocked: {{ .blockedReason }}{{/blockedReason}}', {
            width: 44,
          }),
          cell('{{ .status }}', { width: 12, align: AlignmentType.CENTER }),
          cell("{{ .verifiedBy | default:'—' }}{{/testChecks}}", { width: 14 }),
        ],
      }),
    ]),
    para('{{/hasChecks}}'),

    /*
     * What was assumed, and what nobody could answer.
     *
     * A red team runs on unanswered questions — whether that host is production, whether the
     * client's own staff were told — and the answers get assumed out loud in a call and then
     * forgotten. Printed here they are part of the record rather than part of the argument.
     */
    para('{{#hasAssumptions}}'),
    h1('Assumptions and Limitations'),
    table([
      headerRow([
        ['Assumed', 56],
        ['Asked of', 20],
        ['Basis', 24],
      ]),
      new TableRow({
        children: [
          cell('{{#assumptions}}{{ .text }}', { width: 56 }),
          cell("{{ .askedOf | default:'—' }}", { width: 20 }),
          cell("{{ .answer | default:'Assumed, unanswered' }}{{/assumptions}}", { width: 24 }),
        ],
      }),
    ]),
    hint(
      'Only the questions somebody marked as printable appear here. The rest stay internal — see the Questions tab.'
    ),
    para('{{/hasAssumptions}}'),

    h1('Conclusion'),
    para('{{@sections.conclusion.rich.text}}'),

    h1('Appendix'),
    para('{{@sections.appendix.rich.text}}'),

    /*
     * The asset inventory, as an appendix rather than in the scope chapter.
     *
     * Scope up front is the agreement — a paragraph a reader skims. This is the list a client's
     * own engineers work from afterwards, which is a different document for a different person,
     * and it belongs at the back where a long table does no harm.
     */
    para('{{#hasScope}}'),
    h2('Appendix — Assets in Scope'),
    para(
      '{{ scopeStats.hosts }} host(s) across {{ scopeStats.groups }} group(s), {{ scopeStats.services }} recorded service(s) on {{ scopeStats.ports }} distinct port(s).'
    ),
    table([
      headerRow([
        ['Group', 24],
        ['Hostname', 30],
        ['Address', 22],
        ['Platform', 24],
      ]),
      new TableRow({
        children: [
          cell('{{#scope}}{{ .name }}', { width: 24 }),
          cell('{{#hosts}}{{ .hostname }}', { width: 30 }),
          cell('{{ .ip }}', { width: 22 }),
          cell("{{ .os | default:'—' }}{{/hosts}}{{/scope}}", { width: 24 }),
        ],
      }),
    ]),
    para('{{#services}}'),
    para('Open ports observed: {{ .portList }}'),
    para('{{/services}}'),
    hint(
      'Two nested loops: the outer one repeats per scope group, the inner per host inside it. Word repeats the row for each pass, so a group with nine hosts prints nine rows.'
    ),
    para('{{/hasScope}}'),

    /*
     * How the effort was actually spent, per person. The summary line up front is the total; a
     * client comparing against what they bought usually wants to see it broken down.
     */
    para('{{#hasEffort}}'),
    h2('Appendix — Effort'),
    table([
      headerRow([
        ['Who', 44],
        ['Role', 26],
        ['Hours', 15, AlignmentType.CENTER],
        ['Person-days', 15, AlignmentType.CENTER],
      ]),
      new TableRow({
        children: [
          cell('{{#effort.people}}{{ .name }}', { width: 44 }),
          cell("{{ .title | default:'Operator' }}", { width: 26 }),
          cell('{{ .hours }}', { width: 15, align: AlignmentType.CENTER }),
          cell('{{ .effortDays }}{{/effort.people}}', { width: 15, align: AlignmentType.CENTER }),
        ],
      }),
    ]),
    para('{{/hasEffort}}'),

    /* Sign-off, where the engagement recorded one. */
    para('{{#hasSignatures}}'),
    h2('Sign-off'),
    para('{{@rich.signatures}}'),
    para('{{/hasSignatures}}'),

    h2('About This Template'),
    para(undefined, {
      runs: [
        text(
          'This is an ordinary Word document. Restyle it however you like — change fonts, colours, page layout, add a cover image, move chapters around. Only two things matter: keep the placeholders you want filled in, and keep the built-in Heading, List Paragraph, Quote and Caption styles available, because rich text from the app maps onto them.',
          { size: 19 }
        ),
      ],
    }),
    para(undefined, {
      runs: [
        text(
          'Every chapter that only applies sometimes is wrapped in a guard, so this one template covers an operation with no phishing, no detection log and no enumeration as well as one with all three. Nothing prints an empty heading.',
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
    title: 'Red Team Operation Report Template',
    description:
      'Starter red team template for Engy Report — every placeholder uses {{ .tag }} syntax.',
    body: [
      ...coverPage(),
      ...documentControl(),
      ...tableOfContents(),
      ...executiveSummary(),
      ...scopeAndRules(),
      /* The narrative first; the two chapters after it are the evidence for it. */
      ...operationTimeline(),
      ...enumerationDetail(),
      ...detectionDetail(),
      ...findingDetail(),
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
        path.join(env.storage.templates, 'engy-redteam-template.docx'),
        path.join(ROOT_DIR, 'DEFAULT_RED_TEAM_REPORT.docx'),
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
