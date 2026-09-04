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
