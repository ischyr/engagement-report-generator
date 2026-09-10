/**
 * The enumeration, as a spreadsheet.
 *
 * The same argument as the findings tracker beside it. A client's technical reviewer wants to sort
 * the enumeration by tool, filter it to what came back with something, and paste the interesting
 * hosts into their own ticket queue — none of which a .docx chapter allows, so they retype it. This
 * is the file they were going to build anyway.
 *
 * Built from `buildReportData`, not from the tree, for the same reason the findings sheet is: the
 * numbering, the resolved commands and the held-back rows have to be the ones the report used, or
 * the appendix and the document it arrives with would disagree about what happened.
 *
 * Three sheets, because the enumeration answers three different questions:
 *
 *   Summary   — how much of what, which tools, what came of it
 *   Steps     — one row per step, the thing you sort and filter
 *   Marked lines — the lines somebody picked out of the output, with what they said
 *
 * The third is the one a .docx cannot really carry: a hundred marked lines across sixty steps is a
 * list, and a list belongs in a column.
 */

import { buildReportData } from './report.service.js';
import { buildXlsx, STYLE } from './ooxml/xlsx.js';

/** Column order, width and where the value comes from. */
const COLUMNS = [
  { header: 'No.', width: 8, of: (step) => step.number },
  { header: 'Level', width: 7, of: (step) => step.level },
  { header: 'Title', width: 42, of: (step) => step.title },
  { header: 'Phase', width: 20, of: (step) => step.phaseLabel },
  { header: 'Tool', width: 16, of: (step) => step.tool },
  { header: 'Target', width: 30, of: (step) => step.target, wrap: true },
  /*
   * The resolved command, not the authored one. A spreadsheet is where somebody goes to copy a
   * command and run it again, and `$TARGET` is not runnable.
   */
  { header: 'Command', width: 58, of: (step) => step.command, wrap: true },
  { header: 'Outcome', width: 15, of: (step) => step.statusLabel },
  { header: 'Output lines', width: 12, of: (step) => step.outputLines },
  { header: 'Table rows', width: 11, of: (step) => step.tableRowCount },
  { header: 'Marked lines', width: 12, of: (step) => step.noteCount },
  { header: 'Ran', width: 20, of: (step) => step.ranAt },
  /* When the output was actually pasted, which is the only field that can say "this is stale". */
  { header: 'Output age (days)', width: 16, of: (step) => step.outputAge },
  { header: 'Summary', width: 50, of: (step) => step.summary, wrap: true },
  {
    header: 'Became a finding',
    width: 26,
    of: (step) => step.ledToFindings.map((f) => [f.identifier, f.title].filter(Boolean).join(' ')).join('; '),
    wrap: true,
  },
  { header: 'Write-up', width: 60, of: (step) => step.content, wrap: true },
  { header: 'Recorded by', width: 20, of: (step) => step.author },
];

/**
 * @param {{audit: object, settings: object, user: object, enumerationBodies: Map}} input
 * @returns {{buffer: Buffer, filename: string, steps: number}}
 */
export function buildEnumerationSheet({ audit, settings, user, enumerationBodies }) {
  const data = buildReportData(
    audit,
    settings,
    { parts: null, numbering: null },
    /*
     * `html` rather than `docx`: this wants the plain-text fields. The docx target would turn every
     * write-up into WordprocessingML, which is not a thing to put in a cell.
     */
    { target: 'html', user, templateName: 'Enumeration spreadsheet', enumerationBodies }
  );

  const steps = data.enumeration ?? [];
  const summaryData = data.enumerationSummary ?? {};

  const stepRows = steps.map((step) =>
    COLUMNS.map((column) => {
      const value = column.of(step) ?? '';
      if (column.wrap) return { value, style: STYLE.wrapped };
      return value;
    })
  );

  /*
   * One row per marked line rather than per step, so the whole set can be read down a column. A
   * step with four marked lines gets four rows, each carrying enough of its step to stand alone —
   * which is what makes the sheet sortable by anything.
   */
  const noteRows = [];
  for (const step of steps) {
    for (const note of step.notes ?? []) {
      noteRows.push([
        step.number,
        step.title,
        step.tool,
        note.line,
        { value: note.snippet, style: STYLE.wrapped },
        { value: note.text, style: STYLE.wrapped },
      ]);
    }
  }

  const summary = [
    [{ value: 'Engagement', style: STYLE.bold }, data.name],
    [{ value: 'Reference', style: STYLE.bold }, data.reference],
    [{ value: 'Client', style: STYLE.bold }, data.company?.name ?? ''],
    [{ value: 'Testing window', style: STYLE.bold }, data.dateRange],
    [{ value: 'Report date', style: STYLE.bold }, data.date],
    [],
    [{ value: 'Steps recorded', style: STYLE.bold }, summaryData.steps ?? 0],
    [{ value: 'Sections', style: STYLE.bold }, summaryData.groups ?? 0],
    [{ value: 'With tool output', style: STYLE.bold }, summaryData.withOutput ?? 0],
    [{ value: 'Output read as a table', style: STYLE.bold }, summaryData.withTable ?? 0],
    [{ value: 'With a marked line', style: STYLE.bold }, summaryData.withNotes ?? 0],
    [{ value: 'Marked lines in total', style: STYLE.bold }, summaryData.notes ?? 0],
    [{ value: 'Written up as findings', style: STYLE.bold }, summaryData.ledToFindings ?? 0],
    [],
    [{ value: 'Tooling used', style: STYLE.bold }, summaryData.toolList ?? ''],
    [],
    [{ value: 'Outcomes', style: STYLE.bold }],
    ...(summaryData.byStatus ?? []).map((row) => [row.label, row.count]),
    [],
    [{ value: 'Phases', style: STYLE.bold }],
    ...(data.enumerationPhases ?? []).map((phase) => [phase.label, phase.count]),
    [],
    /*
     * Said on the sheet itself, because a spreadsheet gets forwarded away from the report that
     * explains it. A reader who does not know rows were held back would read this as everything.
     */
    ...(summaryData.internal
      ? [
          [
            { value: 'Not included', style: STYLE.bold },
            `${summaryData.internal} step(s) marked internal are omitted, as they are from the report`,
          ],
          [],
        ]
      : []),
    [{ value: 'Exported', style: STYLE.bold }, data.generatedAt],
    [{ value: 'Exported by', style: STYLE.bold }, data.generatedBy],
  ];

  const NOTE_WIDTHS = [8, 34, 14, 8, 58, 50];

  const buffer = buildXlsx({
    sheets: [
      { name: 'Summary', rows: summary, widths: [34, 46] },
      {
        name: 'Steps',
        rows: [
          COLUMNS.map((column) => ({ value: column.header, style: STYLE.header })),
          ...stepRows,
        ],
        widths: COLUMNS.map((column) => column.width),
        freezeHeader: true,
        autofilter: true,
      },
      /* Only when there are any: an empty sheet with headings is a thing to explain, not a feature. */
      ...(noteRows.length
        ? [
            {
              name: 'Marked lines',
              rows: [
                ['No.', 'Step', 'Tool', 'Line', 'The line', 'Note'].map((header) => ({
                  value: header,
                  style: STYLE.header,
                })),
                ...noteRows,
              ],
              widths: NOTE_WIDTHS,
              freezeHeader: true,
              autofilter: true,
            },
          ]
        : []),
    ],
  });

  const label = [data.reference, data.name].filter(Boolean).join(' — ') || 'engagement';
  return { buffer, filename: `Enumeration — ${label}.xlsx`, steps: steps.length };
}

export default buildEnumerationSheet;
