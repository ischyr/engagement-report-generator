/**
 * Turning a pasted grid into a real table.
 *
 * Operators paste tabular data constantly — a list of affected hosts, a permissions matrix, cracked
 * accounts, the output of a query. Pasted into a rich-text editor it arrives as prose: the columns
 * collapse, the rows run together, and the usual response is to give up and paste a *screenshot* of
 * the table instead. Which is an image of text: unsearchable, uncopyable, and unreadable in a
 * printed report at anything under full size.
 *
 * The editor has had table support all along. What it lacked was the one step between a clipboard
 * full of tab-separated values and using it.
 *
 * ## What counts as a table, and what deliberately does not
 *
 * Only two shapes, both unambiguous:
 *
 * - **Tab-separated.** What Excel, Google Sheets, every database client and `cut -f` put on the
 *   clipboard. Prose does not contain tabs, so this is close to free of false positives.
 * - **Markdown pipe tables**, with their `|---|---|` rule. Unmistakable, and what half the tools an
 *   operator uses print when asked for a table.
 *
 * **Not comma-separated**, on purpose. A paragraph of English contains commas, and the cost of
 * being wrong is asymmetric: a real table pasted as prose is an annoyance, while a sentence turned
 * into a one-row table is a mangling that has to be undone by hand. `1,024 hosts, most of them
 * Windows` is not a table and no heuristic can be sure it isn't.
 *
 * **Nor space-aligned output.** `net group "Domain Admins"` and `ls -l` line their columns up with
 * runs of spaces, and telling that apart from an indented paragraph is guesswork. Those stay as
 * text, where a code block already renders them correctly.
 */

/** Two rows minimum: one line of tab-separated values is a line, not a table. */
const MIN_ROWS = 2;
/** And two columns, or it is a list — which the editor already has a better answer for. */
const MIN_COLUMNS = 2;
/** Beyond this it is a data file rather than evidence, and belongs in an appendix or a sheet. */
const MAX_ROWS = 200;

/** `|---|:--:|---:|` — a markdown alignment rule, in any of its spellings. */
const RULE_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

const lines = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

/** Trailing blank lines are an artefact of selecting a range, not an empty row. */
const trimmed = (rows) => {
  const out = [...rows];
  while (out.length && out.at(-1).trim() === '') out.pop();
  while (out.length && out[0].trim() === '') out.shift();
  return out;
};

/** Splits a markdown row, dropping the empty cells its outer pipes produce. */
function splitPipes(line) {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells.at(-1) === '') cells.pop();
  return cells;
}

/**
 * @typedef {object} PastedTable
 * @property {string[]} header
 * @property {string[][]} rows
 * @property {'tsv'|'markdown'} kind
 */

/**
 * What the paste is, if it is a table at all.
 *
 * @param {string} text
 * @returns {PastedTable|null}
 */
export function parsePastedTable(text) {
  const all = trimmed(lines(text));
  if (all.length < MIN_ROWS || all.length > MAX_ROWS) return null;

  /* ------------------------------------------------------------- markdown */
  const pipey = all.filter((line) => line.includes('|'));
  if (pipey.length === all.length && all.some((line) => RULE_ROW.test(line))) {
    const ruleAt = all.findIndex((line) => RULE_ROW.test(line));
    /* The rule belongs under the header. A table that opens with one has no header row. */
    const header = ruleAt === 1 ? splitPipes(all[0]) : [];
    const body = all.filter((line, index) => index !== ruleAt && !(ruleAt === 1 && index === 0));
    const rows = body.map(splitPipes).filter((row) => row.length);
    if (!rows.length && !header.length) return null;
    const width = Math.max(header.length, ...rows.map((row) => row.length));
    if (width < MIN_COLUMNS) return null;
    return { header, rows, kind: 'markdown' };
  }

  /* ------------------------------------------------------------------ tsv */
  if (!all.every((line) => line.includes('\t'))) return null;
  const grid = all.map((line) => line.split('\t').map((cell) => cell.trim()));
  const width = grid[0].length;
  if (width < MIN_COLUMNS) return null;
  /*
   * Every row the same width, or it is not a grid.
   *
   * Strict rather than padded: a ragged paste is far more likely to be something else that happens
   * to contain a tab than a table somebody wants, and guessing at the missing cells would put words
   * in the wrong columns — which reads as data rather than as a mistake.
   */
  if (!grid.every((row) => row.length === width)) return null;

  /*
   * The first row is the header. What Excel users expect, and what makes the Word table readable —
   * a header row is repeated across a page break, which a data row must not be.
   */
  const [header, ...rows] = grid;
  if (!rows.length) return null;
  return { header, rows, kind: 'tsv' };
}

/** Whether a paste is worth offering to convert. */
export const looksLikeTable = (text) => parsePastedTable(text) !== null;

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * The HTML for it, as the editor's table extension and the OOXML writer both expect.
 *
 * A `<thead>` only when there is a header, because an empty one renders as a blank first row in
 * Word — a table with a stripe of nothing across the top, which looks like a bug in the template
 * rather than a table with no headings.
 *
 * @param {PastedTable} table
 * @returns {string}
 */
export function tableHtml(table) {
  if (!table) return '';
  const width = Math.max(table.header.length, ...table.rows.map((row) => row.length));
  const cells = (row, tag) =>
    Array.from({ length: width }, (_unused, index) => `<${tag}>${escape(row[index] ?? '')}</${tag}>`).join('');

  const head = table.header.length ? `<thead><tr>${cells(table.header, 'th')}</tr></thead>` : '';
  const body = table.rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

export default parsePastedTable;
