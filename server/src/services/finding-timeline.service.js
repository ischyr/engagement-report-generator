/**
 * What has happened to one finding, in order.
 *
 * A finding carried a status and no history. It could say it was fixed and nothing could say when,
 * by whom, whether it had been marked fixed once before and come back, or which version of the
 * report the client actually read it in — all of which is reconstructed from memory in exactly the
 * conversation where memory is contested.
 *
 * Deliberately a *lifecycle*, not an edit log. Every keystroke is already in the engagement's
 * activity feed; this answers the handful of questions somebody actually asks about a finding:
 * when it appeared, when its rating changed and why, when its status moved and who moved it, what
 * was said about it, and which delivered versions it was in.
 */

/** Ordered as they read: the thing that happened, then who, then when. */
const EVENTS = {
  created: 'Written up',
  imported: 'Pulled in from the library',
  severity: 'Severity overridden',
  'severity-cleared': 'Severity override removed',
  status: 'Status changed',
  comment: 'Comment',
  delivered: 'In the report sent to the client',
  edited: 'Last edited',
};

const idOf = (value) => String(value?._id ?? value ?? '');
const at = (value) => (value ? new Date(value) : null);

/**
 * @param {object} finding a finding subdocument, ideally with authors populated
 * @param {Array} deliveries this engagement's delivery records, newest or oldest first
 */
export function findingTimeline(finding, deliveries = []) {
  const events = [];
  const push = (kind, when, extra = {}) => {
    const instant = at(when);
    if (!instant || Number.isNaN(instant.getTime())) return;
    events.push({ kind, label: EVENTS[kind] ?? kind, at: instant, ...extra });
  };

  push('created', finding.createdAt, {
    by: finding.createdBy ?? null,
    /*
     * A finding that carries a library id was pulled in rather than typed. Said on the same event
     * rather than as a second one, because there is only one timestamp and inventing a separate
     * "imported" moment would put two entries on the timeline for one thing that happened.
     */
    fromLibrary: Boolean(finding.vulnerability),
  });

  if (finding.severityOverrideAt) {
    push(finding.severityOverride ? 'severity' : 'severity-cleared', finding.severityOverrideAt, {
      by: finding.severityOverrideBy ?? null,
      severity: finding.severityOverride ?? '',
      reason: finding.severityOverrideReason ?? '',
    });
  }

  for (const entry of finding.statusHistory ?? []) {
    push('status', entry.at, { by: entry.by ?? null, status: entry.status });
  }

  for (const comment of finding.comments ?? []) {
    push('comment', comment.createdAt, {
      by: comment.author ?? null,
      body: comment.body ?? '',
      field: comment.field ?? '',
      resolved: Boolean(comment.resolved),
    });
  }

  /*
   * Which delivered versions this finding was in.
   *
   * Inferred from the dates rather than recorded: a delivery sent after the finding was written
   * contained it. That is right in every ordinary case and wrong in one — a finding deleted and
   * restored around a delivery — so it is labelled as inferred and the report data, which is what
   * actually went out, remains the authority. Better than the alternative, which was nothing.
   */
  const born = at(finding.createdAt);
  if (born) {
    for (const delivery of deliveries) {
      const sent = at(delivery.sentAt);
      if (!sent || sent < born) continue;
      push('delivered', sent, {
        version: delivery.version ?? '',
        inferred: true,
      });
    }
  }

  // Only when it says something the creation event does not.
  const edited = at(finding.updatedAt);
  if (edited && born && edited.getTime() - born.getTime() > 60_000) {
    push('edited', edited, { by: finding.updatedBy ?? null });
  }

  events.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));

  return {
    events,
    /** How long it has been open, in days, or null once it is fixed. */
    ageDays:
      finding.remediationStatus === 'fixed' || !born
        ? null
        : Math.floor((Date.now() - born.getTime()) / 86_400_000),
    /*
     * Marked fixed and then moved off fixed again. The single most useful thing this history
     * knows, and the one nobody could previously prove.
     */
    reopened: (finding.statusHistory ?? []).some((entry, index, all) => {
      if (index === 0) return false;
      return all[index - 1].status === 'fixed' && entry.status !== 'fixed';
    }),
    versions: [
      ...new Set(
        events.filter((event) => event.kind === 'delivered').map((event) => event.version)
      ),
    ].filter(Boolean),
  };
}

/** True when this person wrote the finding — used to word an event rather than to authorise. */
export const isAuthor = (finding, user) => idOf(finding.createdBy) === idOf(user);

export default findingTimeline;
