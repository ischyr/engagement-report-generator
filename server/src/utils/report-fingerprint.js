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

const itemise = (item, fields, { id, label }) => ({
  id,
  label,
  fields: Object.fromEntries(fields.map(([name, read]) => [name, h(read(item))])),
});

/**
 * @param {object} audit a fully loaded engagement — a projected one would report false removals
 * @returns {object} `{ v, details, findings, sections, scope }`
 */
export function reportSnapshot(audit) {
  return {
    /* Stamped, so a stored snapshot from an older shape can be reported as incomparable rather
       than silently diffed against a newer one and reported as a hundred changes. */
    v: 1,
    details: itemise(audit, DETAIL_FIELDS, { id: 'details', label: 'Engagement details' }),
    findings: (audit.findings ?? []).map((finding) =>
      itemise(finding, FINDING_FIELDS, {
        id: idOf(finding),
        label: str(finding.title) || 'Untitled finding',
      })
    ),
    sections: (audit.sections ?? []).map((section) =>
      itemise(section, SECTION_FIELDS, {
        id: idOf(section) || str(section.field),
        label: str(section.name) || str(section.field) || 'Unnamed section',
      })
    ),
    scope: (audit.scope ?? []).map(scopeEntry),
  };
}

/** Items keyed by id, for the subtraction below. */
const byId = (items) => new Map((items ?? []).map((item) => [item.id, item]));

function compareList(before, after, kind, out) {
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
    out.push({
      kind,
      change: 'changed',
      id,
      /* The label as it reads *now*: a renamed finding should be found under its new name. */
      label: item.label,
      /* And the old one, but only when it moved — otherwise every row would carry a duplicate. */
      wasLabel: previous.label !== item.label ? previous.label : undefined,
      fields,
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
export function snapshotDifferences(before, after) {
  if (!before || !after) return null;
  if (before.v !== after.v) return null;

  const out = [];
  const detail = Object.keys(after.details?.fields ?? {}).filter(
    (field) => before.details?.fields?.[field] !== after.details.fields[field]
  );
  if (detail.length) {
    out.push({ kind: 'details', change: 'changed', id: 'details', label: 'Engagement details', fields: detail });
  }
  compareList(before.findings, after.findings, 'finding', out);
  compareList(before.sections, after.sections, 'section', out);
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
