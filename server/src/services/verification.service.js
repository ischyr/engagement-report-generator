/**
 * Everything a client has said, across every engagement, that nobody has answered yet.
 *
 * Two things reach the team from outside it, both through a share link and both landing deep
 * inside one engagement: a claim that a finding is fixed, and a question about one. The Retest tab
 * gathers the first and the Questions tab the second — per engagement, which is the wrong scope for
 * the question people actually ask on a Monday morning. A client who marks six findings fixed on a
 * Friday is discoverable only by opening six tabs, and only by somebody who already suspected.
 *
 * Nothing here is new data, and nothing here is a new rule:
 *
 *   - a claim is unverified exactly while it is still present. The model clears `clientClaim` the
 *     moment somebody on the team sets `remediationStatus` themselves, which is what keeps "they
 *     say it is fixed" apart from "we checked" — so this needs no cleverness to find them.
 *   - a client's question is one with `fromClient` set, which holds the label of the link it came
 *     through. `status: 'open'` means nobody has written an answer.
 *
 * Scope is the shared one. `visibleAuditFilter` decides what a person may see, so a queue can never
 * show more than the engagements list would; archived engagements are left out the same way the
 * working list leaves them out. **Approved engagements are kept in**, deliberately: a share link
 * refuses new claims and questions once a report is closed, so anything still outstanding there
 * arrived before the close and is precisely the thing that would otherwise be lost.
 */

import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { calculateCvss } from './cvss.js';

/** Only the fields the two lists draw — never a finding's prose. */
const FIELDS =
  'name reference state company creator collaborators updatedAt ' +
  /*
   * `findings._id` is named, and has to be.
   *
   * A projection of embedded fields does not carry the subdocument's own id the way a top-level
   * projection carries the document's — `findings.title` alone answers with objects holding a
   * title and nothing else. Every row here links to a finding and every button writes to one, so
   * leaving it out produced a queue of rows addressed to the empty string.
   */
  'findings._id findings.title findings.identifier findings.cvssv3 findings.severityOverride ' +
  'findings.remediationStatus findings.clientClaim findings.assignedTo ' +
  'questions';

const idOf = (value) => String(value?._id ?? value ?? '');

/** The rating a row is ordered by — the reported severity, which may be an override. */
function rate(finding) {
  const cvss = calculateCvss(finding.cvssv3);
  return {
    severity: finding.severityOverride || cvss.baseSeverity,
    score: cvss.baseScore,
  };
}

const RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, None: 0 };

/** An ObjectId as a string, which is what a client question carries as its context. */
const looksLikeId = (value) => /^[a-f0-9]{24}$/i.test(String(value ?? ''));

export async function verificationQueue(user) {
  const me = idOf(user);
  const audits = await Audit.find(visibleAuditFilter(user, { archivedAt: null }))
    .select(FIELDS)
    .populate([{ path: 'company', select: 'name shortName' }])
    .lean();

  const claims = [];
  const questions = [];

  for (const audit of audits) {
    const where = {
      auditId: idOf(audit),
      name: audit.name,
      reference: audit.reference,
      state: audit.state,
      company: audit.company?.name ?? '',
      /*
       * Whether this is one of mine, which is what the filter on the page narrows by. Being on the
       * engagement counts, not only being handed the finding: a queue that showed a lead nothing
       * because every finding was assigned to somebody else would answer the wrong question.
       */
      mine:
        idOf(audit.creator) === me ||
        (audit.collaborators ?? []).some((person) => idOf(person) === me),
    };

    const byId = new Map((audit.findings ?? []).map((finding) => [idOf(finding), finding]));

    for (const finding of audit.findings ?? []) {
      if (!finding.clientClaim?.status) continue;
      const rated = rate(finding);
      claims.push({
        ...where,
        mine: where.mine || idOf(finding.assignedTo) === me,
        findingId: idOf(finding),
        identifier: finding.identifier ?? null,
        title: finding.title,
        severity: rated.severity,
        score: rated.score,
        remediationStatus: finding.remediationStatus,
        /** 'fixed' is a claim to check; 'open' is the client telling us it is still there. */
        kind: finding.clientClaim.status,
        by: finding.clientClaim.by ?? '',
        at: finding.clientClaim.at ?? null,
        note: finding.clientClaim.note ?? '',
        attachments: finding.clientClaim.media?.length ?? 0,
      });
    }

    for (const question of audit.questions ?? []) {
      if (!question.fromClient || question.status !== 'open') continue;
      /*
       * A question asked through a link carries the finding's id as its context — see the share
       * route that writes it. Resolved to a title here rather than on the page, because the page
       * is not given the findings to resolve it against.
       */
      const about = looksLikeId(question.context) ? byId.get(String(question.context)) : null;
      questions.push({
        ...where,
        questionId: idOf(question),
        text: question.text,
        at: question.createdAt ?? null,
        from: question.fromClient,
        findingId: about ? idOf(about) : null,
        findingTitle: about?.title ?? '',
      });
    }
  }

  /*
   * Oldest first, both lists. This is a queue, and the thing that has been waiting longest is the
   * thing somebody is about to be asked about — which is the opposite of the newest-first order
   * every other list in the app uses, and the reason it is stated here rather than left to a
   * default. Within the same day, worse findings first.
   */
  const oldestFirst = (a, b) => new Date(a.at ?? 0) - new Date(b.at ?? 0);
  claims.sort(
    (a, b) =>
      oldestFirst(a, b) ||
      (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) ||
      (b.score ?? 0) - (a.score ?? 0)
  );
  questions.sort(oldestFirst);

  const waiting = [...claims, ...questions]
    .map((row) => (row.at ? new Date(row.at).getTime() : null))
    .filter((time) => time !== null);

  return {
    claims,
    questions,
    totals: {
      claims: claims.length,
      /** Claims of a fix, which are the ones that are actually work. */
      toVerify: claims.filter((row) => row.kind === 'fixed').length,
      questions: questions.length,
      mine: [...claims, ...questions].filter((row) => row.mine).length,
      /** How long the oldest thing has been waiting, in whole days. */
      oldestDays: waiting.length
        ? Math.floor((Date.now() - Math.min(...waiting)) / 86400000)
        : null,
    },
  };
}

export default verificationQueue;
