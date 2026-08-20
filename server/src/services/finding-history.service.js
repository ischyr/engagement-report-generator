/**
 * The same issue, seen again.
 *
 * A client is rarely one engagement, and the most useful sentence a report can carry
 * is "this was already reported in PT-2025-004 and is still open." Everything needed
 * to write it was already stored — many engagements per company, a remediation status
 * per finding, a link to the library entry a finding came from — and nothing joined it
 * up, so the tester had to remember last year's report.
 *
 * Nothing here writes: it is a read over engagements the caller can already see.
 */

import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { calculateCvss } from './cvss.js';

/** Only the fields recognition and the readout need — never whole findings. */
const HISTORY_FIELDS =
  'name reference date date_start date_end createdAt ' +
  'findings._id findings.title findings.cvssv3 findings.remediationStatus findings.vulnerability';

const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, None: 0 };

/**
 * Two findings are the same issue if they share a library entry, or if their titles
 * match once the incidentals are taken out.
 *
 * Parentheticals go because a title is routinely qualified by where it was found —
 * "Stored XSS (export view)" and "Stored XSS (admin search)" are the same weakness
 * reported twice — and everything non-alphanumeric goes because punctuation and
 * capitalisation drift between reports written months apart. The trade is deliberate:
 * this errs towards spotting a recurrence, because a false match costs a glance and a
 * missed one costs the sentence above.
 */
export function normaliseTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Every handle a finding can be recognised by. */
function identityKeys(finding) {
  const keys = [];
  const library = finding.vulnerability?._id ?? finding.vulnerability;
  if (library) keys.push(`library:${String(library)}`);
  const title = normaliseTitle(finding.title);
  if (title) keys.push(`title:${title}`);
  return keys;
}

/**
 * Groups items that share any key, transitively.
 *
 * Transitive because the two signals overlap unevenly: a finding inserted from the
 * library in one engagement and typed by hand in another links through its title,
 * while two differently-worded findings link through the library entry. Grouping on
 * one key at a time would split those apart.
 */
function groupByIdentity(items) {
  const groupOf = new Map();
  const groups = [];

  for (const item of items) {
    const hits = [...new Set(item.keys.map((key) => groupOf.get(key)).filter((g) => g !== undefined))];
    let target;
    if (hits.length === 0) {
      target = groups.length;
      groups.push([]);
    } else {
      target = Math.min(...hits);
      for (const other of hits) {
        if (other === target) continue;
        groups[target].push(...groups[other]);
        groups[other] = [];
        for (const [key, value] of groupOf) if (value === other) groupOf.set(key, target);
      }
    }
    groups[target].push(item);
    for (const key of item.keys) groupOf.set(key, target);
  }

  return groups.filter((group) => group.length);
}

/** When an engagement happened, for ordering. Dates are stored as strings. */
export function engagementDate(audit) {
  return audit?.date_end || audit?.date || audit?.date_start || audit?.createdAt || '';
}

const dateValue = (value) => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

function occurrenceOf(audit, finding) {
  const cvss = calculateCvss(finding.cvssv3);
  return {
    auditId: String(audit._id),
    auditName: audit.name ?? '',
    reference: audit.reference ?? '',
    date: engagementDate(audit),
    findingId: String(finding._id),
    title: finding.title ?? '',
    severity: cvss.baseSeverity,
    score: cvss.baseScore,
    remediationStatus: ['open', 'retesting', 'fixed'].includes(finding.remediationStatus)
      ? finding.remediationStatus
      : 'open',
  };
}

/**
 * Issues that appear in more than one of a client's engagements, newest first.
 *
 * @param {Array} audits engagements for one company, each with findings loaded
 */
export function recurringIssues(audits) {
  const items = [];
  for (const audit of audits) {
    for (const finding of audit.findings ?? []) {
      const keys = identityKeys(finding);
      if (!keys.length) continue;
      items.push({ keys, occurrence: occurrenceOf(audit, finding) });
    }
  }

  const issues = [];
  for (const group of groupByIdentity(items)) {
    const occurrences = group
      .map((item) => item.occurrence)
      .sort((a, b) => dateValue(a.date) - dateValue(b.date));

    // Two findings in the *same* engagement are a duplicate, not a recurrence — the
    // preflight check already complains about those.
    const engagements = new Set(occurrences.map((o) => o.auditId));
    if (engagements.size < 2) continue;

    const latest = occurrences.at(-1);
    const first = occurrences[0];
    const worst = occurrences.reduce((a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) > (SEVERITY_RANK[a.severity] ?? 0) ? b : a
    );

    issues.push({
      title: latest.title,
      severity: worst.severity,
      engagementCount: engagements.size,
      occurrences,
      firstSeen: first.date,
      lastSeen: latest.date,
      /** Whether the client still has it, going by the most recent engagement. */
      stillOpen: latest.remediationStatus !== 'fixed',
      status: latest.remediationStatus,
      /**
       * How long it took, when it did get fixed: the gap between first being told
       * and the engagement that found it closed. Null while it is still open, and
       * null when the dates are missing rather than guessed at.
       */
      daysToFix:
        latest.remediationStatus === 'fixed' && dateValue(first.date) && dateValue(latest.date)
          ? Math.round((dateValue(latest.date) - dateValue(first.date)) / 86_400_000)
          : null,
    });
  }

  return issues.sort(
    (a, b) =>
      Number(b.stillOpen) - Number(a.stillOpen) ||
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.engagementCount - a.engagementCount ||
      dateValue(b.lastSeen) - dateValue(a.lastSeen)
  );
}

/**
 * For one engagement: where each of its findings has been reported before.
 *
 * "Before" is by engagement date, so opening an old assessment does not claim its
 * findings were previously reported by a test that happened afterwards.
 *
 * @returns {Map<string, object[]>} finding id → earlier occurrences, newest first
 */
export function previousOccurrences(audit, others) {
  const when = dateValue(engagementDate(audit));
  const byKey = new Map();

  for (const other of others) {
    if (String(other._id) === String(audit._id)) continue;
    const otherWhen = dateValue(engagementDate(other));
    // Undated engagements are included: an engagement nobody dated is more likely
    // to be older work than a reason to hide the history.
    if (when && otherWhen && otherWhen >= when) continue;

    for (const finding of other.findings ?? []) {
      for (const key of identityKeys(finding)) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(occurrenceOf(other, finding));
      }
    }
  }

  const result = new Map();
  for (const finding of audit.findings ?? []) {
    const seen = new Map();
    for (const key of identityKeys(finding)) {
      for (const occurrence of byKey.get(key) ?? []) {
        // Keyed by finding, so an issue matching on both title and library entry is
        // not reported twice.
        seen.set(occurrence.findingId, occurrence);
      }
    }
    if (!seen.size) continue;
    result.set(
      String(finding._id),
      [...seen.values()].sort((a, b) => dateValue(b.date) - dateValue(a.date))
    );
  }

  return result;
}

/**
 * Loads the earlier engagements for this client and works out what repeats.
 *
 * Scoped to what the caller may see, like everything else: a report generated by
 * somebody who was not on last year's assessment must not quietly quote it.
 *
 * @returns {Promise<Map<string, object[]>>} empty when there is no client or no history
 */
export async function findingHistoryFor(audit, user) {
  if (!audit?.company) return new Map();
  const company = audit.company?._id ?? audit.company;

  const others = await Audit.find(
    visibleAuditFilter(user, { company, _id: { $ne: audit._id } })
  ).select(HISTORY_FIELDS);

  if (!others.length) return new Map();
  return previousOccurrences(audit, others);
}

export default recurringIssues;
