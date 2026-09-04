/**
 * Reading findings back out of a spreadsheet.
 *
 * `findings-sheet.service.js` has always written one; nothing read one. So a team that drafts in
 * Excel, a junior who hands over a sheet, or a scanner that exports the same table all ended in
 * somebody retyping it — and retyping a CVSS vector is how a report ends up rating something wrong.
 *
 * The interesting part is not the parsing. It is what to do with a row that is *nearly* right, and
 * the answer here is: never guess silently, and never refuse the whole file over one bad row.
 * Every row comes back with a verdict, and the person decides:
 *
 *   new        it will be created as written
 *   duplicate  this engagement already has that title — offered, but off by default
 *   invalid    something required is missing or unusable, with the reason in words
 *
 * Nothing is written until the same file is sent back with the rows that were chosen. A preview
 * that commits as a side effect of being looked at is not a preview.
 */
import { calculateCvss, CVSS_DEFAULT_VECTOR, SEVERITY_NAMES } from './cvss.js';
import { normaliseTitle } from './finding-history.service.js';
import { readSheet } from './ooxml/xlsx-read.js';
import { badRequest } from '../utils/http-error.js';

/**
 * How a column in the file becomes a field on a finding.
 *
 * The keys are what `findings-sheet` writes, so a sheet exported from here re-imports unchanged.
 * The aliases are what everybody else calls the same column — enough that a file from a scanner or
 * a colleague's own template lands without anybody editing headers first.
 */
const COLUMNS = [
  { field: 'title', names: ['title', 'name', 'finding', 'vulnerability', 'issue', 'summary'] },
  { field: 'severity', names: ['severity', 'risk', 'rating', 'criticality'] },
  { field: 'cvssv3', names: ['vector', 'cvss vector', 'cvssvector', 'cvss'] },
  { field: 'category', names: ['category', 'group'] },
  { field: 'vulnType', names: ['type', 'vulnerability type', 'vulntype', 'class'] },
  { field: 'scope', names: ['affected assets', 'affected', 'asset', 'assets', 'host', 'hosts', 'target', 'url'] },
  { field: 'description', names: ['description', 'details', 'detail', 'finding description'] },
  { field: 'observation', names: ['impact', 'observation', 'consequence'] },
  { field: 'remediation', names: ['remediation', 'recommendation', 'fix', 'solution', 'mitigation'] },
  { field: 'poc', names: ['poc', 'proof', 'proof of concept', 'evidence', 'reproduction'] },
  { field: 'references', names: ['references', 'reference', 'links'] },
];

const clean = (value) => String(value ?? '').trim();
const key = (value) => clean(value).toLowerCase().replace(/[\s_]+/g, ' ');

/**
 * Which column is which, from the header row.
 *
 * Exact match on the name first, then on the aliases. A column nothing recognises is reported
 * rather than dropped quietly, because "why did my Remediation column not come through" is a
 * question the import should answer before it is asked.
 */
export function mapHeaders(header) {
  const mapping = {};
  const unknown = [];
  header.forEach((cell, index) => {
    const name = key(cell);
    if (!name) return;
    const column = COLUMNS.find((entry) => entry.names.includes(name));
    if (!column) {
      unknown.push(clean(cell));
      return;
    }
    /* First wins: a sheet with two "Description" columns takes the leftmost, which is the one a
       person would have called the description. */
    if (!(column.field in mapping)) mapping[column.field] = index;
  });
  return { mapping, unknown };
}

/** A severity word, however it was written, or null if it is not one. */
function readSeverity(value) {
  const text = key(value);
  if (!text) return null;
  if (['info', 'informational', 'none', 'note'] .includes(text)) return 'None';
  const match = SEVERITY_NAMES.find((name) => name.toLowerCase() === text);
  return match ?? null;
}

/**
 * A row, judged.
 *
 * Severity is the one field with two possible sources — a CVSS vector and a word — and they can
 * disagree. The vector wins, because it is the thing the report will recalculate from, and the
 * disagreement is reported rather than resolved silently: a sheet that says "Low" beside a 9.8
 * vector is a sheet somebody should look at.
 */
export function readRow(cells, mapping, line) {
  const at = (field) => (field in mapping ? clean(cells[mapping[field]]) : '');
  const title = at('title');
  const row = { line, title, status: 'new', reasons: [], warnings: [], finding: null };

  if (!title) {
    /* A blank line in the middle of a sheet is not an error, it is a blank line. */
    row.status = cells.every((cell) => !clean(cell)) ? 'blank' : 'invalid';
    if (row.status === 'invalid') row.reasons.push('No title');
    return row;
  }

  const vector = at('cvssv3');
  let cvssv3 = '';
  if (vector) {
    const scored = calculateCvss(vector);
    if (scored?.baseScore > 0 || /^CVSS:/i.test(vector)) cvssv3 = vector;
    else row.warnings.push(`"${vector}" is not a CVSS vector this understands — left unscored`);
  }

  const said = readSeverity(at('severity'));
  if (at('severity') && !said) row.warnings.push(`"${at('severity')}" is not a severity`);
  if (cvssv3 && said) {
    const computed = calculateCvss(cvssv3)?.baseSeverity;
    if (computed && computed !== said) {
      row.warnings.push(`the vector scores ${computed}, the sheet says ${said} — the vector wins`);
    }
  }
  if (!cvssv3 && !said) row.warnings.push('no severity and no vector — it arrives unrated');

  row.finding = {
    title,
    /* Unrated rather than guessed: the default vector scores zero, which reads as "not scored". */
    cvssv3: cvssv3 || CVSS_DEFAULT_VECTOR,
    ...(said && !cvssv3 ? { severity: said } : {}),
    category: at('category'),
    vulnType: at('vulnType'),
    scope: at('scope'),
    /* Plain text becomes a paragraph: the editor stores HTML, and a bare line would render as one
       run with no spacing between it and whatever follows. */
    description: asHtml(at('description')),
    observation: asHtml(at('observation')),
    remediation: asHtml(at('remediation')),
    poc: asHtml(at('poc')),
    references: at('references')
      .split(/[\n;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
  return row;
}

/** Text from a cell, as the editor's HTML. Newlines are paragraphs; nothing else is interpreted. */
function asHtml(text) {
  const value = clean(text);
  if (!value) return '';
  if (/^\s*<(p|ul|ol|h[1-6]|pre|table|div)\b/i.test(value)) return value;
  return value
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')}</p>`
    )
    .join('');
}

/**
 * Reads a file and says what would happen.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {object[]} existing the engagement's current findings, for the duplicate check
 * @returns {{header: string[], unknown: string[], rows: object[], counts: object}}
 */
export function planImport(buffer, filename, existing = []) {
  const table = readSheet(buffer, filename).filter((row) => row.length);
  if (!table.length) throw badRequest('That file has nothing in it.');

  const [header, ...body] = table;
  const { mapping, unknown } = mapHeaders(header);
  if (!('title' in mapping)) {
    throw badRequest(
      'No Title column was found. The first row must be the headers — Title, Severity, Vector, Description and so on, as the findings export writes them.'
    );
  }

  /* The same rule the duplicate hint uses, so the sheet and the editor agree about sameness. */
  const seen = new Map();
  for (const finding of existing) {
    const normalised = normaliseTitle(finding.title);
    if (normalised && !seen.has(normalised)) seen.set(normalised, finding);
  }

  const rows = [];
  const withinFile = new Map();
  body.forEach((cells, index) => {
    const row = readRow(cells, mapping, index + 2);
    if (row.status === 'blank') return;

    if (row.status !== 'invalid') {
      const normalised = normaliseTitle(row.title);
      const already = seen.get(normalised);
      const earlier = withinFile.get(normalised);
      if (already) {
        row.status = 'duplicate';
        row.duplicateOf = { _id: already._id, identifier: already.identifier ?? '', title: already.title };
      } else if (earlier) {
        row.status = 'duplicate';
        row.duplicateOfLine = earlier;
      } else {
        withinFile.set(normalised, row.line);
      }
    }
    rows.push(row);
  });

  return {
    header: header.map(clean),
    unknown,
    mapped: Object.keys(mapping),
    rows,
    counts: {
      new: rows.filter((row) => row.status === 'new').length,
      duplicate: rows.filter((row) => row.status === 'duplicate').length,
      invalid: rows.filter((row) => row.status === 'invalid').length,
    },
  };
}

export default { planImport, mapHeaders, readRow };
