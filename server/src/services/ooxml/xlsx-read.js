/**
 * Reading a spreadsheet, which this app has only ever written.
 *
 * `xlsx.js` builds the workbooks the findings and enumeration exports hand out. This is the same
 * format in the other direction, and deliberately much smaller: an importer does not need styles,
 * formulas, merged cells, charts or a second sheet. It needs the cells of the first sheet as text.
 *
 * The three things that actually matter in the file:
 *
 *   - **Strings live somewhere else.** A cell with `t="s"` holds an index into `sharedStrings.xml`,
 *     not a word. Reading `<v>` and stopping is how an import turns a column of titles into a
 *     column of small integers.
 *   - **Rows and columns are sparse.** An empty cell is usually absent rather than empty, so
 *     position comes from the `r="C7"` reference and never from counting siblings.
 *   - **`t="inlineStr"` exists**, and is what several exporters write instead of a shared string.
 *
 * Anything else — numbers, dates, booleans — comes back as the text that was in the file. A date
 * serial is not converted, because guessing which of the fifteen date formats a column meant is how
 * an import quietly shifts every date by a day, and none of the fields being imported here is one.
 */
import PizZip from 'pizzip';

import { badRequest } from '../../utils/http-error.js';

const unescape = (value) =>
  String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    /* Last, or an escaped ampersand in the file would undo the replacements above it. */
    .replace(/&amp;/g, '&');

/** Every `<t>` in a fragment, joined — a shared string is split by runs when it has formatting. */
const textOf = (xml) =>
  [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');

/** "C7" → 2. Base-26 with no zero, which is why the accumulator starts from scratch each letter. */
export function columnIndex(reference) {
  const letters = String(reference ?? '').match(/^[A-Z]+/i)?.[0] ?? '';
  let n = 0;
  for (const letter of letters.toUpperCase()) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The first sheet, as rows of strings.
 *
 * @param {Buffer} buffer the .xlsx
 * @param {{maxRows?: number}} [options]
 * @returns {string[][]} ragged: a row is only as long as its last filled cell
 */
export function readXlsx(buffer, { maxRows = 5000 } = {}) {
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw badRequest('That file is not a readable .xlsx — it may be an old .xls, or damaged.');
  }

  const shared = [];
  const sharedXml = zip.file('xl/sharedStrings.xml')?.asText();
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(match[1]));
  }

  /*
   * The first sheet by the workbook's own ordering, not by filename. `sheet1.xml` is usually the
   * first sheet and is not always: a workbook whose first tab was deleted keeps the numbering.
   */
  const workbook = zip.file('xl/workbook.xml')?.asText() ?? '';
  const rels = zip.file('xl/_rels/workbook.xml.rels')?.asText() ?? '';
  const firstId = /<sheet[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstId
    ? new RegExp(`Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    : null;
  const path = target
    ? `xl/${String(target).replace(/^\/?xl\//, '').replace(/^\//, '')}`
    : 'xl/worksheets/sheet1.xml';
  const sheet = zip.file(path)?.asText() ?? zip.file('xl/worksheets/sheet1.xml')?.asText();
  if (!sheet) throw badRequest('That workbook has no readable sheet in it.');

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const index = Number(rowMatch[1]) - 1;
    if (index >= maxRows) break;
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const at = columnIndex(/r="([A-Z]+\d+)"/i.exec(attrs)?.[1] ?? '');
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const which = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1);
        value = shared[which] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        value = unescape(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      if (at >= 0) cells[at] = value;
    }
    rows[index] = [...cells].map((cell) => cell ?? '');
  }

  /* Sparse rows become empty ones, so the caller can count line numbers honestly. */
  return [...rows].map((row) => row ?? []);
}

/**
 * CSV, to the extent anybody agrees what that is.
 *
 * Quoted fields, doubled quotes inside them, and newlines inside those — which is the whole reason
 * `String.split(',')` is not an implementation of this. A BOM is stripped because Excel writes one
 * and it would otherwise become part of the first header.
 */
export function readCsv(text) {
  const input = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      /* A CRLF is one ending, not two. */
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Either, chosen by what the bytes actually are rather than by what the name claims. */
export function readSheet(buffer, filename = '') {
  const isZip = buffer?.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) return readXlsx(buffer);
  if (/\.xlsx?$/i.test(filename) && !isZip) {
    throw badRequest('That looks like an old .xls. Save it as .xlsx or as CSV and try again.');
  }
  return readCsv(buffer.toString('utf8'));
}

export default { readSheet, readXlsx, readCsv, columnIndex };
