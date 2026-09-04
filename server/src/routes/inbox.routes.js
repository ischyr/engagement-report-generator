/**
 * What is waiting on *you*.
 *
 * Everything here was already in the database, but scattered across places you had
 * to go looking: a review request in the engagements list, an unresolved comment
 * three clicks inside a finding, a mention in a bell that scrolls away, a check you
 * wrote that nobody ticked. Collecting them costs one query and turns four habits
 * into one page.
 *
 * Deliberately only things that need *this* user. A general activity feed is the
 * per-engagement Activity tab's job.
 */

import { Router } from 'express';

import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import asyncHandler from '../utils/async-handler.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { freshApprovals } from '../utils/report-fingerprint.js';

const router = Router();

const sameId = (a, b) => String(a?._id ?? a ?? '') === String(b?._id ?? b ?? '');

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = req.user._id;

    const audits = await Audit.find(visibleAuditFilter(req.user))
      // Only the fields the four sections need: an inbox must not drag whole
      // engagements (and their evidence-heavy rich text) across the wire.
      .select(
        'name reference state company approvals contentFingerprint reviewers collaborators creator updatedAt ' +
          'findings._id findings.title findings.createdBy findings.comments ' +
          'testChecks'
      )
      .populate([
        { path: 'company', select: 'name shortName' },
        { path: 'findings.comments.author', select: 'username firstname lastname' },
        { path: 'testChecks.createdBy', select: 'username' },
      ])
      .sort({ updatedAt: -1 });

    const settings = await Settings.getSettings();
    // Only for the "2 of 3 approved" readout. Deliberately *not* used to decide
    // whether to show a review at all: `reviews.enabled` governs whether approvals
    // are enforced before sign-off, and it is off by default — gating on it would
    // hide review requests that the notification bell has already sent.
    const minReviewers = settings.reviews?.public?.minReviewers ?? 1;

    const reviews = [];
    const comments = [];
    const checks = [];
    /** Checks somebody handed to me and I have not done. */
    const assigned = [];

    for (const audit of audits) {
      const isReviewer = (audit.reviewers ?? []).some((r) => sameId(r, me));
      // A signature given before the report changed is not a signature on this
      // report, so it puts the review back in your queue rather than counting.
      const approved = freshApprovals(audit).some((a) => sameId(a.user, me));

      // A review is outstanding only while it is actually in review and you have
      // not already signed it off.
      if (isReviewer && audit.state === 'REVIEW' && !approved) {
        reviews.push({
          auditId: audit._id,
          name: audit.name,
          reference: audit.reference,
          company: audit.company?.name ?? '',
          approvals: freshApprovals(audit).length,
          minReviewers,
          updatedAt: audit.updatedAt,
        });
      }

      for (const finding of audit.findings ?? []) {
        // Comments on findings you wrote. Your own comments are not news to you.
        const mine = sameId(finding.createdBy, me);
        if (!mine) continue;

        for (const comment of finding.comments ?? []) {
          if (comment.resolved) continue;
          if (sameId(comment.author, me)) continue;
          comments.push({
            auditId: audit._id,
            auditName: audit.name,
            findingId: finding._id,
            findingTitle: finding.title,
            commentId: comment._id,
            body: comment.body,
            field: comment.field ?? '',
            author: comment.author,
            createdAt: comment.createdAt,
          });
        }
      }

      for (const check of audit.testChecks ?? []) {
        if (check.done) continue;
        const row = {
          auditId: audit._id,
          auditName: audit.name,
          checkId: check._id,
          title: check.title,
          category: check.category ?? '',
          createdAt: check.createdAt,
        };
        /*
         * Two different obligations, deliberately kept apart.
         *
         * "Somebody gave me this" and "I asked for this and nobody has done it" are not the
         * same thing, and folding them into one list is exactly what made mentions show up
         * twice and count twice before.
         */
        if (sameId(check.assignedTo, me)) assigned.push(row);
        else if (sameId(check.createdBy, me)) checks.push(row);
      }
    }

    assigned.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Mentions come from the notifications collection rather than being recomputed
    // from comment text: read state is personal and already tracked there.
    //
    // Mentions *only*. The other two notification types announce exactly what the
    // sections above derive from the engagements themselves — a review requested, a
    // comment on your finding — so listing them here as well showed one obligation
    // twice and counted it twice.
    //
    // Read ones stay for a fortnight instead of vanishing. The bell keeps every
    // notification it has ever shown, so dropping a mention from here the moment it
    // was clicked made the two disagree: the bell still listed it, the inbox claimed
    // there had never been one. Unread mentions are included however old they are —
    // age does not settle an obligation — and only they are counted, so "waiting on
    // you" still means waiting.
    const readMentionsSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const mentions = await Notification.find({
      user: me,
      type: 'mention',
      $or: [{ read: false }, { createdAt: { $gte: readMentionsSince } }],
    })
      .populate('actor', 'username firstname lastname')
      // read: 1 sorts false before true, so what needs you comes first.
      .sort({ read: 1, createdAt: -1 })
      .limit(50);

    const unreadMentions = mentions.filter((mention) => !mention.read).length;

    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    checks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      counts: {
        reviews: reviews.length,
        mentions: unreadMentions,
        comments: comments.length,
        checks: checks.length,
        assigned: assigned.length,
        total:
          reviews.length + unreadMentions + comments.length + checks.length + assigned.length,
      },
      reviews,
      mentions,
      comments,
      checks,
      assigned,
    });
  })
);

export default router;
