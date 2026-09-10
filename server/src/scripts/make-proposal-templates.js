/**
 * Builds starter .docx templates for the paperwork a proposal produces.
 *
 *   npm run make:proposal-templates      → server/storage/templates/ and the repo root
 *
 * Three documents: an NDA, a permission to attack, and the proposal itself. Every placeholder
 * in them is a real tag from `buildProposalData`, so they render against a live proposal the
 * moment they are uploaded.
 *
 * A permission to attack is not a testing agreement, and the distinction is the sharpest one in
 * this app: an agreement is commercial terms, a permission is authorisation to touch somebody
 * else's systems. Testing on the strength of the wrong document is the difference between a job
 * and an offence.
 *
 * The same reasoning as the report starter: editing this script is not the workflow. Open the
 * files in Word and rewrite them — the clauses here are deliberately plain and short, because
 * a generated contract that reads as though a lawyer wrote it is more dangerous than one that
 * obviously needs one. **These are scaffolding for the tags, not legal advice.** Every firm's
 * NDA and permission to attack are their own, and reviewed by somebody qualified.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import env, { ROOT_DIR } from '../config/env.js';
import { log } from '../utils/logger.js';

const INK = '1F2937';
const MUTED = '6B7280';
const RULE = 'D1D5DB';

const text = (value, options = {}) => new TextRun({ text: value, ...options });
const para = (value, options = {}) =>
  new Paragraph({
    spacing: { after: options.after ?? 140, line: 300 },
    alignment: options.alignment,
    children: [text(value, { size: options.size ?? 21, color: options.color ?? INK, ...options })],
  });
const h1 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_1 });
const h2 = (value) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_2 });
const spacer = (after = 160) => new Paragraph({ spacing: { after }, children: [] });

/** A numbered clause. Plain text on purpose — see the header. */
const clause = (number, title, body) => [
  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [text(`${number}. ${title}`, { bold: true, size: 21, color: INK })],
  }),
  para(body),
];

const borders = () => {
  const line = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return { top: line, bottom: line, left: line, right: line };
};

const cell = (value, { bold = false, width = 50 } = {}) =>
  new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({ children: [text(value, { bold, size: 20, color: bold ? MUTED : INK })] }),
    ],
  });

const facts = (pairs) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: borders(),
    rows: pairs.map(([label, value]) => new TableRow({ children: [cell(label, { bold: true, width: 32 }), cell(value, { width: 68 })] })),
  });

const footer = () =>
  new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          text('{{ firm.legalName }} · {{ reference }} · page ', { size: 16, color: MUTED }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
        ],
      }),
    ],
  });

const document = (children) =>
  new Document({
    creator: 'Engy Report',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 21, color: INK } },
        heading1: { run: { font: 'Calibri', size: 30, bold: true, color: INK }, paragraph: { spacing: { after: 200 } } },
        heading2: { run: { font: 'Calibri', size: 24, bold: true, color: INK }, paragraph: { spacing: { before: 240, after: 120 } } },
      },
    },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, footers: { default: footer() }, children }],
  });

/** The two parties and the signature block, identical on all three documents. */
const parties = () => [
  h2('The parties'),
  facts([
    ['Us', '{{ firm.legalName }}'],
    ['Our address', '{{ firm.address }}'],
    ['Company number', '{{ firm.registration }}'],
    ['Them', '{{ company.name }}'],
    ['Their address', '{{ company.address }}'],
    ['Their contact', '{{ client.fullname }}, {{ client.title }} ({{ client.email }})'],
  ]),
];

const signatures = () => [
  spacer(320),
  h2('Signed'),
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: borders(),
    rows: [
      new TableRow({ children: [cell('For {{ firm.legalName }}', { bold: true }), cell('For {{ company.name }}', { bold: true })] }),
      new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: { top: 400, bottom: 120, left: 120, right: 120 },
            children: [para('{{ firm.signatoryName }}'), para('{{ firm.signatoryTitle }}', { color: MUTED, size: 18 }), para('Date:', { color: MUTED, size: 18 })],
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: { top: 400, bottom: 120, left: 120, right: 120 },
            children: [para('{{ client.fullname }}'), para('{{ client.title }}', { color: MUTED, size: 18 }), para('Date:', { color: MUTED, size: 18 })],
          }),
        ],
      }),
    ],
  }),
];

/* -------------------------------------------------------------------------- */

function nda() {
  return document([
    h1('Mutual non-disclosure agreement'),
    para('Reference {{ reference }} · {{ now }}', { color: MUTED, size: 18 }),
    ...parties(),
    ...clause(
      1,
      'What is confidential',
      'Anything either side shares with the other in connection with {{ title }} that is not already public — including the findings of any security testing, and the fact and detail of any weakness found.'
    ),
    ...clause(
      2,
      'How it is handled',
      'Each side keeps the other’s confidential information to itself, shares it only with the people who need it to do this work, and protects it at least as carefully as it protects its own.'
    ),
    ...clause(
      3,
      'How long for',
      'This agreement starts on the date it is signed and continues for three years after the work described in {{ reference }} finishes or is abandoned.'
    ),
    ...clause(4, 'Governing law', 'This agreement is governed by the law of {{ firm.jurisdiction }}.'),
    ...signatures(),
  ]);
}

/**
 * Permission to attack.
 *
 * Not an agreement — that is the offer and the testing terms. This is the authorisation: who
 * said we may test what, when, and who to ring when something breaks. It is written from the
 * kickoff, which is why every field in that block appears here, and why the whole kickoff
 * section is wrapped in `{{#kickoff.held}}` — a permission asserting a meeting that has not
 * happened would be saying something untrue.
 */
function pta() {
  return document([
    h1('Permission to attack'),
    para('Reference {{ reference }} · issued {{ now }}', { color: MUTED, size: 18 }),
    ...parties(),

    h2('What is authorised'),
    facts([
      ['Engagement', '{{ title }}'],
      ['Type of testing', '{{ auditType }}'],
      ['Agreed effort', '{{ effort.daysLabel }}'],
      ['Testing window', '{{ dateRange }}'],
    ]),
    para('{{ summary }}'),

    h2('Agreed limits'),
    para('{{ constraints }}'),

    // Only when the call has actually happened.
    para('{{#kickoff.held}}', { color: MUTED, size: 16 }),
    h2('Agreed at the kickoff'),
    facts([
      ['Kickoff held', '{{ kickoff.heldOn }}'],
      ['Present from {{ firm.legalName }}', '{{ kickoff.attendeesOurs }}'],
      ['Present from {{ company.name }}', '{{ kickoff.attendeesTheirs }}'],
      ['Emergency contact during testing', '{{ kickoff.emergencyContact }}'],
    ]),
    para('{{ kickoff.notes }}'),
    para('{{/kickoff.held}}', { color: MUTED, size: 16 }),

    ...clause(
      1,
      'Authorisation',
      '{{ company.name }} confirms that it owns, or is entitled to authorise testing of, everything described above, and authorises {{ firm.legalName }} and its named personnel to carry out that testing during the window stated.'
    ),
    ...clause(
      2,
      'What this does not cover',
      'Anything not described above. Testing outside the window, outside the agreed limits, or against systems not listed here is not authorised by this document, and requires a further one.'
    ),
    ...clause(
      3,
      'If something breaks',
      'Testing carries a risk of disruption. Where it occurs, {{ firm.legalName }} stops immediately and contacts {{ kickoff.emergencyContact }}. Techniques with a material risk of disruption are agreed in writing beforehand.'
    ),
    ...clause(
      4,
      'Handling what is found',
      'Anything found is reported to {{ client.fullname }} and is confidential under the non-disclosure agreement between the parties. Critical weaknesses are reported as soon as they are confirmed rather than held for the report.'
    ),
    ...clause(
      5,
      'Signing authority',
      'The person signing for {{ company.name }} confirms they are authorised to give this permission on its behalf.'
    ),
    ...clause(6, 'Governing law', 'This document is governed by the law of {{ firm.jurisdiction }}.'),
    ...signatures(),
  ]);
}

function proposal() {
  return document([
    h1('Proposal: {{ title }}'),
    para('{{ reference }} · prepared for {{ company.name }} · {{ now }}', { color: MUTED, size: 18 }),
    h2('At a glance'),
    facts([
      ['Client', '{{ company.name }}'],
      ['Contact', '{{ client.fullname }} ({{ client.email }})'],
      ['Type of work', '{{ auditType }}'],
      ['Estimated effort', '{{ effort.daysLabel }}'],
      ['Planned window', '{{ dateRange }}'],
      ['Valid until', '{{ validUntil }}'],
      ['Your contact with us', '{{ owner.fullname }} ({{ owner.email }})'],
    ]),
    h2('What you asked for'),
    para('{{ summary }}'),
    h2('What we will do'),
    para(
      'We will carry out {{ auditType }} as described above. The work is estimated at {{ effort.daysLabel }} of testing, followed by a written report describing everything found, how serious it is, and what to do about it.'
    ),
    h2('Anything worth flagging'),
    para('{{ constraints }}'),
    h2('Terms'),
    para(
      'This proposal is valid until {{ validUntil }}. The work is subject to the non-disclosure agreement issued with it, and to a signed permission to attack, both under reference {{ reference }}.'
    ),
    ...signatures(),
  ]);
}

async function main() {
  const files = [
    ['ENGY_STARTER_NDA.docx', 'engy-starter-nda.docx', nda()],
    ['ENGY_STARTER_PERMISSION_TO_ATTACK.docx', 'engy-starter-pta.docx', pta()],
    ['ENGY_STARTER_PROPOSAL.docx', 'engy-starter-proposal.docx', proposal()],
  ];

  for (const [rootName, storageName, doc] of files) {
    const buffer = await Packer.toBuffer(doc);
    for (const target of [
      path.join(env.storage.templates, storageName),
      path.join(ROOT_DIR, rootName),
    ]) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
      log.info(`Wrote ${target} (${(buffer.length / 1024).toFixed(1)} KB)`);
    }
  }
  log.info('Upload these on the Templates page with purpose "Proposal paperwork".');
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
