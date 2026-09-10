/**
 * A client's engagements read as one programme rather than as a list.
 *
 * The client page answers "what have we done for them": engagements, totals, what keeps coming
 * back. It cannot answer the question the renewal conversation actually turns on, which is
 * *direction* — is this getting better, what did they fix since last time, and how long did it
 * take them. That is a comparison between engagements, and nothing was comparing them.
 *
 * Everything here is derived from findings that are already loaded for the client page's own
 * counts, so this costs a computation rather than a query.
 *
 * Two honest limits, both deliberate:
 *
 *   - **Sameness is by title**, through `normaliseTitle` — the same rule the recurrence check and
 *     the library lookup use. Engagements carry no lineage, so "the same issue as last year" is
 *     inference, not record. When two engagements are properly linked this gets exact and nothing
 *     above it changes.
 *   - **Time to fix is measured between engagements**, because that is the only evidence there is:
 *     a finding has no `fixedAt`. "Reported in March, gone by November" is a bound, not a duration,
 *     and it is reported as the gap between the two tests rather than dressed up as precision.
 */
import { calculateCvss } from './cvss.js';
import { engagementDate, normaliseTitle } from './finding-history.service.js';

const SEVERITY_WEIGHT = { Critical: 10, High: 6, Medium: 3, Low: 1, None: 0 };

const dateValue = (value) => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

/** What a finding is recognised by across engagements: its library entry, else its title. */
const identityOf = (finding) => {
  const library = finding.vulnerability?._id ?? finding.vulnerability;
  if (library) return `library:${String(library)}`;
  const title = normaliseTitle(finding.title);
  return title ? `title:${title}` : '';
};

/**
 * One engagement, weighed.
 *
 * The weighted score is the only way to say "worse" in one number without pretending a Critical
 * and four Lows are comparable. It exists to draw a line on a chart, and it is never shown as a
 * figure, because a client asked to accept that their security is 34 will ask what 34 means.
 */
function summarise(audit) {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, None: 0 };
  const remediation = { open: 0, retesting: 0, fixed: 0 };
  let weight = 0;

  for (const finding of audit.findings ?? []) {
    const severity = calculateCvss(finding.cvssv3).baseSeverity;
    counts[severity] = (counts[severity] ?? 0) + 1;
    weight += SEVERITY_WEIGHT[severity] ?? 0;
    const status = ['open', 'retesting', 'fixed'].includes(finding.remediationStatus)
      ? finding.remediationStatus
      : 'open';
    remediation[status] += 1;
  }

  return {
    _id: audit._id,
    name: audit.name,
    reference: audit.reference ?? '',
    auditType: audit.auditType ?? '',
    state: audit.state,
    date: engagementDate(audit),
    counts,
    total: (audit.findings ?? []).length,
    remediation,
    weight,
  };
}

/**
 * What changed between two engagements.
 *
 * Three lists, and `gone` is the one worth the most: it is the only evidence a report ever
 * produced that somebody acted on it, and nothing in the app was saying so.
 */
function compare(previous, current) {
  const before = new Map();
  for (const finding of previous?.findings ?? []) {
    const id = identityOf(finding);
    if (id && !before.has(id)) before.set(id, finding);
  }
  const after = new Map();
  for (const finding of current?.findings ?? []) {
    const id = identityOf(finding);
    if (id && !after.has(id)) after.set(id, finding);
  }

  const describe = (finding) => ({
    _id: finding._id,
    title: finding.title,
    severity: calculateCvss(finding.cvssv3).baseSeverity,
  });

  return {
    fresh: [...after.entries()].filter(([id]) => !before.has(id)).map(([, f]) => describe(f)),
    again: [...after.entries()].filter(([id]) => before.has(id)).map(([, f]) => describe(f)),
    /*
     * Absent from the newer engagement. Not "fixed": it may have been out of scope this time, and
     * saying so is the difference between a claim the client can rely on and one they cannot.
     */
    gone: [...before.entries()].filter(([id]) => !after.has(id)).map(([, f]) => describe(f)),
  };
}

/**
 * The programme.
 *
 * @param {Array} audits engagements for one company, findings loaded, any order
 * @returns {{series: object[], change: object|null, pace: object, direction: string}}
 */
export function programmeFor(audits) {
  const ordered = [...(audits ?? [])].sort(
    (a, b) => dateValue(engagementDate(a)) - dateValue(engagementDate(b))
  );
  const series = ordered.map(summarise);

  const latest = ordered.at(-1) ?? null;
  const previous = ordered.length > 1 ? ordered.at(-2) : null;
  const change = previous
    ? {
        from: summarise(previous),
        to: summarise(latest),
        ...compare(previous, latest),
        /** Days between the two tests — the window everything below was fixed in. */
        days:
          dateValue(engagementDate(previous)) && dateValue(engagementDate(latest))
            ? Math.round(
                (dateValue(engagementDate(latest)) - dateValue(engagementDate(previous))) /
                  86_400_000
              )
            : null,
      }
    : null;

  /**
   * How long things take, measured between consecutive engagements.
   *
   * Each gap contributes the issues that disappeared across it and the number of days it spanned.
   * The median rather than the mean, because one client who fixed something after three years
   * would otherwise make everybody look patient.
   */
  const gaps = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const span = compare(ordered[i - 1], ordered[i]);
    const days =
      dateValue(engagementDate(ordered[i])) && dateValue(engagementDate(ordered[i - 1]))
        ? Math.round(
            (dateValue(engagementDate(ordered[i])) - dateValue(engagementDate(ordered[i - 1]))) /
              86_400_000
          )
        : null;
    if (days !== null && span.gone.length) gaps.push({ days, count: span.gone.length });
  }

  const spans = gaps.flatMap((gap) => Array.from({ length: gap.count }, () => gap.days)).sort((a, b) => a - b);
  const median = spans.length
    ? spans.length % 2
      ? spans[(spans.length - 1) / 2]
      : Math.round((spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2)
    : null;

  /*
   * Direction, in a word, and only when there is enough to say it. Two engagements a fortnight
   * apart do not make a trend, and a page that declared one would be believed.
   */
  let direction = 'unknown';
  if (series.length >= 2) {
    const [older, newer] = [series.at(-2).weight, series.at(-1).weight];
    if (newer < older * 0.85) direction = 'better';
    else if (newer > older * 1.15) direction = 'worse';
    else direction = 'steady';
  }

  return {
    series,
    change,
    pace: { medianDaysToClear: median, cleared: spans.length, gaps: gaps.length },
    direction,
  };
}

export default { programmeFor };
