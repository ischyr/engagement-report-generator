/**
 * A fingerprint of everything in an engagement that reaches the client.
 *
 * A sign-off has to be a signature on *something*. Storing only "Bob approved"
 * means a report can be rewritten from top to bottom afterwards and still carry
 * Bob's name, which is worse than carrying nobody's: it looks like assurance.
 *
 * So each approval records the hash of the report content at the moment it was
 * given, and a signature whose hash no longer matches is shown as stale and does
 * not count towards a mandatory-review quorum.
 *
 * What is deliberately *not* in here is everything internal: notes, test checks,
 * comments, authorship, state, the approvals themselves. A colleague resolving a
 * comment or ticking a check must not invalidate a signature — none of it changes a
 * word the client reads.
 */

import crypto from 'node:crypto';

import { htmlToPlainText } from '../services/ooxml/html-parser.js';

/** Works whether the reference was populated or left as an id. */
const idOf = (value) => String(value?._id ?? value ?? '');
const str = (value) => (value === undefined || value === null ? '' : String(value));
/** Custom field values are Mixed, so their shape is whatever was stored. */
const json = (value) => JSON.stringify(value ?? null);

const customFields = (fields) =>
  (fields ?? []).map((field) => [str(field.key), str(field.fieldType), json(field.value)]);

/**
 * The report-visible projection, as nested arrays rather than an object: order is
 * explicit and no key ordering can drift between Node versions.
 */
export function reportContent(audit) {
  return [
    [
      'details',
      str(audit.name),
      str(audit.auditType),
      str(audit.language),
      str(audit.reference),
      str(audit.date),
      str(audit.date_start),
      str(audit.date_end),
      idOf(audit.company),
      idOf(audit.client),
      (audit.recipients ?? []).map(idOf),
      idOf(audit.template),
      // Order the reader sees, so switching automatic sorting off counts as a change.
      str(audit.sortFindings),
      customFields(audit.customFields),
    ],
    [
      'scope',
      (audit.scope ?? []).map((entry) => [
        str(entry.name),
        (entry.hosts ?? []).map((host) => [
          str(host.hostname),
          str(host.ip),
          str(host.os),
          (host.services ?? []).map((service) => [
            str(service.port),
            str(service.protocol),
            str(service.name),
            str(service.product),
          ]),
        ]),
      ]),
    ],
    [
      'findings',
      // Array order is included: with automatic sorting off it *is* the report's
      // order. With sorting on, a drag that changes nothing the client sees will
      // still show signatures as stale — the conservative direction to be wrong in.
      (audit.findings ?? []).map((finding) => [
        str(finding.identifier),
        str(finding.title),
        str(finding.vulnType),
        str(finding.description),
        str(finding.observation),
        str(finding.remediation),
        str(finding.remediationComplexity),
        str(finding.priority),
        (finding.references ?? []).map(str),
        str(finding.cvssv3),
        str(finding.scope),
        str(finding.poc),
        str(finding.remediationStatus),
        str(finding.category),
        str(finding.sortIndex),
        customFields(finding.customFields),
      ]),
    ],
    [
      'sections',
      (audit.sections ?? []).map((section) => [
        str(section.field),
        str(section.name),
        str(section.text),
        customFields(section.customFields),
      ]),
    ],
  ];
}

/**
 * 128 bits of sha256, hex. Short enough to read in a database row, long enough that
 * two different reports colliding is not a thing that happens.
 */
export function reportFingerprint(audit) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(reportContent(audit)))
    .digest('hex')
    .slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* The same content, itemised                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The fingerprint answers "has it changed". This answers "what changed".
 *
 * `contentFingerprint` is one hash over the whole report, which is exactly right for the question
 * it was built for — is this signature still valid, has the client's copy gone stale — and useless
 * for the question that follows it. A delivery register that can say "version 1.0 is out of date"
 * and not "these two findings are new and this one was rescored" makes somebody open both documents
 * and read.
 *
 * So: the same report-visible projection, hashed per item and per field instead of all at once, and
 * small enough to keep on every render — about ten characters per field, a few kilobytes for a
 * large engagement. Two snapshots subtract to a list of facts.
 *
 * **`reportContent` above is deliberately untouched.** Its output is what every stored signature
 * was taken over; changing the shape by a byte would show every sign-off in the instance as stale.
 * These field lists are read by the snapshot only — `reportContent` still spells its own out, and
 * `npm run test:report-diff` pins its fingerprint against a fixture so the two cannot drift apart
 * without somebody being told.
 */

/** Ten hex characters of sha256. Enough that two different field values colliding does not happen. */
const h = (value) =>
  crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 10);

/**
 * The fields of a finding, named as the person reading the diff would name them.
 *
 * The labels are the report's words, not the schema's: `observation` is the impact and `poc` is the
 * proof of concept everywhere a human sees them, and a change list that says "observation changed"
 * sends somebody looking for a field that is not on their screen.
 */
const FINDING_FIELDS = [
  ['title', (f) => str(f.title)],
  ['identifier', (f) => str(f.identifier)],
  ['type', (f) => str(f.vulnType)],
  ['category', (f) => str(f.category)],
  ['description', (f) => str(f.description)],
  ['impact', (f) => str(f.observation)],
  ['remediation', (f) => str(f.remediation)],
  ['remediation complexity', (f) => str(f.remediationComplexity)],
  ['remediation status', (f) => str(f.remediationStatus)],
  ['priority', (f) => str(f.priority)],
  ['references', (f) => (f.references ?? []).map(str).join('\n')],
  ['score', (f) => str(f.cvssv3)],
  ['affected assets', (f) => str(f.scope)],
  ['proof of concept', (f) => str(f.poc)],
  ['order', (f) => str(f.sortIndex)],
  ['custom fields', (f) => json(customFields(f.customFields))],
];

const SECTION_FIELDS = [
  ['name', (s) => str(s.name)],
  ['text', (s) => str(s.text)],
  ['custom fields', (s) => json(customFields(s.customFields))],
];

const DETAIL_FIELDS = [
  ['name', (a) => str(a.name)],
  ['type', (a) => str(a.auditType)],
  ['language', (a) => str(a.language)],
  ['reference', (a) => str(a.reference)],
  ['date', (a) => str(a.date)],
  ['start date', (a) => str(a.date_start)],
  ['end date', (a) => str(a.date_end)],
  ['company', (a) => idOf(a.company)],
  ['client', (a) => idOf(a.client)],
  ['recipients', (a) => (a.recipients ?? []).map(idOf).join(',')],
  ['template', (a) => idOf(a.template)],
  ['finding order', (a) => str(a.sortFindings)],
  ['custom fields', (a) => json(customFields(a.customFields))],
];

/** One scope group, hashed whole: "the API group changed" is as fine-grained as this needs to be. */
const scopeEntry = (entry) => ({
  id: str(entry.name),
  label: str(entry.name) || 'Unnamed group',
  fields: {
    hosts: h(
      JSON.stringify(
        (entry.hosts ?? []).map((host) => [
          str(host.hostname),
          str(host.ip),
          str(host.os),
          (host.services ?? []).map((service) => [
            str(service.port),
            str(service.protocol),
            str(service.name),
            str(service.product),
          ]),
        ])
      )
    ),
  },
});

/**
 * Which fields are worth keeping the words of, and how many.
 *
 * A snapshot has always stored hashes, which answers *"the remediation on VULN-03 changed"* and can
 * never answer *"changed from what to what"* — the question a client actually asks about a document
 * they have already read. So the prose fields keep their text as well.
 *
 * ## The cost, and what bounds it
 *
 * Text costs storage on every render, for ever, and a finding's description can be two hundred
 * thousand characters. Three limits keep that from becoming a second copy of the engagement:
 *
 *   - **Only prose.** A score, an order, a custom-field blob diff to nothing readable; their hashes
 *     already say they changed, which is all a reader wants.
 *   - **Plain text.** The markup is not what changed in any sentence anybody is reading.
 *   - **Per field and overall.** 3,000 characters a field — comfortably past a real write-up — and
 *     a 250 KB budget per snapshot, spent in order. Past it, fields keep their hashes and the diff
 *     says it is too long to show rather than pretending nothing moved.
 */
const DIFFABLE = new Set([
  'title',
  'description',
  'impact',
  'remediation',
  'proof of concept',
  'affected assets',
  'name',
  'text',
]);
const FIELD_CHARS = 3000;
const SNAPSHOT_CHARS = 250_000;

/** The words of a field, if it is one worth keeping and there is budget left. */
const itemise = (item, fields, { id, label }, budget) => {
  const out = { id, label, fields: {}, text: {} };
  for (const [name, read] of fields) {
    const value = read(item);
    out.fields[name] = h(value);
    if (!DIFFABLE.has(name)) continue;
    const words = htmlToPlainText(String(value ?? '')).trim();
    if (!words) continue;
    const kept = words.slice(0, FIELD_CHARS);
    if (budget.left < kept.length) continue;
    budget.left -= kept.length;
    out.text[name] = kept;
  }
  return out;
};

/**
 * @param {object} audit a fully loaded engagement — a projected one would report false removals
 * @returns {object} `{ v, details, findings, sections, scope }`
 */
export function reportSnapshot(audit) {
  /*
   * One budget for the whole snapshot, spent in the order the fields are visited.
   *
   * Findings first, because they are what a reader compares; a hundred-section engagement cannot
   * spend the allowance before the findings get any.
   */
  const budget = { left: SNAPSHOT_CHARS };

  const findings = (audit.findings ?? []).map((finding) =>
    itemise(
      finding,
      FINDING_FIELDS,
      { id: idOf(finding), label: str(finding.title) || 'Untitled finding' },
      budget
    )
  );
  const sections = (audit.sections ?? []).map((section) =>
    itemise(
      section,
      SECTION_FIELDS,
      {
        id: idOf(section) || str(section.field),
        label: str(section.name) || str(section.field) || 'Unnamed section',
      },
      budget
    )
  );

  return {
    /*
     * Stamped, so a stored snapshot from an older shape can be reported as incomparable rather
     * than silently diffed against a newer one and reported as a hundred changes.
     *
     * 2 since the prose fields started carrying their words. A version-1 snapshot compares against
     * a version-2 one as "incomparable", which is right: the hashes are identical in both, but a
     * reader shown a change list with no diffs on one side and diffs on the other would reasonably
     * conclude the missing ones had not changed.
     */
    v: 2,
    details: itemise(audit, DETAIL_FIELDS, { id: 'details', label: 'Engagement details' }, budget),
    findings,
    sections,
    scope: (audit.scope ?? []).map(scopeEntry),
  };
}

/* -------------------------------------------------------------------------- */
/* What actually changed in the words                                         */
/* -------------------------------------------------------------------------- */

/**
 * Past this many differing words on either side, the field is reported as rewritten.
 *
 * The comparison below is quadratic, which is fine for an edited paragraph and is not fine for two
 * unrelated pages. A limit rather than a cleverer algorithm because the output stops being useful
 * long before the algorithm does: a diff where four hundred words changed is not something anybody
 * reads word by word, and "this was rewritten" is the honest summary of it.
 */
const DIFF_LIMIT = 600;

/**
 * Words, each carrying a single trailing space.
 *
 * The run of whitespace after a word is collapsed rather than kept, and that is a decision about
 * what a reader should be shown: a paragraph that was reflowed, or had a double space tidied out
 * of it, has not changed in any sense somebody reading the report would recognise. Keeping the
 * original spacing made *"one  two"* against *"one two"* a reported edit, which is noise in the one
 * place noise is most expensive — a list somebody scans to find the real change.
 *
 * Rejoining the pieces therefore gives back the text with its spacing normalised, not byte for
 * byte. That is the right trade here and would be the wrong one in a diff over code.
 */
const tokenise = (text) =>
  (String(text ?? '').match(/\S+\s*/g) ?? []).map((token) =>
    /\s$/.test(token) ? `${token.trimEnd()} ` : token
  );

/**
 * What changed between two versions of a field, word by word.
 *
 * The question the render register could never answer. `snapshotDifferences` has always been able
 * to say *"the remediation on VULN-03 changed"*; a client who has read the document wants to know
 * what it changed **to**, and answering that meant opening both files side by side.
 *
 * ## How
 *
 * Common prefix and suffix are trimmed first, which is not an optimisation so much as the whole
 * trick: almost every edit to a write-up is local, so trimming usually leaves a handful of words
 * on each side and the quadratic part never runs on anything large. What remains goes through an
 * ordinary longest-common-subsequence walk.
 *
 * @returns {{op: 'same'|'added'|'removed', text: string}[]|null} null when it is not worth showing
 */
export function diffWords(before, after) {
  const a = tokenise(before);
  const b = tokenise(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  /* Identical after trimming: the hash said it changed, so this was markup or whitespace. */
  if (!middleA.length && !middleB.length) return null;
  if (middleA.length > DIFF_LIMIT || middleB.length > DIFF_LIMIT) return null;

  /* The classic table. Rows are `middleA`, columns `middleB`. */
  const table = Array.from({ length: middleA.length + 1 }, () =>
    new Uint32Array(middleB.length + 1)
  );
  for (let i = middleA.length - 1; i >= 0; i -= 1) {
    for (let j = middleB.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        middleA[i] === middleB[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  /** Runs of the same operation are merged, so the result reads as phrases rather than words. */
  const push = (op, text) => {
    const last = out.at(-1);
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };

  if (head) push('same', a.slice(0, head).join(''));

  let i = 0;
  let j = 0;
  while (i < middleA.length && j < middleB.length) {
    if (middleA[i] === middleB[j]) {
      push('same', middleA[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('removed', middleA[i]);
      i += 1;
    } else {
      push('added', middleB[j]);
      j += 1;
    }
  }
  while (i < middleA.length) push('removed', middleA[i++]);
  while (j < middleB.length) push('added', middleB[j++]);

  if (tail) push('same', a.slice(a.length - tail).join(''));

  return out;
}

/** Items keyed by id, for the subtraction below. */
const byId = (items) => new Map((items ?? []).map((item) => [item.id, item]));

function compareList(before, after, kind, out, withText = false) {
  const was = byId(before);
  const now = byId(after);

  for (const [id, item] of now) {
    const previous = was.get(id);
    if (!previous) {
      out.push({ kind, change: 'added', id, label: item.label });
      continue;
    }
    const fields = Object.keys(item.fields).filter(
      (field) => previous.fields?.[field] !== item.fields[field]
    );
    if (!fields.length) continue;

    /**
     * What the words actually became, for the fields that kept them.
     *
     * Only when asked for. Every row of the render register runs this comparison against the row
     * below it, and a word diff on forty findings × six fields is work nobody looking at a list
     * asked for — the list wants "the remediation changed". The side-by-side view asks for the
     * rest, which is the one place somebody is reading it.
     *
     * A field with no entry here changed and could not be shown: it is not prose, or one of the
     * two snapshots predates the words being kept, or the rewrite was too large to be worth
     * showing word by word. The client says which rather than implying nothing moved.
     */
    const diffs = withText
      ? Object.fromEntries(
          fields
            .map((field) => {
              const from = previous.text?.[field];
              const to = item.text?.[field];
              if (from === undefined && to === undefined) return null;
              const diff = diffWords(from ?? '', to ?? '');
              return diff ? [field, diff] : null;
            })
            .filter(Boolean)
        )
      : undefined;

    out.push({
      kind,
      change: 'changed',
      id,
      /* The label as it reads *now*: a renamed finding should be found under its new name. */
      label: item.label,
      /* And the old one, but only when it moved — otherwise every row would carry a duplicate. */
      wasLabel: previous.label !== item.label ? previous.label : undefined,
      fields,
      ...(diffs && Object.keys(diffs).length ? { diffs } : {}),
    });
  }
  for (const [id, item] of was) {
    if (!now.has(id)) out.push({ kind, change: 'removed', id, label: item.label });
  }
}

/**
 * What is different between two snapshots, as a list a person can read.
 *
 * Ordered the way the question is asked: what is new, what has been rewritten, what is gone. An
 * absent snapshot on either side gives `null` rather than an empty list — a render from before this
 * was kept has no content to compare, and reporting that as "nothing changed" would be a lie told
 * by a feature whose whole job is to be exact.
 *
 * @returns {Array|null} the changes, or null when the two cannot be compared
 */
export function snapshotDifferences(before, after, { withText = false } = {}) {
  if (!before || !after) return null;
  if (before.v !== after.v) return null;

  const out = [];
  const detail = Object.keys(after.details?.fields ?? {}).filter(
    (field) => before.details?.fields?.[field] !== after.details.fields[field]
  );
  if (detail.length) {
    out.push({ kind: 'details', change: 'changed', id: 'details', label: 'Engagement details', fields: detail });
  }
  compareList(before.findings, after.findings, 'finding', out, withText);
  compareList(before.sections, after.sections, 'section', out, withText);
  /* Scope groups are hashed whole and have no prose, so there is nothing to diff word by word. */
  compareList(before.scope, after.scope, 'scope group', out);

  const RANK = { added: 0, changed: 1, removed: 2 };
  const KIND = { finding: 0, section: 1, 'scope group': 2, details: 3 };
  return out.sort(
    (a, b) =>
      RANK[a.change] - RANK[b.change] ||
      KIND[a.kind] - KIND[b.kind] ||
      String(a.label).localeCompare(String(b.label))
  );
}

/**
 * Whether a signature covers content that has since changed.
 *
 * An empty fingerprint on either side means there is nothing to compare —
 * approvals recorded before signatures were fingerprinted, or an engagement not
 * saved since. Unknown is not the same as stale, so those are left alone.
 */
export function isSignatureStale(approval, audit) {
  const signed = approval?.fingerprint ?? '';
  const current = audit?.contentFingerprint ?? '';
  if (!signed || !current) return false;
  return signed !== current;
}

/** Signatures that still cover the report as it stands. */
export function freshApprovals(audit) {
  return (audit?.approvals ?? []).filter((approval) => !isSignatureStale(approval, audit));
}

export default reportFingerprint;
