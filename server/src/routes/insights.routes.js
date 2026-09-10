/**
 * Trends across engagements.
 *
 * The dashboard answers "what is the state of things now". This answers "what has
 * been happening" — severity mix month by month, what gets fixed, which categories
 * keep coming back, which clients carry the most open risk.
 *
 * Computed here rather than in the browser because it needs every finding of every
 * engagement, which is exactly what the engagements list is careful not to send.
 *
 * One thing deliberately absent: mean time to remediate. `remediationStatus` records
 * where a finding stands, not when it moved, so any MTTR figure would be invented.
 * Fix *rate* and the age of what is still open are both real, and are here instead.
 */

import { Router } from 'express';

import { Audit } from '../models/audit.model.js';
import asyncHandler from '../utils/async-handler.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { calculateCvss, findingSeverity } from '../services/cvss.js';
import { activityCalendar } from '../services/activity-calendar.service.js';

const router = Router();

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'None'];
const STATUSES = ['open', 'retesting', 'fixed'];

const emptySeverityCounts = () => ({ Critical: 0, High: 0, Medium: 0, Low: 0, None: 0 });

/** `2026-08` — sorts lexicographically, which is why it is a string. */
const monthKey = (date) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Every month from `from` to now, so a quiet month shows as a gap, not a missing bar. */
function monthsBetween(from, to) {
  const months = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * When the team was busy, day by day.
 *
 * The rest of this page is about *what* was found; this is about *when* anybody was working, which
 * is a different question and the one a lead asks when a month felt quiet. Unscoped by engagement
 * on purpose — the point is the whole team's rhythm — and admin-only for the same reason the
 * by-engagement view is: it is a read across everything.
 *
 * Declared before `/` so Express matches the literal path first.
 */
router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      // A tester's own rhythm is on their engagement's Activity tab; this is everybody's.
      return res.status(403).json({ error: 'Only an admin can read the whole team’s activity.' });
    }
    return res.json(await activityCalendar({ days: Number(req.query.days) || 180 }));
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    // `days` scopes every number on the page, so the charts and the tiles agree.
    const days = req.query.days === 'all' ? null : Math.min(Number(req.query.days) || 365, 3650);
    const from = days ? new Date(Date.now() - days * 86_400_000) : null;

    /*
     * `mine` narrows the page to the caller's own work: findings they wrote up, and the
     * engagements they are actually on.
     *
     * Worth being precise about, because two plausible readings differ. "My findings" is
     * authorship — `createdBy` — not "findings on my engagements", which would credit a
     * colleague's write-up to whoever else happened to be on the team. Engagements are
     * counted when the person is on them at all, since being a reviewer on something is
     * part of your year even when you wrote none of it.
     */
    const mine = req.query.mine === 'true' || req.query.mine === '1';
    const me = String(req.user._id);
    const onTheTeam = (audit) =>
      [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]
        .map((entry) => String(entry?._id ?? entry ?? ''))
        .includes(me);

    const audits = await Audit.find(visibleAuditFilter(req.user))
      .select(
        'name reference state auditType company createdAt updatedAt findings testChecks ' +
          'creator collaborators reviewers'
      )
      .populate({ path: 'company', select: 'name shortName' })
      .sort({ updatedAt: -1 });

    const bySeverity = emptySeverityCounts();
    /** The same split restricted to findings that are not fixed — the risk still live. */
    const openBySeverity = emptySeverityCounts();
    const byStatus = { open: 0, retesting: 0, fixed: 0 };
    const byState = { EDIT: 0, REVIEW: 0, APPROVED: 0 };
    const byType = new Map();
    const byCategory = new Map();
    const byMonth = new Map();
    const clients = new Map();
    /** Oldest still-open finding per severity, in days. */
    const oldestOpen = emptySeverityCounts();

    let findingsInRange = 0;
    let checksTotal = 0;
    let checksDone = 0;
    let engagementsInRange = 0;
    let earliest = null;

    for (const audit of audits) {
      // In the personal view an engagement counts only if the person is on it; its
      // findings are filtered by author below regardless.
      if (mine && !onTheTeam(audit)) continue;

      const auditDate = audit.createdAt ?? audit.updatedAt;
      if (from && new Date(auditDate) < from) {
        // The engagement itself is older than the window, but its findings may not
        // be — keep walking, and only count the engagement if something lands.
      } else {
        engagementsInRange += 1;
        byState[audit.state] = (byState[audit.state] ?? 0) + 1;
        const type = audit.auditType?.trim() || 'Unspecified';
        byType.set(type, (byType.get(type) ?? 0) + 1);
      }

      const companyName = audit.company?.name ?? 'No client set';
      const companyId = audit.company?._id ? String(audit.company._id) : null;

      let auditFindings = 0;
      const auditSeverities = emptySeverityCounts();
      let auditOpen = 0;

      for (const finding of audit.findings ?? []) {
        // Findings carry their own timestamps; fall back to the engagement's for
        // ones created before subdocument timestamps existed.
        const created = finding.createdAt ?? auditDate;
        if (from && new Date(created) < from) continue;
        if (mine && String(finding.createdBy ?? '') !== me) continue;

        const severity = findingSeverity(finding).severity;
        const key = SEVERITIES.includes(severity) ? severity : 'None';
        const status = STATUSES.includes(finding.remediationStatus)
          ? finding.remediationStatus
          : 'open';

        findingsInRange += 1;
        bySeverity[key] += 1;
        byStatus[status] += 1;
        auditFindings += 1;
        auditSeverities[key] += 1;
        if (status !== 'fixed') {
          auditOpen += 1;
          openBySeverity[key] += 1;
        }

        const category = finding.category?.trim() || 'Uncategorised';
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);

        const month = monthKey(created);
        if (!byMonth.has(month)) byMonth.set(month, emptySeverityCounts());
        byMonth.get(month)[key] += 1;

        if (!earliest || new Date(created) < earliest) earliest = new Date(created);

        if (status !== 'fixed') {
          const ageDays = Math.floor((Date.now() - new Date(created).getTime()) / 86_400_000);
          if (ageDays > oldestOpen[key]) oldestOpen[key] = ageDays;
        }
      }

      for (const check of audit.testChecks ?? []) {
        checksTotal += 1;
        if (check.done) checksDone += 1;
      }

      if (auditFindings > 0 || !from) {
        const entry = clients.get(companyName) ?? {
          company: companyName,
          companyId,
          engagements: 0,
          findings: 0,
          open: 0,
          severityCounts: emptySeverityCounts(),
        };
        entry.engagements += 1;
        entry.findings += auditFindings;
        entry.open += auditOpen;
        for (const severity of SEVERITIES) entry.severityCounts[severity] += auditSeverities[severity];
        clients.set(companyName, entry);
      }
    }

    /*
     * A gapless month axis starting at the first finding, not at the window's edge:
     * a year-long window over three weeks of data is eleven empty columns and one
     * bar, which reads as a broken chart rather than a quiet year.
     */
    const seriesFrom = earliest && (!from || earliest > from) ? earliest : (from ?? earliest);
    const months = findingsInRange && seriesFrom ? monthsBetween(seriesFrom, new Date()) : [];

    const trend = months.map((month) => ({
      month,
      ...(byMonth.get(month) ?? emptySeverityCounts()),
      total: SEVERITIES.reduce((sum, s) => sum + (byMonth.get(month)?.[s] ?? 0), 0),
    }));

    // Top categories, with the tail folded into one row rather than becoming more
    // colours — past a handful of classes a chart stops being readable.
    const sortedCategories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
    const TOP = 8;
    const categories = sortedCategories.slice(0, TOP).map(([label, count]) => ({ label, count }));
    const tail = sortedCategories.slice(TOP);
    if (tail.length) {
      categories.push({
        label: `Other (${tail.length} categories)`,
        count: tail.reduce((sum, [, count]) => sum + count, 0),
        isTail: true,
      });
    }

    const resolved = byStatus.fixed;
    const fixRate = findingsInRange ? Math.round((resolved / findingsInRange) * 100) : null;

    res.json({
      range: { days, from: from?.toISOString() ?? null, mine },
      totals: {
        engagements: engagementsInRange,
        findings: findingsInRange,
        /** Not-yet-fixed Critical and High — the number worth leading with. */
        openSerious: openBySeverity.Critical + openBySeverity.High,
        openCritical: openBySeverity.Critical,
        fixRate,
        checks: { done: checksDone, total: checksTotal },
      },
      bySeverity,
      openBySeverity,
      byStatus,
      byState,
      byType: [...byType.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      categories,
      trend,
      oldestOpen,
      clients: [...clients.values()].sort((a, b) => b.open - a.open || b.findings - a.findings),
    });
  })
);

export default router;
