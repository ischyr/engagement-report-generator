/**
 * What `/api/v1` publishes, field by field.
 *
 * Every function here writes out an explicit list. None of them spreads a document, and that is
 * the single most important property of this file: a field added to a model tomorrow appears in a
 * versioned response only when somebody decides it should. The alternative — `{...finding}` with a
 * few deletions — fails in the direction that matters, because the failure is silent and the thing
 * it leaks is a client's internal note.
 *
 * `report.service.js` already keeps `INTERNAL_FINDING_FIELDS` for the same reason, as a denylist of
 * what must not reach a rendered document. A denylist is right there, where the alternative is not
 * printing most of a finding. It is wrong here, where the audience is not the client's report but
 * anybody's script, and where the shape is a promise: an allowlist is also the version contract,
 * because the fields listed here are precisely the fields v1 has agreed to keep.
 *
 * Note what is absent from a finding: `comments`, `clientClaim`, `lockedBy`, `statusHistory`,
 * `credentialsUsed`. Internal discussion, the client's own account of a fix, who has the record
 * open, and which borrowed account was used — none of it is a script's business, and each would be
 * a small betrayal of somebody who wrote it expecting a colleague to read it.
 */
import { findingSeverity } from './cvss.js';

/** An id as a string, from an id, a document, or nothing. */
const id = (value) => {
  if (!value) return null;
  return String(value._id ?? value);
};

/**
 * One engagement, as a list row or on its own.
 *
 * `detail` adds the fields worth a second query: the dates, the team, the classification. A list
 * of two hundred engagements does not need any of it, and a script reading one does.
 */
export function v1Engagement(audit, { detail = false } = {}) {
  const base = {
    id: id(audit),
    name: audit.name ?? '',
    reference: audit.reference ?? '',
    type: audit.auditType ?? '',
    kind: audit.kind ?? 'standard',
    state: audit.state ?? 'EDIT',
    client: audit.company?.name ?? null,
    findingCount: (audit.findings ?? []).length,
    updatedAt: audit.updatedAt,
  };
  if (!detail) return base;

  return {
    ...base,
    language: audit.language ?? 'en',
    /** Kept as the `yyyy-mm-dd` strings they are stored as, not coerced into timestamps. */
    dates: {
      report: audit.date ?? '',
      start: audit.date_start ?? '',
      end: audit.date_end ?? '',
    },
    scope: (audit.scope ?? []).map((row) => ({
      name: row.name ?? '',
      hosts: (row.hosts ?? []).map((host) => host.hostname ?? host.ip ?? '').filter(Boolean),
    })),
    createdAt: audit.createdAt,
  };
}

/**
 * One finding.
 *
 * The severity is computed rather than stored, by the same function the application and the report
 * use, so a script and a document cannot disagree about whether something is a High. `overridden`
 * and `overrideReason` travel with it: a severity the team is standing behind against its own
 * vector is exactly the kind of thing an integration should be able to see and not silently
 * flatten.
 */
export function v1Finding(finding, { detail = true } = {}) {
  const severity = findingSeverity(finding);

  const base = {
    id: id(finding),
    /** What the report prints as VULN-03. Allocated by the server; never accepted from a caller. */
    identifier: finding.identifier ?? null,
    title: finding.title ?? '',
    type: finding.vulnType ?? '',
    category: finding.category ?? '',
    severity: severity.severity,
    cvss: {
      vector: finding.cvssv3 ?? '',
      score: severity.score,
      severity: severity.cvssSeverity,
    },
    overridden: severity.overridden,
    overrideReason: severity.reason,
    remediationStatus: finding.remediationStatus ?? 'open',
    assignedTo: finding.assignedTo
      ? {
          id: id(finding.assignedTo),
          username: finding.assignedTo.username ?? null,
        }
      : null,
  };
  if (!detail) return base;

  return {
    ...base,
    description: finding.description ?? '',
    observation: finding.observation ?? '',
    remediation: finding.remediation ?? '',
    poc: finding.poc ?? '',
    scope: finding.scope ?? '',
    references: (finding.references ?? []).filter(Boolean),
    priority: finding.priority ?? null,
    remediationComplexity: finding.remediationComplexity ?? null,
    createdAt: finding.createdAt ?? null,
    updatedAt: finding.updatedAt ?? null,
  };
}

/**
 * One enumeration step.
 *
 * The output stays out of the list for the same reason the application's own tree leaves it out —
 * sixty steps at four hundred lines is over a megabyte of JSON to draw a list of titles — and the
 * detail route answers with it. A script sweeping for "which step recorded this host" is the exact
 * caller that would otherwise pull all of it down.
 */
export function v1Step(step, { output = null } = {}) {
  const base = {
    id: id(step),
    parent: id(step.parent),
    title: step.title ?? '',
    tool: step.tool ?? '',
    command: step.command ?? '',
    target: step.target ?? '',
    phase: step.phase ?? '',
    status: step.status ?? '',
    summary: step.summary ?? '',
    ranAt: step.ranAt ?? '',
    /** Whether it prints in the report. A script filing steps should be able to see it. */
    internal: Boolean(step.internal),
    createdAt: step.createdAt ?? null,
    updatedAt: step.updatedAt ?? null,
  };
  return output === null ? base : { ...base, output };
}

/**
 * What a token can tell about itself.
 *
 * `whoami` is the first call anybody writing against an API makes, and the second is the one they
 * make when it stops working. So it answers the three questions of that moment together: who am I
 * acting as, what am I allowed to do, and how long have I got.
 */
export function v1Whoami(req) {
  const token = req.token;
  const user = req.user;
  return {
    token: {
      label: token.label,
      preview: token.preview,
      scopes: token.scopes ?? [],
      engagements: (token.audits ?? []).map((value) => id(value)),
      /** Empty `engagements` is the wide case, said in a word rather than left to be inferred. */
      reach: (token.audits ?? []).length ? 'named engagements' : 'every engagement its owner is on',
      expiresAt: token.expiresAt,
    },
    actingAs: {
      id: id(user),
      username: user.username,
      name: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
    },
  };
}
