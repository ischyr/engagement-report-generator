/**
 * The handful of plain facts that mean an engagement needs somebody to look at it.
 *
 * Each one is a fact rather than a score: "two findings with no screenshot" tells you what to do,
 * a health percentage of 68% does not. Deliberately shared by the engagements list and the
 * dashboard, because two places that each decided what "needs attention" meant would eventually
 * disagree in front of the same person.
 */

/** How long without a single edit before an engagement counts as drifting. */
export const STALE_DAYS = 10;

const dayString = (date) => date.toISOString().slice(0, 10);

/**
 * @param {object} audit a plain engagement object, with findings and testChecks projected
 * @param {{ now?: Date }} [options] `now` only for tests
 */
export function engagementHealth(audit, { now = new Date(), kit = null } = {}) {
  const today = dayString(now);
  const checks = audit.testChecks ?? [];
  const findings = audit.findings ?? [];

  return {
    /** Days since anything at all happened here. */
    staleDays: Math.floor(
      (now.getTime() - new Date(audit.updatedAt ?? audit.createdAt).getTime()) / 86_400_000
    ),
    /** Findings carrying no evidence — usually a report that is not finished. */
    noEvidence: findings.filter((finding) => !(finding.evidenceCount > 0)).length,
    /*
     * Blocked checks are excluded. They are a recorded reason rather than a loose end, and
     * counting them here is what made this queue cry wolf on engagements where the team had
     * already done the honest thing and said why something could not be tested.
     */
    checksOutstanding: checks.filter((check) => !check.done && !check.blocked).length,
    checksBlocked: checks.filter((check) => !check.done && check.blocked).length,
    checksTotal: checks.length,
    /**
     * Past the date the client was promised, and not signed off.
     *
     * Compared as `yyyy-mm-dd` strings, like every other day in this app — an engagement is not
     * overdue in one timezone and fine in another.
     */
    overdue: Boolean(audit.date_end && audit.date_end < today && audit.state !== 'APPROVED'),

    /*
     * Kit facts, handed in rather than looked up: this function is deliberately synchronous over
     * data already in hand, and where the drop box is takes a query. Null when nobody asked.
     */
    kitOutstanding: kit?.outstanding ?? 0,
    kitOverdue: kit?.overdue ?? 0,
    kitMissing: kit?.missing ?? 0,
    /**
     * Whether testing has actually begun.
     *
     * A fact rather than something the reasons work out for themselves: this function is the one
     * holding the date it is being judged against, and two places deciding what "started" means
     * is how they end up disagreeing.
     */
    started: Boolean(audit.date_start) && audit.date_start <= today,
  };
}

/**
 * Why this engagement is on the list, in the words the page shows.
 *
 * Ordered worst first, and each reason carries the tab that fixes it — a queue that tells you
 * something is wrong without saying where to go is a queue people stop opening.
 */
export function attentionReasons(audit, health) {
  const reasons = [];

  if (audit.onHold) {
    const hold = (audit.holds ?? []).filter((entry) => !entry.endedAt).pop();
    reasons.push({
      code: 'on-hold',
      level: 'blocker',
      label: hold?.reason ? `Work stopped — ${hold.reason}` : 'Work has stopped',
      tab: 'overview',
    });
  }
  if (health.overdue) {
    reasons.push({
      code: 'overdue',
      level: 'blocker',
      label: 'Past its end date and not signed off',
      /*
       * The day travels as a field rather than inside the sentence. A `yyyy-mm-dd` dropped into
       * English prose reads as machine output next to a UI that writes "5 Aug 2026" everywhere
       * else, and this server has no idea which format the reader wants.
       */
      day: audit.date_end,
      tab: 'overview',
    });
  }
  if (health.noEvidence) {
    reasons.push({
      code: 'no-evidence',
      level: 'warning',
      label: `${health.noEvidence} finding${health.noEvidence === 1 ? '' : 's'} with no evidence`,
      tab: 'findings',
    });
  }
  /*
   * Kit that has not come back outranks everything else on the row.
   *
   * It is the only reason on this list that involves somebody else's property or a physical thing
   * loose in the world, and unlike a half-written finding it does not get better on its own.
   */
  if (health.kitMissing) {
    reasons.push({
      code: 'kit-missing',
      level: 'blocker',
      label: `${health.kitMissing} item${
        health.kitMissing === 1 ? ' has' : 's have'
      } not come back`,
      tab: 'kit',
    });
  }
  if (health.kitOverdue) {
    reasons.push({
      code: 'kit-overdue',
      level: 'warning',
      label: `${health.kitOverdue} item${
        health.kitOverdue === 1 ? ' is' : 's are'
      } past the day they were due back`,
      tab: 'kit',
    });
  }
  /*
   * Not ready, and already under way. Before the start date this is a normal Tuesday, which is
   * why the engagement's own dates decide whether it is worth saying — see kitSummary.
   */
  if (health.kitOutstanding && health.started) {
    reasons.push({
      code: 'kit-not-ready',
      level: 'warning',
      label: `${health.kitOutstanding} item${
        health.kitOutstanding === 1 ? '' : 's'
      } still to sort out, and testing has started`,
      tab: 'kit',
    });
  }

  if (health.checksBlocked) {
    reasons.push({
      code: 'checks-blocked',
      level: 'note',
      label: `${health.checksBlocked} check${
        health.checksBlocked === 1 ? ' is' : 's are'
      } blocked and waiting on somebody`,
      tab: 'checks',
    });
  }
  if (health.checksOutstanding) {
    reasons.push({
      code: 'checks',
      level: 'warning',
      label: `${health.checksOutstanding} of ${health.checksTotal} checks still open`,
      tab: 'checks',
    });
  }
  /*
   * Staleness last, and only when nothing else already explains it. An engagement that is
   * overdue *and* untouched for a fortnight does not need two lines saying the same thing.
   */
  if (!reasons.length && health.staleDays >= STALE_DAYS && audit.state !== 'APPROVED') {
    reasons.push({
      code: 'stale',
      level: 'note',
      label: `Nothing has happened here for ${health.staleDays} days`,
      tab: 'overview',
    });
  }

  /*
   * Worst first, rather than in whatever order they happen to be pushed.
   *
   * The order used to be an accident of where each `if` sat in this function, which meant adding
   * a blocker below an existing warning quietly put it second on the row. Sorted by level and
   * otherwise stable, so the line somebody reads first is always the one that matters most.
   */
  const weight = { blocker: 0, warning: 1, note: 2 };
  return reasons
    .map((reason, index) => ({ reason, index }))
    .sort((a, b) => weight[a.reason.level] - weight[b.reason.level] || a.index - b.index)
    .map((entry) => entry.reason);
}

/** Worst first: a blocker outranks a warning, and more reasons outrank fewer. */
export const attentionRank = (reasons) => {
  const weight = { blocker: 100, warning: 10, note: 1 };
  return reasons.reduce((sum, reason) => sum + (weight[reason.level] ?? 0), 0);
};

export default engagementHealth;
