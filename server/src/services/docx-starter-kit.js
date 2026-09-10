/**
 * The house style of the starter templates, in one place.
 *
 * There are two starters now — a penetration test report and a red team report — and they are the
 * same document with different chapters. Extracting the palette, the helpers and the page furniture
 * is what stops that from meaning two copies of a cover page that slowly disagree about the size of
 * a heading.
 *
 * Nothing here knows anything about either report. A script supplies a title and an array of
 * paragraphs; this decides what the paper looks like.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

export const INK = '1F2937';
export const MUTED = '6B7280';
export const ACCENT = '1F3864';
export const RULE = 'D1D5DB';
/** For a handling marking, which has to be the thing the eye lands on first. */
export const CRIT = 'B42318';
export const HEADER_FILL = 'F3F4F6';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export const text = (value, options = {}) => new TextRun({ text: value, ...options });

export const para = (value, options = {}) => {
  const { runs, ...rest } = options;
  return new Paragraph({
    children: runs ?? (value === undefined ? [] : [text(value, options.run ?? {})]),
    ...rest,
  });
};

export const h1 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_1 });
export const h2 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_2 });
export const h3 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_3 });
export const spacer = (after = 120) => new Paragraph({ spacing: { after }, children: [] });

/**
 * A short explanatory note for whoever edits the template.
 *
 * These must never contain live placeholder syntax: the renderer would try to evaluate the example
 * and fail with an unclosed-loop error. It has happened — a hint that mentioned a guard by name took
 * the whole template down. Describe the syntax in words and point at the in-app Tag Reference.
 */
export const hint = (value) =>
  new Paragraph({
    spacing: { before: 40, after: 160 },
    children: [text(value, { italics: true, size: 16, color: MUTED })],
  });

export const cell = (children, options = {}) => {
  const { width, fill, bold = false, align, columnSpan, size = 20, color = INK } = options;
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

export const thinBorders = () => {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return {
    top: edge,
    bottom: edge,
    left: edge,
    right: edge,
    insideHorizontal: edge,
    insideVertical: edge,
  };
};

export const table = (rows, options = {}) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: thinBorders(),
    columnWidths: options.columnWidths,
    rows,
  });

/** Two-column key/value table used for the cover and document-control blocks. */
export const infoTable = (pairs) =>
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

/**
 * A header row, from labels and widths.
 *
 * The two-row "header then one looping row" shape is how a Word table repeats: the loop opens in the
 * first cell of the body row and closes in its last, so Word repeats that row per item.
 */
export const headerRow = (columns) =>
  new TableRow({
    tableHeader: true,
    children: columns.map(([label, width, align]) =>
      cell(label, { width, fill: HEADER_FILL, bold: true, align })
    ),
  });

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a body in the page furniture both starters share.
 *
 * Heading styles are declared here rather than left to Word's defaults because rich text from the
 * app maps onto `Heading1`–`Heading6`, `ListParagraph`, `Quote` and `Caption` by name — a template
 * missing one of them renders the app's formatting as plain paragraphs.
 */
export function starterDocument({ title, description, body }) {
  const heading = (size, color = ACCENT, extra = {}) => ({
    run: { font: 'Calibri Light', size, bold: true, color },
    paragraph: { spacing: { before: 320, after: 140 }, ...extra },
  });

  return new Document({
    creator: 'Engy Report',
    title,
    description,
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
                  /*
                   * The handling marking, ahead of everything else on the line.
                   *
                   * `isRestricted` comes from the engagement's own classification — the one that
                   * already decides the retention window and whether a second factor is demanded to
                   * open it. Until now it stopped at the door: the app knew a report was restricted
                   * and the document said nothing, which is the one place it matters, because a
                   * marking is for the printed copy somebody leaves on a desk.
                   */
                  text('{{#isRestricted}}RESTRICTED  ·  {{/isRestricted}}', {
                    size: 16,
                    bold: true,
                    color: CRIT,
                  }),
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
                  /*
                   * Restricted first, then whatever the firm's own marking is.
                   *
                   * The custom field stays and stays first in line, because a template that ignored
                   * it would be a regression for anybody already using it — this only *adds* the
                   * marking the app is certain about. A standard engagement is unchanged: it prints
                   * the firm's own word, or "CONFIDENTIAL" if nobody has set one.
                   */
                  text('{{#isRestricted}}RESTRICTED  ·  {{/isRestricted}}', {
                    size: 16,
                    bold: true,
                    color: CRIT,
                  }),
                  text("{{ .custom.classification | default:'CONFIDENTIAL' }}  ·  Page ", {
                    size: 16,
                    color: MUTED,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
                  text(' of ', { size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
                ],
              }),
              /*
               * And who this copy was made for, on the copies that were made for somebody.
               *
               * `POST /audits/:id/report/copies` renders one document per recipient and this is
               * the line that makes it obvious: "Prepared for Marijke de Vries · copy 2 of 4", on
               * every page. On an ordinary render `isCopy` is false and the paragraph collapses to
               * nothing, so a report that was not made for one named person says nothing about one.
               *
               * The app can trace a copy without this — the recipient is in the document's own
               * properties and the hash is in the delivery register — but tracing is what happens
               * after a leak. This is what makes somebody think twice before forwarding it, which
               * is the part that has to be visible.
               */
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 20 },
                children: [
                  text('{{#isCopy}}{{ copyLabel }}{{/isCopy}}', {
                    size: 14,
                    italics: true,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
}

export default starterDocument;
