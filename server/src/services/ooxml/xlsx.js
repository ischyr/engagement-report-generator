/**
 * A very small SpreadsheetML writer: rows of values in, an .xlsx buffer out.
 *
 * Hand-rolled for the same reason the Word side is. This app already assembles OOXML by
 * hand — `html2ooxml.js` writes WordprocessingML, `docx-parts.js` rewrites relationships —
 * and a spreadsheet package is the same shape of problem: a zip of XML parts with a
 * content-type map. A library would add a dependency, and most of them bring a formula
 * engine, styling DSL and reader we would never use.
 *
 * What it supports, because that is what a findings sheet needs: several sheets, typed
 * cells (text or number), a bold header row, frozen headers, an autofilter, per-column
 * widths, wrapped text, and a background fill on individual cells so severity can be
 * coloured with the instance's own palette.
 *
 * What it deliberately does not: formulas, merged cells, dates as numbers (dates are
 * written as text, because a spreadsheet that reads `2026-08-05` back as a locale-dependent
 * serial number is worse than one that leaves it alone), or reading files.
 */

import PizZip from 'pizzip';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * Excel refuses to open a file containing control characters, and pasted terminal
 * output is full of them. Tabs and newlines stay: they are legal in XML and a wrapped
 * cell of remediation advice needs its line breaks.
 */
const CONTROL_CHARS = /\p{Cc}/gu;
const KEEP = '\t\n\r';

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Excel refuses to open a file containing control characters, and pasted terminal
    // output is full of them.
    .replace(CONTROL_CHARS, (character) => (KEEP.includes(character) ? character : ''));

/** A1, B1 … Z1, AA1. */
export function cellRef(columnIndex, rowNumber) {
  let column = '';
  let index = columnIndex;
  do {
    column = String.fromCharCode(65 + (index % 26)) + column;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return `${column}${rowNumber}`;
}

/** Excel's cell limit. Truncated with a marker rather than producing an unopenable file. */
const MAX_CELL = 32_000;
const clamp = (text) =>
  text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}… [truncated]` : text;

/**
 * The style table.
 *
 * Styles are referenced by index, so the order here is the contract: 0 is the default, and
 * anything added must go on the end. Fills start at index 2 by fixed convention — Excel
 * reserves 0 (none) and 1 (grey125) and silently misrenders a file that reuses them.
 */
function stylesXml(fillColours) {
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    ...fillColours.map(
      (hex) =>
        `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`
    ),
  ];

  // cellXfs, in the order the writer refers to them:
  //   0 plain · 1 header · 2 wrapped · 3 bold · 4.. one per fill colour
  const formats = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    ...fillColours.map(
      (_hex, index) =>
        `<xf numFmtId="0" fontId="1" fillId="${index + 2}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    ),
  ];

  return `${XML_HEADER}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${formats.length}">${formats.join('')}</cellXfs>
</styleSheet>`;
}

/** Style indices, named so callers never write a bare number. */
export const STYLE = { plain: 0, header: 1, wrapped: 2, bold: 3, firstFill: 4 };

function sheetXml(sheet) {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const number = rowIndex + 1;
      const cells = row
        .map((cell, columnIndex) => {
          if (cell === null || cell === undefined || cell === '') return '';
          const ref = cellRef(columnIndex, number);
          const value = typeof cell === 'object' ? cell.value : cell;
          const style = typeof cell === 'object' ? (cell.style ?? STYLE.plain) : STYLE.plain;
          const attrs = `r="${ref}"${style ? ` s="${style}"` : ''}`;

          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c ${attrs}><v>${value}</v></c>`;
          }
          // Inline strings rather than a shared-strings table: a findings sheet has almost
          // no repeated text, so the table would add a part and save nothing.
          return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
            clamp(String(value))
          )}</t></is></c>`;
        })
        .join('');
      return `<row r="${number}">${cells}</row>`;
    })
    .join('');

  const columns = (sheet.widths ?? [])
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const lastRow = sheet.rows.length;
  const lastColumn = Math.max(1, ...sheet.rows.map((row) => row.length));
  const dimension = `A1:${cellRef(lastColumn - 1, Math.max(1, lastRow))}`;

  // A header row that scrolls away is the first thing anybody complains about.
  const freeze = sheet.freezeHeader
    ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>'
    : '<sheetView workbookViewId="0"/>';

  const filter = sheet.autofilter && lastRow > 1 ? `<autoFilter ref="${dimension}"/>` : '';

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews>${freeze}</sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${columns ? `<cols>${columns}</cols>` : ''}
<sheetData>${rows}</sheetData>
${filter}
</worksheet>`;
}

/**
 * @param {{sheets: Array<{name: string, rows: Array<Array<any>>, widths?: number[],
 *          freezeHeader?: boolean, autofilter?: boolean}>, fills?: string[]}} workbook
 * @returns {Buffer}
 */
export function buildXlsx({ sheets, fills = [] }) {
  const zip = new PizZip();

  const sheetEntries = sheets.map((sheet, index) => ({
    ...sheet,
    id: index + 1,
    // Excel's own rules: 31 characters, and none of : \ / ? * [ ]
    safeName: (sheet.name || `Sheet${index + 1}`).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31),
  }));

  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetEntries
  .map(
    (sheet) =>
      `<Override PartName="/xl/worksheets/sheet${sheet.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  zip.file(
    'xl/workbook.xml',
    `${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries
      .map(
        (sheet) =>
          `<sheet name="${escapeXml(sheet.safeName)}" sheetId="${sheet.id}" r:id="rId${sheet.id}"/>`
      )
      .join('')}</sheets>
</workbook>`
  );

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetEntries
  .map(
    (sheet) =>
      `<Relationship Id="rId${sheet.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.id}.xml"/>`
  )
  .join('')}
<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  );

  zip.file('xl/styles.xml', stylesXml(fills));
  for (const sheet of sheetEntries) {
    zip.file(`xl/worksheets/sheet${sheet.id}.xml`, sheetXml(sheet));
  }

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export default buildXlsx;
