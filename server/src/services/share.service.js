/**
 * What a client sees, and what they may change.
 *
 * This is the only place in the app that shapes data for somebody with no account, so it is
 * written as a whitelist and not as a filter. A filter says what to remove and quietly ships
 * whatever nobody thought of; a whitelist names each field that goes out, and a field added to a
 * finding next year does not reach a client because somebody forgot this file existed.
 *
 * **What goes out:** the engagement's name and window, the client's own name, and per finding its
 * identifier, title, severity, score, the description and the remediation, and its status.
 *
 * **What never does, and why:**
 *
 *   - the proof of concept — payloads, tokens, session cookies and the exact steps to do it again.
 *     The client has this in their report, which is a document they control; a link that can be
 *     forwarded is not the same thing, and this is the field where the difference bites.
 *   - evidence. Images are stripped from the text that does go out, because a screenshot is where
 *     a password ends up by accident, and because serving media would mean a second public route
 *     over the same bearer token.
 *   - everything internal: notes, credentials, the enumeration, reviewer comments, test checks,
 *     questions, custom fields, and who on the team wrote what.
 *   - anything on an engagement that is not yet delivered. A link is made after the report goes,
 *     and a draft finding is not something a client should be reading over somebody's shoulder.
 *
 * ## The status link
 *
 * `statusView` is the second kind, and it is the one exception to the last rule — so it is worth
 * being precise about why it is not really an exception at all. It exists *during* the test, to
 * answer "how is it going" without an email, and it carries **no finding text of any kind**: not a
 * title, not a description, not a status. It shows how much of the scope has been reached, how many
 * findings exist by severity, and the assets the client needs to do something about — which is
 * their own data, about their own estate, given to us by them.
 *
 * The rule that holds is the one underneath: a client never reads a draft finding over somebody's
 * shoulder. A count is not a draft.
 */
import crypto from 'node:crypto';

import { ShareLink } from '../models/share-link.model.js';
import { calculateCvss, severityColor } from './cvss.js';
import { sanitizeHtml } from './html-report.service.js';
import { stripImages } from './media.service.js';
import { badRequest, notFound } from '../utils/http-error.js';

/** A week is the default because that is roughly how long a person acts on an email. */
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 180;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * A new link for one engagement.
 *
 * Earlier links are left alone, unlike an account token: two people at a client may each need
 * their own, and revoking one should not silently revoke the other's.
 */
export async function issueShareLink({
  audit,
  label = '',
  days = DEFAULT_DAYS,
  allowUpdates = true,
  allowEvidence = false,
  kind = 'findings',
  actor = null,
}) {
  const lifetime = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  /* 32 bytes, url-safe: guessing is not a strategy, and it still fits in a message. */
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetime * 24 * 60 * 60 * 1000);

  const row = await ShareLink.create({
    audit: audit._id,
    tokenHash: hash(token),
    label: String(label ?? '').trim(),
    /* A status link is a window, never a door: nothing on it can be changed from outside. */
    allowUpdates: kind === 'status' ? false : Boolean(allowUpdates),
    /*
     * Only ever on a findings link that can be written to at all. A status link has no findings
     * on it, and a read-only link that accepted files would be a contradiction somebody would
     * eventually rely on.
     */
    allowEvidence: kind === 'status' ? false : Boolean(allowUpdates) && Boolean(allowEvidence),
    kind: kind === 'status' ? 'status' : 'findings',
    expiresAt,
    createdBy: actor?._id ?? null,
  });

  return { link: row, token, expiresAt, path: `/shared/${token}` };
}

/**
 * The link behind a token, if it is still good for anything.
 *
 * Says nothing about *why* it failed. Expired, revoked and never-existed are one answer to
 * somebody guessing, and the person holding a real link does not need the distinction to know
 * they should ask for another.
 */
export async function readShareLink(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const row = await ShareLink.findOne({ tokenHash: hash(token) }).populate({
    path: 'audit',
    select:
      'name reference auditType date date_start date_end state deletedAt company findings ' +
      /* For the status view: coverage comes off the scope, and "as of" off the timestamps. */
      'scope updatedAt detailsUpdatedAt',
    populate: { path: 'company', select: 'name' },
  });
  if (!row || !row.audit || row.audit.deletedAt) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/** Severity first, worst at the top — the order somebody fixing things wants. */
const RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, None: 0 };

/**
 * The engagement as the client sees it.
 *
 * @param {object} link a `ShareLink` with its audit populated
 * @param {object} [cvssColors] the instance's palette, so severities look like the report's
 */
export function clientView(link, cvssColors = {}) {
  const audit = link.audit;
  const findings = (audit.findings ?? [])
    .map((finding) => {
      const cvss = calculateCvss(finding.cvssv3);
      const severity = finding.severityOverride || cvss.baseSeverity;
      return {
        _id: String(finding._id),
        identifier: finding.identifier ?? '',
        title: finding.title ?? '',
        severity,
        severityColor: severityColor(severity, cvssColors),
        score: cvss.baseScore,
        /*
         * Sanitised, then stripped of images.
         *
         * Sanitised because this is the one page in the app rendered for somebody with no account
         * and no relationship to whoever wrote the HTML — the editor produces safe markup, but a
         * write-up can be pasted into, imported from a spreadsheet or restored from an old record,
         * and "it came from our own editor" is an assumption rather than a guarantee. The report
         * already runs everything through this on its way to an HTML deliverable; a public page
         * deserves it at least as much.
         *
         * Images stripped after, because a screenshot is where a password ends up by accident and
         * serving one would need a second public route over the same bearer token.
         */
        description: stripImages(sanitizeHtml(finding.description ?? '')).html,
        remediation: stripImages(sanitizeHtml(finding.remediation ?? '')).html,
        status: ['open', 'retesting', 'fixed'].includes(finding.remediationStatus)
          ? finding.remediationStatus
          : 'open',
        /**
         * What they told us last time, read back to them.
         *
         * Without this the page forgets: a client who explained what they had changed sees the
         * same empty box on their next visit and cannot tell whether it arrived. Their own words
         * and their own attachments only — nothing the team has written about the claim.
         */
        claim: finding.clientClaim?.status
          ? {
              status: finding.clientClaim.status,
              at: finding.clientClaim.at ?? null,
              note: finding.clientClaim.note ?? '',
              /* How many, not which: the bytes are not served over this token. */
              attachments: (finding.clientClaim.media ?? []).length,
            }
          : null,
      };
    })
    .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || b.score - a.score);

  return {
    engagement: {
      name: audit.name,
      reference: audit.reference ?? '',
      type: audit.auditType ?? '',
      client: audit.company?.name ?? '',
      from: audit.date_start ?? '',
      to: audit.date_end ?? '',
    },
    findings,
    counts: {
      total: findings.length,
      open: findings.filter((finding) => finding.status !== 'fixed').length,
      fixed: findings.filter((finding) => finding.status === 'fixed').length,
    },
    allowUpdates: link.allowUpdates,
    /** Whether the page offers to attach a screenshot. Off unless somebody allowed it. */
    allowEvidence: Boolean(link.allowEvidence),
    expiresAt: link.expiresAt,
  };
}

/** What the client is told the engagement is doing, from the state the team set. */
const STATE_LABEL = {
  EDIT: 'Testing in progress',
  REVIEW: 'Testing finished — the report is being reviewed',
  APPROVED: 'The report has been issued',
};

/**
 * How far through the scope the team has got, from the statuses on the hosts.
 *
 * `statusNote` is the field to lean on here: the model documents it as *a sentence for the client*
 * explaining why an asset was excluded or what happened to it, as distinct from the operator's own
 * working notes, which never leave the app. So the two lists below are the ones the client can act
 * on — something they need to give us access to, or something they should know we did not test —
 * and both were already written for exactly this audience.
 */
function coverageOf(audit) {
  const hosts = (audit.scope ?? []).flatMap((group) =>
    (group.hosts ?? []).filter((host) => host.hostname || host.ip)
  );
  const named = (host) =>
    [host.hostname, host.ip].map((value) => String(value ?? '').trim()).filter(Boolean).join(' · ');

  const by = (status) => hosts.filter((host) => (host.status ?? 'pending') === status);
  const listed = (status) =>
    by(status)
      .slice(0, 40)
      .map((host) => ({ asset: named(host), note: String(host.statusNote ?? '').trim() }));

  return {
    total: hosts.length,
    tested: by('tested').length,
    pending: by('pending').length,
    excluded: by('excluded').length,
    /* Named, because these are the two a client can do something about. */
    notYetTested: listed('pending'),
    excludedAssets: listed('excluded'),
  };
}

/**
 * The engagement as the client sees it *while it is happening*.
 *
 * A separate whitelist from `clientView`, not a variation on it, because the two answer different
 * questions and are trusted differently. This one says how far along the work is and how much has
 * been found — and deliberately not *what* has been found: a severity count is a fact about
 * progress, and a draft finding is somebody's half-written argument. Nothing here is a promise
 * about the final report, and the page says so.
 *
 * @param {object} link a `ShareLink` with its audit populated
 */
export function statusView(link) {
  const audit = link.audit;
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, None: 0 };
  for (const finding of audit.findings ?? []) {
    const severity = finding.severityOverride || calculateCvss(finding.cvssv3).baseSeverity;
    if (counts[severity] !== undefined) counts[severity] += 1;
  }

  const coverage = coverageOf(audit);

  return {
    kind: 'status',
    engagement: {
      name: audit.name,
      reference: audit.reference ?? '',
      type: audit.auditType ?? '',
      client: audit.company?.name ?? '',
      from: audit.date_start ?? '',
      to: audit.date_end ?? '',
    },
    state: audit.state ?? 'EDIT',
    stateLabel: STATE_LABEL[audit.state] ?? STATE_LABEL.EDIT,
    coverage,
    /* By severity and nothing else. No titles, no text, no statuses. */
    findings: {
      total: (audit.findings ?? []).length,
      bySeverity: Object.entries(counts).map(([severity, count]) => ({ severity, count })),
    },
    /*
     * When the picture below last moved, so a page that has not changed since Tuesday says so
     * rather than looking live. `detailsUpdatedAt` moves on the edits that matter; `updatedAt`
     * moves on any save at all, and the later of the two is the honest answer.
     */
    asOf: new Date(
      Math.max(
        new Date(audit.detailsUpdatedAt ?? 0).getTime(),
        new Date(audit.updatedAt ?? 0).getTime()
      ) || Date.now()
    ),
    expiresAt: link.expiresAt,
  };
}

/**
 * Records that somebody opened it.
 *
 * A bare update rather than a save, so two people reading at once cannot collide, and so this
 * cannot fail the request that it is only a footnote to.
 */
export async function noteView(link) {
  await ShareLink.updateOne(
    { _id: link._id },
    { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } }
  ).catch(() => {});
}

/**
 * The client's own change to one finding.
 *
 * The only write this surface allows, and it moves one field between two values. `retesting` is
 * not offered: it means somebody on the team is checking, which is not a claim a client can make
 * about themselves.
 *
 * @returns {{finding: object, from: string, to: string}}
 */
export function applyClientStatus(audit, findingId, fixed, label = '', note = '') {
  const finding = audit.findings.id(findingId);
  if (!finding) throw notFound('That finding is not on this report');

  const from = finding.remediationStatus ?? 'open';
  const to = fixed ? 'fixed' : 'open';

  /*
   * A note on its own is a change worth keeping.
   *
   * The status was the only thing this function moved, so a client who came back to explain what
   * they had done — having already ticked the box — was answered with silence and nothing was
   * recorded. The status is unchanged in that case and the caller is told so, which is what stops
   * it announcing a fix twice.
   */
  const said = String(note ?? '').trim().slice(0, 2000);
  if (from === to) {
    if (said && said !== (finding.clientClaim?.note ?? '')) {
      finding.clientClaim = {
        ...(finding.clientClaim?.toObject?.() ?? finding.clientClaim ?? {}),
        status: finding.clientClaim?.status || to,
        at: new Date(),
        by: String(label ?? '').slice(0, 160),
        note: said,
      };
      return { finding, from, to, noted: true };
    }
    return { finding, from, to, noted: false };
  }

  /*
   * A finding the team is actively retesting is not something a client can move. Saying so is
   * better than silently winning: two people are looking at the same row and one of them has more
   * information about it.
   */
  if (from === 'retesting') {
    throw badRequest('That finding is being retested at the moment, so it cannot be changed here.');
  }

  finding.remediationStatus = to;
  /*
   * The claim, recorded beside the status rather than inside it.
   *
   * `fixed` set by a client and `fixed` set by a tester who retested it are the same value and
   * very different facts, and a report generated between the two would state the second on the
   * strength of the first. This is what lets the team see which is which — and it is cleared the
   * moment anybody on the team sets the status themselves.
   */
  finding.clientClaim = {
    status: to,
    at: new Date(),
    by: String(label ?? '').slice(0, 160),
    /** What they say they did. Plain text: see the field's own note in audit.model.js. */
    note: said,
    /* Anything they attached earlier stays attached to the claim it belongs to. */
    media: finding.clientClaim?.media ?? [],
  };
  return { finding, from, to, noted: Boolean(said) };
}

export default { issueShareLink, readShareLink, clientView, noteView, applyClientStatus };
