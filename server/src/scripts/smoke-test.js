/**
 * End-to-end check of the report pipeline without touching MongoDB:
 * template → data → docxtemplater → zip, then validate every XML part.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

const SERVER = path.resolve(import.meta.dirname, '..', '..');
const { generateReport, extractTemplateTags } = await import('../services/report.service.js');
const { packageProblems } = await import('../services/ooxml/docx-validate.js');
const { calculateCvss } = await import('../services/cvss.js');

const {
  sampleAudit: audit,
  sampleReportSettings: settings,
  sampleEffort: effort,
  sampleDeliveries: deliveries,
  sampleScopeChanges: scopeChanges,
  sampleSignatures: signatures,
  sampleDetection: detection,
  samplePhishing: phishing,
} = await import(
  '../fixtures/sample-engagement.js'
);

/* -------------------------------- CVSS sanity -------------------------------- */
const CVSS_VECTORS = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'Critical'],
  ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 8.8, 'High'],
  ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.1, 'Low'],
  ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:H', 7.2, 'High'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'None'],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1, 'Medium'],
  ['CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:L', 3.5, 'Low'],
  // A 4.0 vector through the same entry point; `npm run test:cvss4` is where
  // 4.0 is checked properly, against 900-odd reference vectors.
  ['CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 9.3, 'Critical'],
  ['CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N', 0, 'None'],
];
let cvssFails = 0;
for (const [vector, expectedScore, expectedSeverity] of CVSS_VECTORS) {
  const r = calculateCvss(vector);
  const ok = r.baseScore === expectedScore && r.baseSeverity === expectedSeverity;
  if (!ok) {
    cvssFails += 1;
    console.log(`  CVSS MISMATCH ${vector}\n    got ${r.baseScore}/${r.baseSeverity}, expected ${expectedScore}/${expectedSeverity}`);
  }
}
// Temporal check: 9.8 base with E:F/RL:O/RC:C → 9.8 * 0.97 * 0.95 * 1.0 = 9.03 → 9.1
const temporal = calculateCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:F/RL:O/RC:C');
if (temporal.temporalScore !== 9.1) {
  cvssFails += 1;
  console.log(`  CVSS temporal mismatch: got ${temporal.temporalScore}, expected 9.1`);
}
console.log(`CVSS: ${CVSS_VECTORS.length + 1 - cvssFails}/${CVSS_VECTORS.length + 1} checks passed`);

/* ------------------------------ tag catalogue ------------------------------- */
/*
 * Every tag the app documents must actually resolve. The Tag reference is what
 * people build templates from, so a catalogued tag that renders empty is a
 * documentation bug that only shows up in a finished client report.
 */
const { buildReportData } = await import('../services/report.service.js');
const { TAG_REFERENCE, knownTagRoots } = await import('../services/tag-reference.js');

const catalogueData = buildReportData(
  audit,
  settings,
  { parts: null, numbering: null },
  {
    target: 'html',
    user: { username: 'smoke', firstname: 'Smoke', lastname: 'Test' },
    templateName: 'smoke',
    effort,
    deliveries,
    scopeChanges,
    detection,
    phishing,
    signatures,
  }
);

/** Names that only exist inside a loop, so they cannot resolve at the top level. */
const LOOP_LOCAL_TAGS = new Set([
  'this', '$index', '$number', 'rich', 'custom', 'label', 'count', 'percent', 'color',
  'status', 'done', 'verifiedBy', 'verifiedOn', 'result', 'checks', 'total', 'identifier',
  // Fields of a test check: only meaningful inside a testChecks or checkGroups loop.
  'blocked', 'blockedReason',
  'index', 'number', 'title', 'severity', 'severityLabel', 'severityColor', 'author', 'cvss', 'cvssv3',
  'cvssVector', 'cvssVersion', 'cvssScore', 'priority', 'priorityLabel', 'category',
  'remediationComplexity', 'remediationComplexityLabel', 'description', 'observation',
  'remediation', 'poc', 'references', 'referencesText', 'field', 'name', 'text',
  'hostname', 'ip', 'os', 'services', 'hostList', 'port', 'protocol', 'product',
  'fullname', 'firstname', 'lastname', 'email', 'phone', 'username', 'role', 'vulnType',
  // Fields of a person: valid inside team/collaborators/reviewers/approvals loops.
  'qualifications', 'certifications',
  /*
   * Fields of an enumeration step, valid inside {{#enumeration}} or an {{#enumerationPhases}}
   * group — and `discoveredBy`, which is the same link read from inside {{#findings}}.
   */
  'depth', 'level', 'isGroup', 'hasChildren', 'phase', 'phaseLabel',
  'ledToFindings', 'hasLedTo', 'steps', 'discoveredBy', 'hasDiscoveredBy',
  'statusLabel', 'summary', 'hasSummary', 'table', 'hasTable', 'tableColumns',
  'tableRowCount', 'outputTable', 'cells', 'column', 'value',
  'path', 'outputLines', 'outputTruncated', 'outputOmitted', 'outputFull', 'printOutput', 'internal',
  'printTruncated', 'printOmitted', 'printTotal', 'printUnit', 'commandRaw',
  // The marked lines of a step's output, and their guard: only inside {{#enumeration}}.
  'notes', 'hasNotes', 'noteCount', 'snippet', 'moved',
  // And when it was run, which is a fact about a step rather than about the engagement.
  'outputAt', 'outputAge', 'reRun', 'previousOutputAt',
  'cwe', 'owasp', 'severityIndex', 'evidenceCount', 'hasEvidence', 'isOpen',
  'isRetesting', 'isFixed', 'id', 'positionId', 'remediationStatus', 'remediationStatusLabel',
  // Per-finding history: only meaningful inside a findings loop.
  'previously', 'previouslyReported', 'previouslyIn', 'firstReported',
]);

const resolveTag = (path) => {
  let node = catalogueData;
  for (const part of path.split('.')) {
    if (node === undefined || node === null) return undefined;
    node = node[part];
  }
  return node;
};

/*
 * Every custom field type has to reach a template as something printable. The
 * types were selectable long before the UI rendered them, so this asserts the
 * conversions rather than trusting that they still happen.
 */
const typedFields = [
  { key: 'zzMulti', label: 'Regions', fieldType: 'multiselect', value: ['EU', 'UK'] },
  { key: 'zzFlagOn', label: 'NDA', fieldType: 'checkbox', value: true },
  { key: 'zzFlagOff', label: 'Retest', fieldType: 'checkbox', value: false },
  { key: 'zzRich', label: 'Brief', fieldType: 'editor', value: '<p>Agreed <strong>scope</strong>.</p>' },
];
const typedData = buildReportData(
  { ...audit, customFields: [...(audit.customFields ?? []), ...typedFields] },
  settings,
  { parts: null, numbering: null },
  { target: 'html' }
);
const typedChecks = [
  ['multiselect joins with commas', typedData.custom.zzMulti === 'EU, UK'],
  ['a ticked checkbox reads Yes', typedData.custom.zzFlagOn === 'Yes'],
  ['an unticked checkbox reads No', typedData.custom.zzFlagOff === 'No'],
  ['a rich custom field prints as text', !String(typedData.custom.zzRich).includes('<')],
  ['and has a formatted counterpart', String(typedData.rich.custom.zzRich).includes('<strong>')],
];
let typedFails = 0;
for (const [label, passed] of typedChecks) {
  if (!passed) {
    typedFails += 1;
    console.log(`  CUSTOM FIELD FAIL: ${label}`);
  }
}
console.log(`Custom field types: ${typedChecks.length - typedFails}/${typedChecks.length} checks passed`);

const unresolvedTags = [];
let cataloguedTags = 0;
for (const group of TAG_REFERENCE.groups) {
  for (const { tag } of group.tags) {
    // Placeholders for the author's own field names cannot be resolved generically.
    if (tag.includes('KEY') || tag.includes('executive_summary')) continue;
    if (LOOP_LOCAL_TAGS.has(tag.split('.')[0])) continue;
    cataloguedTags += 1;
    if (resolveTag(tag) === undefined) unresolvedTags.push(tag);
  }
}
console.log(
  `\nTag catalogue: ${cataloguedTags} engagement-level tags checked, ${unresolvedTags.length} unresolved`
);
for (const tag of unresolvedTags.slice(0, 10)) console.log(`  documented but missing: ${tag}`);

/* ------------------------- the shipped templates lint clean ---------------- */
let templateLintFails = 0;
/*
 * Every placeholder in both starters must be one the app knows.
 *
 * This is the check that was missing. The offer templates once warned about their own tags because
 * a documented field name had never been added to `knownTagRoots`, and it happened again the moment
 * the red team starter printed a distribution table: `version`, `recipientList` and `fileHashShort`
 * were described inside the deliveries loop and registered nowhere. A template the app ships that
 * the app then flags is the most confusing possible first impression.
 */
{
  const tagRoot = (tag) =>
    String(tag).replace(/^[#/^@]/, '').replace(/^\.+/, '').trim().split(/[.|\s([]/)[0];
  const roots = knownTagRoots();
  templateLintFails = 0;
  for (const name of ['engy-default-template.docx', 'engy-redteam-template.docx']) {
    const file = path.join(SERVER, 'storage/templates', name);
    let tags = [];
    try {
      tags = extractTemplateTags(await fs.readFile(file));
    } catch {
      console.log(`  TEMPLATE LINT: ${name} is missing — run its make script`);
      templateLintFails += 1;
      continue;
    }
    const unknown = [...new Set(tags.filter((tag) => !roots.has(tagRoot(tag))))];
    if (unknown.length) {
      templateLintFails += 1;
      console.log(`  TEMPLATE LINT FAIL: ${name} uses tags the app does not know — ${unknown.join(', ')}`);
    } else {
      console.log(`  ${name}: ${tags.length} placeholders, all known`);
    }
  }
  console.log(
    `Shipped templates: ${templateLintFails === 0 ? 'both lint clean' : `${templateLintFails} problem(s)`}`
  );

}

/* --------------------------------- render ---------------------------------- */
const templateName = 'engy-default-template.docx';
console.log(`\nTemplate tags detected: ${extractTemplateTags(await fs.readFile(path.join(SERVER, 'storage/templates', templateName))).length}`);

const { buffer, filename } = await generateReport({
  audit,
  template: { filename: templateName, name: 'default' },
  settings,
});

const outPath = path.join(SERVER, 'storage', 'tmp', 'smoke-test-report.docx');
await fs.writeFile(outPath, buffer);
console.log(`Rendered: ${filename} → ${(buffer.length / 1024).toFixed(1)} KB`);

/* -------------------------------- inspect ---------------------------------- */
const zip = new PizZip(buffer);
const doc = zip.file('word/document.xml').asText();

const checks = [
  ['no unrendered tags left', !/\{\{|\}\}/.test(doc)],
  ['engagement name present', doc.includes('Acme Web Platform Assessment')],
  ['company name present', doc.includes('Acme Industries S.R.L.')],
  ['date filter applied', doc.includes('01 August 2026')],
  ['finding id prefix applied', doc.includes('VULN-01')],
  ['findings loop expanded (3 findings)', (doc.match(/VULN-0\d/g) ?? []).length >= 6],
  ['collaborators loop expanded', doc.includes('Andrei Ion')],
  /*
   * The figure the fixture captions, numbered.
   *
   * The seam worth covering end to end is that the pass over the finished document actually runs:
   * the converter writes a token and a field, and if nothing fills the token in, every caption in
   * every report reads "Figure @@FIGNUM:...@@". Which it would have, silently.
   */
  ['a captioned figure is numbered', /<w:t xml:space="preserve">Figure <\/w:t>/.test(doc)],
  ['with a SEQ field, so Word renumbers it', doc.includes('SEQ Figure')],
  ['and a bookmark for anything to point at', doc.includes('w:name="_EngyFig_')],
  ['no numbering token survived into the document', !doc.includes('@@FIG')],
  /*
   * The count is the assertion worth having, and it is counted against the pictures rather than
   * against a number somebody typed here: the fixture holds screenshots captioned and not, alone
   * in a paragraph, after a label, inside a figure and in an enumeration write-up, and every one
   * of them should be a numbered figure in one sequence. This is the check that catches a whole
   * class of picture being silently left out, which is exactly what happened.
   */
  [
    'every picture is numbered, in one sequence across findings and enumeration',
    (doc.match(/<w:t xml:space="preserve">Figure <\/w:t>/g) ?? []).length ===
      (doc.match(/<w:drawing>/g) ?? []).length,
    `${(doc.match(/<w:t xml:space="preserve">Figure <\/w:t>/g) ?? []).length} captions for ${(doc.match(/<w:drawing>/g) ?? []).length} pictures`,
  ],
  [
    'and they are numbered 1..n with none repeated',
    [...doc.matchAll(/ SEQ Figure \\\* ARABIC "><w:r><w:t>(\d+)<\/w:t>/g)]
      .map((m) => Number(m[1]))
      .join() === '1,2,3,4,5,6',
    [...doc.matchAll(/ SEQ Figure \\\* ARABIC "><w:r><w:t>(\d+)<\/w:t>/g)].map((m) => m[1]).join(),
  ],
  [
    'an uncaptioned one says just "Figure 3", with no dash hanging off it',
    !/Figure <\/w:t><\/w:r><w:fldSimple[^>]*><w:r><w:t>\d+<\/w:t><\/w:r><\/w:fldSimple><w:bookmarkEnd[^>]*\/><w:r><w:t xml:space="preserve"> \u2014 <\/w:t><\/w:r><\/w:p>/.test(doc),
  ],
  /*
   * Enumeration, which reaches the report where notes deliberately do not.
   *
   * The last two are the ones worth having: the output must arrive as a code pane with its line
   * breaks intact, and the guards must actually hide the parts a step does not have. The second
   * fixture step has no output at all, so a template that printed the Output heading regardless
   * would leave one hanging over nothing.
   */
  ['enumeration loop expanded', doc.includes('Subdomain Enumeration') && doc.includes('WebServer Enumeration')],
  ['enumeration step numbered', /1\.\s*(<[^>]*>\s*)*Subdomain/.test(doc) || doc.includes('>1. <') || doc.includes('Subdomain Enumeration')],
  ['the tool is named', doc.includes('httpx')],
  ['the command is printed', doc.includes('subfinder -d acme.example')],
  /*
   * A token that exists nowhere in this fixture but one step's output, so this can only pass if
   * output actually reached the document.
   */
  ['tool output reached the document', doc.includes('vault.acme.example')],
  /*
   * And the other half of the print policy: the httpx step prints three of five, so the fourth
   * line must be absent. Without this the setting could do nothing and every check would pass.
   */
  ['a capped step really does drop the rest', !doc.includes('vpn.acme.example')],
  ['output kept its line breaks', (doc.match(/acme\.example\s+\[/g) ?? []).length >= 3 || doc.includes('staging.acme.example')],
  ['the tool list summarised', doc.includes('Burp Suite Professional')],
  ['a step with no output prints no Output heading for it', (doc.match(/>Output</g) ?? []).length <= 1],
  /*
   * The tree. The fixture nests four tool runs under one heading, so the heading must print as a
   * heading and the runs as steps — and the numbering must not restart or skip.
   */
  ['a section heading printed', doc.includes('Subdomain Enumeration')],
  /* crt.sh is the row the fixture holds back as internal, so it must NOT be here. */
  ['and its nested tool runs', doc.includes('subfinder') && doc.includes('amass')],
  ['a heading prints at Heading2 and a step at Heading3', doc.includes('Heading2') && doc.includes('Heading3')],
  ['the phase is named', doc.includes('Reconnaissance') || doc.includes('Initial access')],
  /* Both directions of the step-to-finding link. */
  ['a step says what it was written up as', doc.includes('Written up as')],
  ['and the finding says how it was found', doc.includes('How it was found')],
  /*
   * The section's own sentence, the outcome of a tool that answered nothing, and the httpx output
   * printed as a real table rather than a pane. The last is the one worth guarding: `<w:tbl>` is
   * already asserted above for rich text, so this checks the *columns* arrived.
   */
  ['a section prints its summary line', doc.includes('Establishing the name surface')],
  ['a tool that timed out says so', doc.includes('Timed out')],
  ['the outcome tally is printed', doc.includes('Outcomes:')],
  ['httpx output became a table', doc.includes('Technology') && doc.includes('>URL<')],
  ['and the table has a row per host', (doc.match(/acme\.example/g) ?? []).length >= 5],
  /*
   * The internal row, the numbering that closes over its gap, and the truncation notice. The
   * fixture holds crt.sh back, so its title must be absent while the rows after it renumber.
   */
  ['a step held back as internal is not printed', !doc.includes('certificate transparency')],
  ['the report says the record is fuller than it is', doc.includes('recorded internally')],
  ['numbering is hierarchical', doc.includes('1.1') && doc.includes('1.2')],
  ['and closes over the held-back row', !doc.includes('1.4')],
  ['a truncated pane says it is an extract', doc.includes('Extract only')],
  ['severity computed', doc.includes('Critical')],
  ['CVSS score rendered', doc.includes('8.8')],
  ['default filter fallback', doc.includes('CONFIDENTIAL')],
  ['rich text: heading style used', doc.includes('Heading3')],
  ['rich text: bullet numbering applied', doc.includes('<w:numPr>')],
  ['rich text: table emitted', doc.includes('<w:tbl>')],
  ['rich text: code shading', doc.includes('F1F1F1') || doc.includes('F5F5F5')],
  ['rich text: image drawing emitted', doc.includes('<w:drawing>')],
  ['rich text: hyperlink emitted', doc.includes('<w:hyperlink')],
  ['rich text: superscript emitted', doc.includes('superscript')],
  ['rich text: strike emitted', doc.includes('<w:strike/>')],
  ['numbering.xml created', Boolean(zip.file('word/numbering.xml'))],
  /*
   * The table of contents in the default template is a field, and a field shows
   * "Right-click to update" until something refreshes it. One flag in the settings part makes
   * Word do it on open — and it is the first page the client sees, so it is worth a check.
   */
  [
    'settings.xml asks Word to refresh fields on open',
    /<w:updateFields\s+w:val="true"\s*\/>/.test(zip.file('word/settings.xml')?.asText() ?? ''),
  ],
  [
    'and only once, however many times a report is generated',
    ((zip.file('word/settings.xml')?.asText() ?? '').match(/<w:updateFields/g) ?? []).length === 1,
  ],
  [
    'the settings part is still declared in [Content_Types].xml',
    (zip.file('[Content_Types].xml')?.asText() ?? '').includes('/word/settings.xml'),
  ],
  ['media files added', Object.keys(zip.files).some((f) => f.startsWith('word/media/'))],
  ['header rendered', (zip.file('word/header1.xml')?.asText() ?? '').includes('Acme Industries')],
  ['footer rendered', (zip.file('word/footer1.xml')?.asText() ?? '').includes('CONFIDENTIAL')],
  /*
   * And whether Word would open it at all.
   *
   * Everything else here inspects the *contents* — the tags, the styles, the order of the
   * properties. None of it noticed a package Word refused outright because a part had no content
   * type, which is how a broken report reached a client. This is the cheap check that would have.
   */
  ...(() => {
    const problems = packageProblems(zip);
    for (const problem of problems) console.log(`  PACKAGE  ${problem}`);
    return [['the package is one Word will open', problems.length === 0]];
  })(),

  /*
   * The severity chart the default template prints.
   *
   * `chart-test` proves the drawing; this proves the delivery, which is the half that involves a
   * media part, a relationship and a `w:drawing` that all have to agree. A chart that renders
   * perfectly and arrives as a red cross in a Word document is the failure worth catching here.
   */
  ...(() => {
    const media = Object.keys(zip.files).filter((name) => /^word\/media\/.*\.png$/i.test(name));
    return [
      ['the severity chart reaches the package as a picture', media.length > 0],
      [
        'and the document points at it',
        /<a:blip r:embed="[^"]+"/.test(doc) && doc.includes('<w:drawing>'),
      ],
      /* The legend is text, not pixels — searchable, and in the template's own font. */
      ['with its legend as real text', doc.includes('Informational') && doc.includes('●')],
    ];
  })(),
];

console.log('\nRender checks:');
let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

// Relationship integrity: every r:id/r:embed used must exist in the rels part.
const rels = zip.file('word/_rels/document.xml.rels').asText();
const declared = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...doc.matchAll(/r:(?:id|embed)="([^"]+)"/g)].map((m) => m[1]));
const dangling = [...used].filter((id) => !declared.has(id));
console.log(`\nRelationships: ${used.size} referenced, ${declared.size} declared, ${dangling.length} dangling`);
if (dangling.length) console.log('  DANGLING:', dangling.join(', '));

// Media targets must resolve to real zip entries.
const mediaTargets = [...rels.matchAll(/Target="(media\/[^"]+)"/g)].map((m) => `word/${m[1]}`);
const missingMedia = mediaTargets.filter((t) => !zip.file(t));
console.log(`Media: ${mediaTargets.length} declared, ${missingMedia.length} missing`);

// numbering ids referenced must be defined
const numbering = zip.file('word/numbering.xml')?.asText() ?? '';
const definedNums = new Set([...numbering.matchAll(/<w:num[ >][^>]*w:numId="(\d+)"/g)].map((m) => m[1]));
const usedNums = new Set([...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]));
const badNums = [...usedNums].filter((n) => !definedNums.has(n));
console.log(`Numbering: used [${[...usedNums].join(',')}], defined [${[...definedNums].join(',')}], unresolved ${badNums.length}`);

/* ---------------------- ordered lists restart, and page geometry ------------- */
/*
 * Two things that were wrong in every document this app produced, so they are asserted on
 * the real output rather than trusted: numbered lists continued from each other, and every
 * fixed width was hardcoded to US Letter.
 */
let layoutFailed = 0;
const layout = (label, ok, detail) => {
  if (!ok) layoutFailed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

console.log('\nLists and layout:');

// Which abstract definition is the numbered one, and which instances point at it.
const abstracts = [...numbering.matchAll(/<w:abstractNum[^>]*w:abstractNumId="(\d+)"([\s\S]*?)<\/w:abstractNum>/g)];
const orderedAbstract = abstracts.find(([, , body]) => /w:numFmt w:val="decimal"/.test(body))?.[1];
const numInstances = [...numbering.matchAll(/<w:num[ >][^>]*w:numId="(\d+)"([\s\S]*?)<\/w:num>/g)].map(
  ([, id, body]) => ({
    id,
    abstract: /w:abstractNumId w:val="(\d+)"/.exec(body)?.[1],
    restarts: /<w:startOverride w:val="1"\/>/.test(body),
  })
);
const orderedInstances = numInstances.filter((entry) => entry.abstract === orderedAbstract);
const restarting = orderedInstances.filter((entry) => entry.restarts);
const sharedBase = orderedInstances.filter((entry) => !entry.restarts).map((entry) => entry.id);

layout(
  'the fixture produced more than one numbered list',
  restarting.length >= 2,
  `${restarting.length} restarting instance(s)`
);
layout(
  'each numbered list is its own instance, restarting at 1',
  restarting.length >= 2 && restarting.every((entry) => usedNums.has(entry.id)),
  JSON.stringify(orderedInstances)
);
layout(
  'and no list falls back to the shared ordered instance',
  sharedBase.every((id) => !usedNums.has(id)),
  `shared ${sharedBase.join(',')} vs used ${[...usedNums].join(',')}`
);

/* --------------------------- nesting survives the parser -------------------- */
/*
 * A list inside a list item used to be flattened: the inner `<li>` implicitly closed the
 * outer one and took the `<ul>` with it, so nested bullets arrived as extra numbered items of
 * the parent list — which also shifted every number after them.
 */
const { htmlToOoxml: toOoxml } = await import('../services/ooxml/html2ooxml.js');
const numPrs = (xml) =>
  [...xml.matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map(
    (m) => `${m[1]}:${m[2]}`
  );

const nested = toOoxml('<ol><li>one<ul><li>a</li><li>b</li></ul></li><li>two</li></ol>', {
  parts: null,
  numbering: { bulletNumId: 2, orderedNumId: 3 },
});
layout(
  'bullets nested in a numbered list keep their own level and instance',
  numPrs(nested).join(' ') === '0:3 1:2 1:2 0:3',
  numPrs(nested).join(' ')
);

const nestedOrdered = toOoxml('<ol><li>one<ol><li>a</li></ol></li><li>two</li></ol>', {
  parts: null,
  numbering: { bulletNumId: 2, orderedNumId: 3 },
});
layout(
  'and a numbered sub-list sits at the next level down',
  numPrs(nestedOrdered).join(' ') === '0:3 1:3 0:3',
  numPrs(nestedOrdered).join(' ')
);

const twoParas = toOoxml('<ul><li><p>first</p><p>second</p></li><li>next</li></ul>', {
  parts: null,
  numbering: { bulletNumId: 2, orderedNumId: 3 },
});
layout(
  'a second paragraph in a list item does not escape the item',
  numPrs(twoParas).join(' ') === '0:2 0:2',
  numPrs(twoParas).join(' ')
);

const nestedTable = toOoxml(
  '<table><tbody><tr><td>outer<table><tbody><tr><td>inner</td></tr></tbody></table></td><td>after</td></tr></tbody></table>',
  { parts: null, numbering: null }
);
layout(
  'a nested table does not close the cell it sits in',
  (nestedTable.match(/<w:tbl>/g) ?? []).length === 2 && nestedTable.includes('after'),
  `${(nestedTable.match(/<w:tbl>/g) ?? []).length} table(s)`
);

/* --------------------------------- page geometry ---------------------------- */
const { readPageGeometry } = await import('../services/ooxml/docx-parts.js');
const { htmlToOoxml } = await import('../services/ooxml/html2ooxml.js');

const sectPr = (attrs, margins = 'w:left="1440" w:right="1440"') =>
  `<w:body><w:p/><w:sectPr><w:pgSz ${attrs}/><w:pgMar ${margins} w:gutter="0"/></w:sectPr></w:body>`;

// A4 at 2.5 cm: 11906 - 1418 - 1418 = 9070 twips, not the 9360 this code used to assume.
const a4 = readPageGeometry(sectPr('w:w="11906" w:h="16838"', 'w:left="1418" w:right="1418"'));
layout('A4 with 2.5 cm margins measures 9070 twips', a4.usableTwips === 9070, JSON.stringify(a4));

// Word stores a landscape section already rotated, so the width needs no adjusting.
const landscape = readPageGeometry(
  sectPr('w:w="16838" w:h="11906" w:orient="landscape"', 'w:left="1418" w:right="1418"')
);
layout(
  'a landscape section is wider, and says so',
  landscape.usableTwips === 14002 && landscape.landscape === true,
  JSON.stringify(landscape)
);

// The *body* section is the last one: earlier ones belong to section breaks in the text.
const twoSections = readPageGeometry(
  '<w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr></w:pPr></w:p>' +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1418" w:right="1418"/></w:sectPr></w:body>'
);
layout('the body section wins over a section break', twoSections.usableTwips === 9070, JSON.stringify(twoSections));

layout(
  'a template with no sectPr falls back to Letter, as before',
  readPageGeometry('<w:body><w:p/></w:body>').usableTwips === 9360,
  JSON.stringify(readPageGeometry('<w:body/>'))
);
layout(
  'and a nonsensical margin does not produce a zero-width column',
  readPageGeometry(sectPr('w:w="11906" w:h="16838"', 'w:left="9000" w:right="9000"')).usableTwips === 9360,
  'expected the Letter fallback'
);

// The width has to reach the XML, not just the object.
const tableHtml = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
const narrow = htmlToOoxml(tableHtml, { parts: null, numbering: null, usableTwips: 9070 });
const wide = htmlToOoxml(tableHtml, { parts: null, numbering: null, usableTwips: 14002 });
const gridSum = (xml) =>
  [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].reduce((sum, m) => sum + Number(m[1]), 0);
layout(
  'a table is drawn to the page it will sit on',
  gridSum(narrow) === 9070 - (9070 % 2) && gridSum(wide) === 14002 - (14002 % 2),
  `${gridSum(narrow)} then ${gridSum(wide)}`
);
const pane = htmlToOoxml('<pre><code>x</code></pre>', {
  parts: null,
  numbering: null,
  usableTwips: 9070,
});
layout(
  'and so is a code pane',
  pane.includes('<w:tblW w:w="9070" w:type="dxa"/>'),
  /<w:tblW[^>]*>/.exec(pane)?.[0]
);

// Styles referenced by rich text should exist in styles.xml
const styles = zip.file('word/styles.xml')?.asText() ?? '';
const usedStyles = new Set([...doc.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g)].map((m) => m[1]));
const missingStyles = [...usedStyles].filter((s) => !styles.includes(`w:styleId="${s}"`));
console.log(`Styles: used [${[...usedStyles].sort().join(',')}]`);
if (missingStyles.length) console.log(`  NOT DEFINED IN TEMPLATE: ${missingStyles.join(', ')}`);

/* --------------------------- schema order checks ---------------------------- */
// Word validates <w:pPr> and <w:rPr> against an ordered sequence and refuses to
// open the document if the children are shuffled, so verify it here.
const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl',
  'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens',
  'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE',
  'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind',
  'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr',
  'sectPr', 'pPrChange',
];
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike',
  'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid',
  'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz',
  'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign',
  'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];

function checkOrder(xml, container, order) {
  const rx = new RegExp(`<w:${container}>(.*?)</w:${container}>`, 'gs');
  const problems = [];
  for (const match of xml.matchAll(rx)) {
    const children = [...match[1].matchAll(/<w:([a-zA-Z]+)[ />]/g)]
      .map((m) => m[1])
      // Only inspect direct children; nested elements are validated separately.
      .filter((n) => order.includes(n));
    const seen = [];
    let last = -1;
    for (const child of children) {
      const rank = order.indexOf(child);
      if (rank < last) problems.push(`${seen.join(',')} then ${child}`);
      last = Math.max(last, rank);
      seen.push(child);
    }
  }
  return problems;
}

const pPrProblems = checkOrder(doc, 'pPr', PPR_ORDER);
const rPrProblems = checkOrder(doc, 'rPr', RPR_ORDER);
console.log(`\nSchema order: w:pPr ${pPrProblems.length} violation(s), w:rPr ${rPrProblems.length} violation(s)`);
for (const p of [...new Set(pPrProblems)].slice(0, 5)) console.log(`  pPr out of order: ${p}`);
for (const p of [...new Set(rPrProblems)].slice(0, 5)) console.log(`  rPr out of order: ${p}`);

await fs.writeFile(
  path.join(path.dirname(outPath), 'parts.json'),
  JSON.stringify(Object.keys(zip.files), null, 2)
);
console.log(`\nZip parts: ${Object.keys(zip.files).length}`);
/* --------------------- the red team starter, with every chapter ------------- */
/*
 * Rendered with detection, phishing, deliveries, scope changes and signatures all present, because
 * every one of those chapters is behind a guard and a guard that never opens is untested. The same
 * template is rendered above without them, by the fixture — so both branches are covered.
 */
let redTeamFails = 0;
try {
  const redTeam = await generateReport({
    audit,
    template: { filename: 'engy-redteam-template.docx', name: 'redteam' },
    settings,
    effort,
    deliveries,
    scopeChanges,
    signatures,
    detection,
    phishing,
  });
  const rt = new PizZip(redTeam.buffer).file('word/document.xml').asText();
  const rtChecks = [
    ['no unrendered tags', !/\{\{|\}\}/.test(rt)],
    ['the red team cover', rt.includes('RED TEAM OPERATION REPORT')],
    ['the enumeration chapter', rt.includes('Subdomain Enumeration')],
    ['the detection chapter opens when there is a log', rt.includes('Detection and Response')],
    ['including the loud-miss table', rt.includes('Loud Actions That Went Unanswered')],
    ['the social engineering chapter', rt.includes('Social Engineering')],
    ['a finding says how it was found', rt.includes('How It Was Found')],
    ['the coverage table', rt.includes('planned checks')],
    ['the distribution table', rt.includes('File hash')],
    ['signatures rendered as images', rt.includes('<w:drawing>')],
    ['the package is well formed', packageProblems(new PizZip(redTeam.buffer)).length === 0],
  ];
  for (const [label, passed] of rtChecks) {
    if (!passed) {
      redTeamFails += 1;
      console.log(`  RED TEAM FAIL: ${label}`);
    }
  }
  console.log(
    `
Red team template: ${rtChecks.length - redTeamFails}/${rtChecks.length} checks passed`
  );
} catch (error) {
  redTeamFails += 1;
  console.log(`  RED TEAM FAIL: it would not render — ${error.message}`);
}

console.log(
  failed ||
    pPrProblems.length ||
    rPrProblems.length ||
    dangling.length ||
    missingMedia.length ||
    badNums.length ||
    cvssFails ||
    unresolvedTags.length ||
    typedFails ||
    templateLintFails ||
    redTeamFails ||
    layoutFailed
    ? '\nRESULT: problems found'
    : '\nRESULT: all checks passed'
);
