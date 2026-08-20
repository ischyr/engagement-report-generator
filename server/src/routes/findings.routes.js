/**
 * Every finding, across every engagement you can see.
 *
 * The gap this fills: findings only ever existed *inside* an engagement, so "what critical
 * issues are still open across all our clients" was answered by opening engagements one at
 * a time and remembering. Insights aggregates the same data into charts, which answers
 * "what has been happening" — this answers "what is still outstanding, and whose is it".
 *
 * Deliberately unwindowed. Insights scopes itself to a date range because a trend needs
 * one; a list of unresolved risk must not, or the oldest open critical in the instance —
 * exactly the row worth seeing — drops off the page for being old.
 *
 * Scoped like everything else: only engagements you are on, so this cannot become a way to
 * read the findings of clients you are not allowed to know about.
 */

import { Router } from 'express';

import { Audit } from '../models/audit.model.js';
import asyncHandler from '../utils/async-handler.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { calculateCvss, findingSeverity } from '../services/cvss.js';
// The one definition of "how much evidence is there", shared with the report and the model.
import { countImages } from '../utils/evidence.js';
import { Settings } from '../models/settings.model.js';

const router = Router();

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'None'];
/** Worst first — the order the page is read in. */
const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const STATUSES = ['open', 'retesting', 'fixed'];

/**
 * How many rows leave the server.
 *
 * A cap rather than pagination: the page is a working list, and anybody who needs to page
 * through two thousand findings needs a filter, not a next button. The response says when
 * it truncated and how many there were, so the number is never quietly wrong.
 */
const MAX_ROWS = 500;

const idOf = (value) => String(value?._id ?? value ?? '');
const listParam = (value, allowed) => {
  const parts = String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = parts.filter((part) => allowed.includes(part));
  return kept.length ? kept : null;
};

const displayName = (user) =>
  [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || null;

const dayOf = (value) => new Date(value).toISOString().slice(0, 10);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const wantedSeverities = listParam(req.query.severity, SEVERITIES);
    /*
     * Not fixed by default.
     *
     * The reason to look at every engagement at once is outstanding work; a default of
     * "everything" would bury eleven live criticals in four hundred informational findings
     * from three years of reports.
     */
    const wantedStatuses = listParam(req.query.status, STATUSES) ?? ['open', 'retesting'];
    const wantedStates = listParam(req.query.state, ['EDIT', 'REVIEW', 'APPROVED']);
    const company = /^[0-9a-fA-F]{24}$/.test(String(req.query.company ?? ''))
      ? String(req.query.company)
      : null;
    const mine = req.query.mine === 'true' || req.query.mine === '1';
    const needle = String(req.query.q ?? '').trim().toLowerCase();
    const sort = ['age', 'severity', 'score', 'recent', 'client'].includes(String(req.query.sort))
      ? String(req.query.sort)
      : 'age';

    const me = String(req.user._id);

    const [audits, settings] = await Promise.all([
      Audit.find({ ...visibleAuditFilter(req.user) })
        .select(
          'name reference state auditType company createdAt updatedAt date_start findings ' +
            'creator collaborators reviewers'
        )
        .populate([
          { path: 'company', select: 'name shortName' },
          { path: 'findings.createdBy', select: 'username firstname lastname' },
        ]),
      Settings.getSettings(),
    ]);

    const prefix = settings?.report?.public?.findingIdPrefix ?? '';

    /* Facet counts are built from everything visible, *before* the filters are applied,
     * so the chips can say how many rows each one would bring back rather than only
     * describing what is already on screen. Status is the exception: those counts describe
     * the current severity/client/search selection, because the status tabs are the one
     * control people flip back and forth. */
    const facets = {
      severity: Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])),
      /**
       * The same split restricted to what is not fixed.
       *
       * Both are needed and they are not interchangeable: a filter chip must count
       * everything it would bring back, while a headline saying "criticals outstanding" has
       * to exclude the fixed ones or it is simply a false statement in a large font.
       */
      outstanding: Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])),
      status: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      clients: new Map(),
    };

    const rows = [];
    let total = 0;

    for (const audit of audits) {
      const auditDate = audit.createdAt ?? audit.updatedAt;
      const companyId = audit.company?._id ? idOf(audit.company) : null;
      const companyName = audit.company?.name ?? 'No client set';

      for (const [position, finding] of (audit.findings ?? []).entries()) {
        const severityRaw = calculateCvss(finding.cvssv3);
        const rated = findingSeverity(finding);
        const severity = SEVERITIES.includes(rated.severity)
          ? rated.severity
          : 'None';
        const status = STATUSES.includes(finding.remediationStatus)
          ? finding.remediationStatus
          : 'open';
        // Findings written before subdocument timestamps existed borrow the
        // engagement's, so age is never blank and never invented.
        const created = finding.createdAt ?? auditDate;
        const author = finding.createdBy ?? null;

        /* ------------------------------------------------------------- facets */
        facets.severity[severity] += 1;
        if (status !== 'fixed') facets.outstanding[severity] += 1;
        if (!facets.clients.has(companyName)) {
          facets.clients.set(companyName, { name: companyName, id: companyId, findings: 0, open: 0 });
        }
        const clientFacet = facets.clients.get(companyName);
        clientFacet.findings += 1;
        if (status !== 'fixed') clientFacet.open += 1;

        /* ------------------------------------------------------------ filters */
        if (wantedSeverities && !wantedSeverities.includes(severity)) continue;
        if (company && companyId !== company) continue;
        if (wantedStates && !wantedStates.includes(audit.state)) continue;
        // Authorship, not team membership: "mine" means what I wrote up.
        if (mine && idOf(author) !== me) continue;
        if (needle) {
          const haystack = [
            finding.title,
            finding.category,
            finding.vulnType,
            finding.scope,
            audit.name,
            audit.reference,
            companyName,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(needle)) continue;
        }

        // Counted after everything except status, so the status tabs can show what
        // flipping them would find.
        facets.status[status] += 1;
        if (!wantedStatuses.includes(status)) continue;

        total += 1;
        if (rows.length >= MAX_ROWS) continue;

        rows.push({
          id: idOf(finding),
          /** The label a report would give it, so a row can be quoted in an email. */
          label: `${prefix}${String(finding.identifier ?? position + 1).padStart(2, '0')}`,
          title: finding.title,
          severity,
          score: severityRaw.baseScore ?? 0,
          cvssVersion: severityRaw.version ?? null,
          status,
          category: finding.category?.trim() || '',
          vulnType: finding.vulnType?.trim() || '',
          author: author ? { id: idOf(author), name: displayName(author) } : null,
          createdAt: created,
          day: dayOf(created),
          ageDays: Math.floor((Date.now() - new Date(created).getTime()) / 86_400_000),
          evidenceCount: finding.evidenceCount ?? countImages(finding),
          engagement: {
            id: idOf(audit),
            name: audit.name,
            reference: audit.reference ?? '',
            state: audit.state,
            company: companyName,
            companyId,
          },
        });
      }
    }

    const compare = {
      // Oldest first: the default, because age is the only thing here that gets worse on
      // its own.
      age: (a, b) => b.ageDays - a.ageDays || SEVERITY_RANK.get(a.severity) - SEVERITY_RANK.get(b.severity),
      severity: (a, b) =>
        SEVERITY_RANK.get(a.severity) - SEVERITY_RANK.get(b.severity) ||
        b.score - a.score ||
        b.ageDays - a.ageDays,
      score: (a, b) => b.score - a.score || b.ageDays - a.ageDays,
      recent: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      client: (a, b) =>
        a.engagement.company.localeCompare(b.engagement.company) ||
        SEVERITY_RANK.get(a.severity) - SEVERITY_RANK.get(b.severity) ||
        b.ageDays - a.ageDays,
    }[sort];
    rows.sort(compare);

    res.json({
      findings: rows,
      total,
      truncated: total > rows.length,
      limit: MAX_ROWS,
      /** Echoed back so the page can show what it is looking at, and share a URL. */
      applied: {
        severity: wantedSeverities,
        status: wantedStatuses,
        state: wantedStates,
        company,
        mine,
        q: needle || null,
        sort,
      },
      facets: {
        severity: facets.severity,
        outstanding: facets.outstanding,
        status: facets.status,
        clients: [...facets.clients.values()].sort(
          (a, b) => b.open - a.open || b.findings - a.findings || a.name.localeCompare(b.name)
        ),
      },
      /** The worst thing still outstanding, for the line at the top of the page. */
      oldestOpen: rows.length
        ? rows.reduce((worst, row) => (row.ageDays > (worst?.ageDays ?? -1) ? row : worst), null)
        : null,
    });
  })
);

export default router;
