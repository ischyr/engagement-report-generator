/**
 * The findings as a CSV their own tracker will import.
 *
 * `findings-sheet.service.js` already argues that the tracker a remediation team lives in is a
 * spreadsheet rather than the report. This is the next step of the same argument: the team that
 * lives in Jira does not want a spreadsheet either, they want twenty-three tickets, and somebody
 * currently makes those by hand from the .xlsx — retyping the summaries, guessing at priorities,
 * and losing the link back to the report entirely.
 *
 * Three shapes, because there are three trackers anybody asks for and their importers are not
 * interchangeable:
 *
 *   - **Jira** maps by column *name* and ignores columns it is not asked about, so extra context
 *     is free. Repeated `Labels` columns are how it takes several labels for one issue.
 *   - **ServiceNow** goes through an import set, where an administrator maps every column by hand.
 *     So the headers here are descriptive rather than guesses at a particular instance's field
 *     names — a wrong `u_` column is worse than an obvious one.
 *   - **Azure DevOps** requires the columns to *be* fields of the work item type. `Bug` carries
 *     Repro Steps, Priority, Severity and Tags in the Agile, Scrum and CMMI processes, which is
 *     why the mapping uses those and not `Description`, which a Bug does not have.
 *
 * Built from `buildReportData`, exactly as the spreadsheet is, so the ids, severities, dates and
 * recurrence notes are the ones the report prints. A ticket that disagreed with the report it came
 * from would be worse than no ticket.
 */

import { buildReportData } from './report.service.js';

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One field, quoted the way RFC 4180 says and defused the way a spreadsheet needs.
 *
 * The quoting is the easy half. The other half is that a CSV cell beginning `=`, `+` or `@` is a
 * *formula* to Excel and Google Sheets, and every value here is text somebody typed during a
 * penetration test — an affected-assets field is exactly where a payload would be sitting. So
 * those three are prefixed with an apostrophe, which is the character both applications treat as
 * "this is text".
 *
 * A leading `-` is deliberately left alone. It is a formula only when what follows it parses as
 * arithmetic, and it is common in ordinary prose — a hyphenated note, a negative number, a list
 * marker — so escaping it would corrupt far more values than it protected.
 */
export function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to a CSV document. CRLF, because that is what RFC 4180 says and what importers expect. */
export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

/* -------------------------------------------------------------------------- */
/* Shared shaping                                                             */
/* -------------------------------------------------------------------------- */

/** Whatever a tracker will accept as a label or tag: no spaces, nothing exotic. */
const slug = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * The whole finding as one block of text, because a ticket has one description box.
 *
 * Ordered the way somebody fixing it reads: what and where, then why it matters, then what to do.
 * The report reference is last and always present — a ticket that cannot be traced back to the
 * paragraph it came from is how a remediation argument gets lost six months later.
 */
export function ticketBody(finding, data) {
  const parts = [
    `Severity: ${finding.severity}${
      finding.cvss?.baseScore ? ` (CVSS ${finding.cvss.baseScore})` : ''
    }`,
    finding.cvss?.vector ? `Vector: ${finding.cvss.vector}` : '',
    finding.scope ? `Affected: ${finding.scope}` : '',
    '',
    finding.description || '',
    finding.observation ? `\nImpact\n${finding.observation}` : '',
    finding.remediation ? `\nRemediation\n${finding.remediation}` : '',
    finding.referencesText ? `\nReferences\n${finding.referencesText}` : '',
    finding.previouslyIn ? `\nReported before: ${finding.previouslyIn}` : '',
    `\nFrom ${[data.name, data.reference].filter(Boolean).join(' · ')}, ${data.date}. Finding ${
      finding.id
    }.`,
  ];
  return parts.filter((part) => part !== '').join('\n').trim();
}

/** A summary somebody can find the report paragraph from. */
const ticketTitle = (finding) => `${finding.id}: ${finding.title}`;

/* -------------------------------------------------------------------------- */
/* The trackers                                                               */
/* -------------------------------------------------------------------------- */

/** Severity in each tracker's own vocabulary. `None` is the awkward one everywhere. */
const JIRA_PRIORITY = {
  Critical: 'Highest',
  High: 'High',
  Medium: 'Medium',
  Low: 'Low',
  None: 'Lowest',
};

/** ServiceNow priority runs 1 (critical) to 5 (planning). */
const SERVICENOW_PRIORITY = { Critical: '1', High: '2', Medium: '3', Low: '4', None: '5' };

/**
 * Azure DevOps severity is a fixed four-value list, so informational findings land on "4 - Low".
 * Flattening two levels into one is a real loss, which is why the severity is also stated in the
 * first line of the body, where nothing is truncating it.
 */
const DEVOPS_SEVERITY = {
  Critical: '1 - Critical',
  High: '2 - High',
  Medium: '3 - Medium',
  Low: '4 - Low',
  None: '4 - Low',
};

const DEVOPS_PRIORITY = { Critical: '1', High: '1', Medium: '2', Low: '3', None: '4' };

export const TRACKERS = {
  jira: {
    label: 'Jira',
    suffix: 'jira',
    note: 'Import as issues, then map the columns Jira offers you. Unmapped columns are ignored.',
    columns: [
      { header: 'Summary', of: ticketTitle },
      { header: 'Description', of: (finding, data) => ticketBody(finding, data) },
      { header: 'Issue Type', of: () => 'Bug' },
      { header: 'Priority', of: (finding) => JIRA_PRIORITY[finding.severity] ?? 'Medium' },
      /* Three Labels columns, which is how Jira's importer takes several labels for one issue. */
      { header: 'Labels', of: () => 'security' },
      { header: 'Labels', of: (finding) => slug(finding.category) },
      { header: 'Labels', of: (finding) => slug(finding.id) },
      /* Jira has a field for exactly this, and a ticket without it is a ticket nobody can act on. */
      { header: 'Environment', of: (finding) => finding.scope },
    ],
  },

  servicenow: {
    label: 'ServiceNow',
    suffix: 'servicenow',
    note: 'Load through an import set and map these columns to your instance’s own fields.',
    columns: [
      { header: 'short_description', of: ticketTitle },
      { header: 'description', of: (finding, data) => ticketBody(finding, data) },
      { header: 'priority', of: (finding) => SERVICENOW_PRIORITY[finding.severity] ?? '3' },
      { header: 'category', of: (finding) => finding.category },
      { header: 'subcategory', of: (finding) => finding.vulnType },
      { header: 'affected_assets', of: (finding) => finding.scope },
      { header: 'cvss_score', of: (finding) => finding.cvss?.baseScore ?? '' },
      { header: 'cvss_vector', of: (finding) => finding.cvss?.vector ?? '' },
      { header: 'remediation', of: (finding) => finding.remediation },
      { header: 'report_reference', of: (finding) => finding.id },
    ],
  },

  devops: {
    label: 'Azure DevOps',
    suffix: 'azure-devops',
    note: 'Import as work items. The columns match the Bug type in the Agile, Scrum and CMMI processes.',
    columns: [
      { header: 'Work Item Type', of: () => 'Bug' },
      { header: 'Title', of: ticketTitle },
      { header: 'Repro Steps', of: (finding, data) => ticketBody(finding, data) },
      { header: 'Priority', of: (finding) => DEVOPS_PRIORITY[finding.severity] ?? '2' },
      { header: 'Severity', of: (finding) => DEVOPS_SEVERITY[finding.severity] ?? '3 - Medium' },
      { header: 'Tags', of: (finding) => ['security', slug(finding.category), finding.id].filter(Boolean).join('; ') },
    ],
  },
};

/**
 * @param {{audit: object, settings: object, user: object, history?: any, tracker: string}} input
 * @returns {{text: string, filename: string, findings: number, tracker: string}}
 */
export function buildTrackerCsv({ audit, settings, user, history, tracker }) {
  const shape = TRACKERS[tracker];
  if (!shape) throw new Error(`Unknown tracker: ${tracker}`);

  const data = buildReportData(
    audit,
    settings,
    { parts: null, numbering: null },
    /* `html` for the same reason the spreadsheet uses it: this wants the plain-text fields. */
    { target: 'html', user, history, templateName: `${shape.label} export` }
  );

  const rows = [
    shape.columns.map((column) => column.header),
    ...data.findings.map((finding) => shape.columns.map((column) => column.of(finding, data) ?? '')),
  ];

  const stem = String(data.reference || data.name || 'findings')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return {
    text: toCsv(rows),
    filename: `${stem}-${shape.suffix}.csv`,
    findings: data.findings.length,
    tracker,
  };
}

export default buildTrackerCsv;
