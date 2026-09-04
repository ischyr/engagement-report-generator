/**
 * The findings, as a spreadsheet.
 *
 * The report is the deliverable; the *tracker* a client's remediation team actually lives
 * in is a spreadsheet, and until now they built it by hand from the PDF — retyping forty
 * rows, losing the CVSS vectors, and inventing their own ids. This is the same findings,
 * one row each, in the file they were going to make anyway.
 *
 * Built from `buildReportData`, not from the audit document, so the ids, the dates, the
 * severities and the recurrence data are the ones the report prints. A tracker that
 * disagreed with the report it came from would be worse than no tracker.
 */

import { buildReportData } from './report.service.js';
import { buildXlsx, STYLE } from './ooxml/xlsx.js';

/** Column order, width and where the value comes from. */
const COLUMNS = [
  { header: 'ID', width: 11, of: (finding) => finding.id },
  { header: 'Title', width: 46, of: (finding) => finding.title },
  { header: 'Severity', width: 11, of: (finding) => finding.severity, severity: true },
  { header: 'CVSS', width: 7, of: (finding) => finding.cvss.baseScore },
  { header: 'Vector', width: 44, of: (finding) => finding.cvss.vector, wrap: true },
  { header: 'Category', width: 18, of: (finding) => finding.category },
  { header: 'Type', width: 18, of: (finding) => finding.vulnType },
  { header: 'Affected assets', width: 32, of: (finding) => finding.scope, wrap: true },
  { header: 'Status', width: 12, of: (finding) => finding.remediationStatusLabel },
  { header: 'Priority', width: 12, of: (finding) => finding.priorityLabel },
  { header: 'Effort', width: 12, of: (finding) => finding.remediationComplexityLabel },
  { header: 'Description', width: 60, of: (finding) => finding.description, wrap: true },
  { header: 'Impact', width: 46, of: (finding) => finding.observation, wrap: true },
  { header: 'Remediation', width: 60, of: (finding) => finding.remediation, wrap: true },
  { header: 'References', width: 34, of: (finding) => finding.referencesText, wrap: true },
  /* The recurrence work, where it is most useful: a client's own tracker saying "you were
     told about this in March" carries more weight than the same sentence in our report. */
  {
    header: 'Reported before',
    width: 22,
    of: (finding) => finding.previouslyIn,
  },
  { header: 'First reported', width: 14, of: (finding) => finding.firstReported },
  { header: 'Written by', width: 20, of: (finding) => finding.author },
];

/** Severity → the fill index in the workbook's own palette. */
const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'None'];

/**
 * @returns {{buffer: Buffer, filename: string, findings: number}}
 */
export function buildFindingsSheet({ audit, settings, user, history }) {
  const data = buildReportData(
    audit,
    settings,
    { parts: null, numbering: null },
    // `html` rather than `docx`: this needs the plain-text fields, and the docx target
    // would convert every rich field into WordprocessingML nobody is going to read.
    { target: 'html', user, history, templateName: 'Findings spreadsheet' }
  );

  const colours = settings?.report?.public?.cvssColors ?? {};
  const fills = [
    colours.criticalColor ?? 'D02D2D',
    colours.highColor ?? 'FE6C00',
    colours.mediumColor ?? 'F9A009',
    colours.lowColor ?? '008000',
    colours.noneColor ?? '4A86E8',
  ].map((hex) => String(hex).replace('#', '').toUpperCase().padEnd(6, '0').slice(0, 6));

  const severityStyle = (severity) => {
    const at = SEVERITY_ORDER.indexOf(severity);
    return at === -1 ? STYLE.plain : STYLE.firstFill + at;
  };

  const findingRows = data.findings.map((finding) =>
    COLUMNS.map((column) => {
      const value = column.of(finding) ?? '';
      if (column.severity) return { value, style: severityStyle(value) };
      if (column.wrap) return { value, style: STYLE.wrapped };
      return value;
    })
  );

  /*
   * A summary sheet first, because the person who opens this is usually looking for the
   * shape of it — how many of what, and whether any of it is a repeat — before reading
   * forty rows. Every number comes from the same report data, so it cannot drift from the
   * document that accompanies it.
   */
  const summary = [
    [{ value: 'Engagement', style: STYLE.bold }, data.name],
    [{ value: 'Reference', style: STYLE.bold }, data.reference],
    [{ value: 'Client', style: STYLE.bold }, data.company.name],
    [{ value: 'Testing window', style: STYLE.bold }, data.dateRange],
    [{ value: 'Report date', style: STYLE.bold }, data.date],
    [{ value: 'Status', style: STYLE.bold }, data.stateLabel],
    [],
    [{ value: 'Findings by severity', style: STYLE.bold }],
    ...SEVERITY_ORDER.map((severity) => [
      { value: severity === 'None' ? 'Informational' : severity, style: severityStyle(severity) },
      data.stats.bySeverity.find((row) => row.severity === severity)?.count ?? 0,
    ]),
    [{ value: 'Total', style: STYLE.bold }, data.stats.total],
    [],
    [{ value: 'Remediation', style: STYLE.bold }],
    ['Not fixed', data.stats.open],
    ['Retesting', data.stats.retesting],
    ['Fixed', data.stats.fixed],
    [],
    [{ value: 'Reported in an earlier engagement', style: STYLE.bold }, data.stats.repeats],
    [{ value: 'Exported', style: STYLE.bold }, data.generatedAt],
    [{ value: 'Exported by', style: STYLE.bold }, data.generatedBy],
  ];

  const buffer = buildXlsx({
    fills,
    sheets: [
      { name: 'Summary', rows: summary, widths: [34, 46] },
      {
        name: 'Findings',
        rows: [
          COLUMNS.map((column) => ({ value: column.header, style: STYLE.header })),
          ...findingRows,
        ],
        widths: COLUMNS.map((column) => column.width),
        freezeHeader: true,
        autofilter: true,
      },
    ],
  });

  const label = [data.reference, data.name].filter(Boolean).join(' — ') || 'engagement';
  return { buffer, filename: `Findings — ${label}.xlsx`, findings: data.findings.length };
}

export default buildFindingsSheet;
