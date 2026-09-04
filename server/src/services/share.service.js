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
export async function issueShareLink({ audit, label = '', days = DEFAULT_DAYS, allowUpdates = true, actor = null }) {
  const lifetime = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  /* 32 bytes, url-safe: guessing is not a strategy, and it still fits in a message. */
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetime * 24 * 60 * 60 * 1000);

  const row = await ShareLink.create({
    audit: audit._id,
    tokenHash: hash(token),
    label: String(label ?? '').trim(),
    allowUpdates: Boolean(allowUpdates),
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
      'name reference auditType date date_start date_end state deletedAt company findings',
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
export function applyClientStatus(audit, findingId, fixed, label = '') {
  const finding = audit.findings.id(findingId);
  if (!finding) throw notFound('That finding is not on this report');

  const from = finding.remediationStatus ?? 'open';
  const to = fixed ? 'fixed' : 'open';
  if (from === to) return { finding, from, to };

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
  finding.clientClaim = { status: to, at: new Date(), by: String(label ?? '').slice(0, 160) };
  return { finding, from, to };
}

export default { issueShareLink, readShareLink, clientView, noteView, applyClientStatus };
