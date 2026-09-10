/**
 * Adds Engy Report placeholders to an existing .docx, in place of the
 * hand-filled text it already contains.
 *
 *   npm run tag:template -- REPORT_PENTESTING_TEMPLATE.docx
 *   npm run tag:template -- input.docx output.docx
 *
 * Why a script rather than an editor session: the template marks its fill-in
 * spots with yellow highlight, which makes them machine-locatable. Replacing
 * them programmatically is repeatable — re-run it after the designer revises the
 * document and the tagging is reapplied.
 *
 * Everything here works on `word/document.xml` at the run level. Word splits a
 * single visible string across many `<w:r>` runs (spell-check state, revision
 * ids), so a "replace this sentence" operation means: find the consecutive runs
 * whose combined text matches, put the replacement in the first one, and blank
 * the rest.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

import { ROOT_DIR } from '../config/env.js';
import {
  escapeXml,
  textOf,
  setRunText,
  dropHighlight,
  splitBlocks,
  joinBlocks,
  eachParagraph,
  replaceAcrossRuns,
  setParagraphText,
  controlParagraph,
} from '../services/ooxml/docx-surgery.js';
import { log } from '../utils/logger.js';

/* -------------------------------------------------------------------------- */
/* Edits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whole-paragraph substitutions, matched on the paragraph's exact visible text.
 * `once: false` allows the same text to be replaced everywhere it appears.
 */
const PARAGRAPH_REPLACEMENTS = [
  // Cover page
  { find: 'Client', to: '{{ .company.name }}' },
  { find: '05.08.2025', to: "{{ .dateRaw | date:'dd.MM.yyyy' }}" },

  // Rules of engagement — project team becomes a loop (handled separately),
  // scope bullets likewise.

  // Findings detail block
  { find: 'Score: 5.3', to: 'Score: {{ .cvssScore }}' },
  {
    find: 'CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:N/A:H',
    to: '{{ .cvssv3 }}',
  },
  { find: 'Severity: Medium', to: 'Severity: {{ .severity }}' },
];

/**
 * Substitutions applied to a fragment of a sentence rather than a whole one.
 * Ordered longest-first: "CLIENT APPLICATION" has to be consumed before the
 * shorter strings inside it, or it gets chewed up piecemeal.
 */
const INLINE_REPLACEMENTS = [
  { find: 'CLIENT APPLICATION', to: '{{ .company.name }}' },
  { find: 'APPLICATION', to: '{{ .name | upper }}' },
  { find: 'CLIENT', to: '{{ .company.name }}' },
  {
    find: '30.07.2025 to 05.08.2025',
    to: "{{ .date_startRaw | date:'dd.MM.yyyy' }} to {{ .date_endRaw | date:'dd.MM.yyyy' }}",
  },
  { find: '10.202.6.148', to: '{{ .scopeSummary }}' },
  { find: 'application-endpoint', to: '{{ .scopeSummary }}' },

  // These two counters share one paragraph, separated by a line break, so the
  // "label: <digits>" rule in tagCounters cannot see them.
  { find: 'TOTAL FIXED VULNERABILITIES: 0', to: 'TOTAL FIXED VULNERABILITIES: {{ .stats.fixed }}' },
  {
    find: 'TOTAL VULNERABILITIES RETESTING: 0',
    to: 'TOTAL VULNERABILITIES RETESTING: {{ .stats.retesting }}',
  },
];

/** Numbers inside the summary tables, keyed by the label that precedes them. */
const COUNTER_REPLACEMENTS = [
  ['TOTAL VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.total }}'],
  ['TOTAL CRITICAL VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.critical }}'],
  ['TOTAL HIGH VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.high }}'],
  ['TOTAL MEDIUM VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.medium }}'],
  ['TOTAL LOW VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.low }}'],
  ['TOTAL INFO VULNERABILITIES FOR ALL ASSETS: ', '{{ .stats.info }}'],
  ['TOTAL NOT FIXED VULNERABILITIES: ', '{{ .stats.notFixed }}'],
  // FIXED and RETESTING share a paragraph and are handled in INLINE_REPLACEMENTS.
];

/** The five severity cells of the "Security Testing Overview" grid. */
const OVERVIEW_CELLS = {
  CRITICAL: '{{ .stats.critical }}',
  HIGH: '{{ .stats.high }}',
  MEDIUM: '{{ .stats.medium }}',
  LOW: '{{ .stats.low }}',
  INFO: '{{ .stats.info }}',
  'TOTAL UNIQUE VULNERABILITIES': '{{ .stats.total }}',
};

const report = [];
const note = (message) => report.push(message);

/* -------------------------------------------------------------------------- */

function tagCounters(xml) {
  let out = xml;
  for (const [label, tag] of COUNTER_REPLACEMENTS) {
    let done = false;
    const result = eachParagraph(out, (paragraph, text) => {
      if (done) return null;
      const trimmed = text.trim();
      if (!trimmed.startsWith(label.trim())) return null;
      // Only the "label: <number>" form — never a sentence that merely mentions it.
      const rest = trimmed.slice(label.trim().length).replace(/^:/, '').trim();
      if (!/^\d+$/.test(rest)) return null;
      done = true;
      return setParagraphText(paragraph, `${label}${tag}`);
    });
    out = result.xml;
    note(done ? `  counter  ${label.trim()} → ${tag}` : `  MISSED   counter "${label.trim()}"`);
  }
  return out;
}

/**
 * The overview grid holds a label and its number in separate paragraphs inside
 * one cell, so the number is located by looking at the cell as a whole.
 */
function tagOverviewGrid(xml) {
  return xml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell) => {
    const paras = [...cell.matchAll(/<w:p\b(?![a-zA-Z])[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g)].map(
      (m) => m[0]
    );
    if (paras.length < 2) return cell;

    const labels = paras.map((p) => textOf(p).trim());
    const labelIndex = labels.findIndex((t) => Object.hasOwn(OVERVIEW_CELLS, t));
    if (labelIndex === -1) return cell;

    // The number is the next paragraph that is purely digits.
    const numberIndex = labels.findIndex((t, i) => i > labelIndex && /^\d+$/.test(t));
    if (numberIndex === -1) return cell;

    const tag = OVERVIEW_CELLS[labels[labelIndex]];
    const updated = setParagraphText(paras[numberIndex], tag);
    if (!updated) return cell;
    note(`  overview ${labels[labelIndex]} → ${tag}`);
    return cell.replace(paras[numberIndex], updated);
  });
}

/** Turns the second row of the vulnerabilities summary table into a loop row. */
function tagSummaryTableRow(xml) {
  return xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
    if (!textOf(table).includes('Vulnerability Description')) return table;

    const rows = [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
    const dataRow = rows.find((r) => textOf(r).includes('Missing Reauthentication'));
    if (!dataRow) {
      note('  MISSED   vulnerabilities summary row');
      return table;
    }

    const cells = [...dataRow.matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
    if (cells.length < 3) return table;

    // Opening the loop in the first cell and closing it in the last makes Word
    // repeat the whole row, once per finding.
    const values = [
      '{{#findings}}{{ .title }}',
      '{{ .severity | upper }}',
      '{{ .remediation }}{{/findings}}',
    ];

    let updatedRow = dataRow;
    cells.forEach((cell, index) => {
      const paras = [...cell.matchAll(/<w:p\b(?![a-zA-Z])[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g)].map(
        (m) => m[0]
      );
      const target = paras.find((p) => textOf(p).trim() !== '') ?? paras[0];
      if (!target) return;
      const rewritten = setParagraphText(target, values[index] ?? '');
      if (!rewritten) return;
      updatedRow = updatedRow.replace(cell, cell.replace(target, rewritten));
    });

    note('  loop     vulnerabilities summary row → {{#findings}}');
    return table.replace(dataRow, updatedRow);
  });
}

/** Replaces the conclusions callout with the engagement's conclusion section. */
function tagConclusions(xml) {
  return xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
    const text = textOf(table);
    if (!text.includes('Overview: As of now')) return table;

    const cellMatch = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/.exec(table);
    if (!cellMatch) return table;
    const cell = cellMatch[0];

    const paras = [...cell.matchAll(/<w:p\b(?![a-zA-Z])[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g)].map(
      (m) => m[0]
    );
    const contentParas = paras.filter((p) => textOf(p).trim() !== '');
    if (!contentParas.length) return table;

    // A raw tag must be alone in its paragraph, so keep the first paragraph as
    // the carrier and drop the rest of the boilerplate.
    const carrier = setParagraphText(contentParas[0], '{{@sections.conclusion.rich.text}}');
    if (!carrier) return table;

    let updatedCell = cell.replace(contentParas[0], carrier);
    for (const extra of contentParas.slice(1)) updatedCell = updatedCell.replace(extra, '');

    note('  section  REPORT CONCLUSIONS → {{@sections.conclusion.rich.text}}');
    return table.replace(cell, updatedCell);
  });
}

/** Wraps the per-finding detail block in a loop and tags its fields. */
function tagFindingsDetail(xml) {
  const blocks = splitBlocks(xml);

  const indexOfParagraph = (predicate, from = 0) => {
    for (let i = from; i < blocks.length; i += 1) {
      if (blocks[i].kind === 'p' && predicate(textOf(blocks[i].xml).trim(), blocks[i])) return i;
    }
    return -1;
  };

  // The detail block starts at the Heading2 that repeats the finding title.
  const titleIndex = indexOfParagraph(
    (text, block) =>
      text === 'Missing Reauthentication on API Key Deletion' &&
      /<w:pStyle w:val="Heading2"/.test(block.xml)
  );
  if (titleIndex === -1) {
    note('  MISSED   findings detail block (Heading2 title not found)');
    return xml;
  }

  // Each label paragraph is followed by a "TBA" placeholder to replace.
  const FIELD_BY_LABEL = {
    DESCRIPTION: '{{@rich.description}}',
    EVIDENCE: '{{@rich.poc}}',
    IMPACT: '{{@rich.observation}}',
    RECOMMENDATION: '{{@rich.remediation}}',
  };

  let lastIndex = titleIndex;
  for (const [label, tag] of Object.entries(FIELD_BY_LABEL)) {
    const labelIndex = indexOfParagraph((text) => text === label, titleIndex);
    if (labelIndex === -1) {
      note(`  MISSED   findings field "${label}"`);
      continue;
    }
    const tbaIndex = indexOfParagraph((text) => text === 'TBA', labelIndex + 1);
    if (tbaIndex === -1) {
      note(`  MISSED   placeholder under "${label}"`);
      continue;
    }
    const rewritten = setParagraphText(blocks[tbaIndex].xml, tag);
    if (rewritten) {
      blocks[tbaIndex].xml = rewritten;
      note(`  finding  ${label} → ${tag}`);
      lastIndex = Math.max(lastIndex, tbaIndex);
    }
  }

  // Retitle the heading, then fence the whole block with the loop tags.
  const retitled = setParagraphText(blocks[titleIndex].xml, '{{ .title }}');
  if (retitled) blocks[titleIndex].xml = retitled;

  blocks.splice(lastIndex + 1, 0, { kind: 'p', xml: controlParagraph('{{/findings}}') });
  blocks.splice(titleIndex, 0, { kind: 'p', xml: controlParagraph('{{#findings}}') });
  note('  loop     findings detail block → {{#findings}} … {{/findings}}');

  return joinBlocks(blocks);
}

/** Turns a single bullet into a loop over a list, repeating the bullet. */
function tagBulletLoop(xml, { matchText, list, content, label }) {
  const blocks = splitBlocks(xml);
  const index = blocks.findIndex(
    (b) => b.kind === 'p' && textOf(b.xml).trim() === matchText
  );
  if (index === -1) {
    note(`  MISSED   ${label} bullet ("${matchText}")`);
    return xml;
  }

  const rewritten = setParagraphText(blocks[index].xml, content);
  if (!rewritten) return xml;
  blocks[index].xml = rewritten;

  blocks.splice(index + 1, 0, { kind: 'p', xml: controlParagraph(`{{/${list}}}`) });
  blocks.splice(index, 0, { kind: 'p', xml: controlParagraph(`{{#${list}}}`) });
  note(`  loop     ${label} → {{#${list}}}`);
  return joinBlocks(blocks);
}

/** Removes a now-redundant bullet, identified by its exact text. */
function removeParagraph(xml, matchText, label) {
  const blocks = splitBlocks(xml);
  const index = blocks.findIndex((b) => b.kind === 'p' && textOf(b.xml).trim() === matchText);
  if (index === -1) {
    note(`  MISSED   removal of "${matchText}"`);
    return xml;
  }
  blocks.splice(index, 1);
  note(`  removed  ${label}`);
  return joinBlocks(blocks);
}

function applyParagraphReplacements(xml) {
  let out = xml;
  for (const { find, to } of PARAGRAPH_REPLACEMENTS) {
    let done = false;
    const result = eachParagraph(out, (paragraph, text) => {
      if (done || text.trim() !== find) return null;
      done = true;
      return setParagraphText(paragraph, to);
    });
    out = result.xml;
    note(done ? `  text     "${find}" → ${to}` : `  MISSED   paragraph "${find}"`);
  }
  return out;
}

function applyInlineReplacements(xml) {
  let out = xml;
  for (const { find, to } of INLINE_REPLACEMENTS) {
    const result = eachParagraph(out, (paragraph, text) => {
      if (!text.includes(find)) return null;
      return replaceAcrossRuns(paragraph, find, to);
    });
    out = result.xml;
    note(
      result.count
        ? `  inline   "${find}" → ${to} (${result.count}×)`
        : `  MISSED   inline "${find}"`
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */

/**
 * npm runs workspace scripts with the workspace as the working directory, so a
 * relative path typed at the repo root would otherwise resolve inside server/.
 * Try the caller's cwd first, then the repo root.
 */
async function resolveInput(argument) {
  if (!argument) return path.join(ROOT_DIR, 'REPORT_PENTESTING_TEMPLATE.docx');
  if (path.isAbsolute(argument)) return argument;

  for (const base of [process.cwd(), ROOT_DIR]) {
    const candidate = path.resolve(base, argument);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next base */
    }
  }
  throw new Error(
    `Cannot find "${argument}". Looked in ${process.cwd()} and ${ROOT_DIR}.`
  );
}

async function main() {
  const input = await resolveInput(process.argv[2]);
  const output = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : path.join(path.dirname(input), `${path.basename(input, '.docx')}-TAGGED.docx`);

  const buffer = await fs.readFile(input);
  const zip = new PizZip(buffer);
  const documentPart = zip.file('word/document.xml');
  if (!documentPart) throw new Error('Not a Word document: word/document.xml is missing');

  let xml = documentPart.asText();
  const before = xml.length;

  log.info(`Tagging ${path.basename(input)}`);

  // Order matters: the more specific inline strings are replaced before the
  // shorter ones they contain ("CLIENT APPLICATION" before "CLIENT").
  xml = applyParagraphReplacements(xml);
  xml = applyInlineReplacements(xml);
  xml = tagCounters(xml);
  xml = tagOverviewGrid(xml);
  xml = tagSummaryTableRow(xml);
  xml = tagConclusions(xml);
  xml = tagFindingsDetail(xml);

  // Scope: one bullet per scope group, replacing the two hand-written ones.
  xml = removeParagraph(xml, 'Network Penetration Test: IP-RANGE', 'second scope bullet');
  xml = tagBulletLoop(xml, {
    matchText: 'Web Penetration Test: {{ .scopeSummary }}',
    list: 'scope',
    content: "{{ .name | default:'In scope' }}: {{ .hostList }}",
    label: 'scope bullets',
  });

  // Project team: one bullet per collaborator.
  xml = tagBulletLoop(xml, {
    matchText: 'PERSON',
    list: 'collaborators',
    content: "{{ .fullname }}{{ .title | default:'' }}",
    label: 'project team bullet',
  });

  zip.file('word/document.xml', Buffer.from(xml, 'utf8'));

  // Footers carry a hand-typed year.
  for (const name of Object.keys(zip.files).filter((f) => /^word\/footer\d*\.xml$/.test(f))) {
    const footer = zip.file(name).asText();
    const blocks = splitBlocks(footer);
    let touched = false;
    for (const block of blocks) {
      if (block.kind !== 'p') continue;
      if (!textOf(block.xml).includes('X 2026')) continue;
      const rewritten = replaceAcrossRuns(block.xml, 'X 2026', "{{ .dateRaw | date:'MMMM yyyy' }}");
      if (rewritten) {
        block.xml = rewritten;
        touched = true;
      }
    }
    if (touched) {
      zip.file(name, Buffer.from(joinBlocks(blocks), 'utf8'));
      note(`  footer   ${name} → {{ .dateRaw | date:'MMMM yyyy' }}`);
    }
  }

  const out = zip.generate({
    type: 'nodebuffer',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(output, out);

  for (const line of report) log.info(line);
  const missed = report.filter((r) => r.includes('MISSED')).length;
  log.info(`document.xml ${before} → ${xml.length} bytes`);
  log.info(`Wrote ${output}`);
  if (missed) log.warn(`${missed} edit(s) did not find their target — check the list above.`);
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
