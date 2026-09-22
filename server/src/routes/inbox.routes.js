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
import { findingSeverity } from '../services/cvss.js';

const router = Router();

const sameId = (a, b) => String(a?._id ?? a ?? '') === String(b?._id ?? b ?? '');

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = req.user._id;

    /**
     * The engagements that could have something for you, rather than all of them.
     *
     * Every section below is about *you*: a review you are a reviewer on, a finding assigned to
     * you or one you wrote, a question asked of you, a check you gave out or were given. An
     * engagement where none of those is true contributes nothing, and reading it is pure cost.
     *
     * That cost was not hypothetical. `visibleAuditFilter` scopes a normal account to the
     * engagements it is on — bounded by a career, which for somebody four years in is hundreds —
     * and for an **admin** it returns no clause at all, so the inbox read every engagement in the
     * instance, with every finding's comments and every test check, on every load of the page
     * people leave open all day. The list it produced was short either way; the read was not.
     *
     * Written as an `$or` inside `visibleAuditFilter`'s `extra`, so the access rule still wraps
     * it in `$and` and cannot be widened by what is added here — which is the whole reason that
     * helper takes an `extra` rather than expecting callers to merge clauses themselves.
     *
     * Each arm is deliberately *at least* as wide as the section it serves. The filtering that
     * decides what is really outstanding — a stale approval, a resolved comment, a done check —
     * stays in the loop below, where it can see the whole engagement. A query that tried to be
     * exact about those would be a second copy of the rules, and the copy that is subtly wrong is
     * the one that silently drops something from somebody's queue.
     */
    const mightHaveSomething = {
      $or: [
        /* A review you are on. State and freshness are judged below. */
        { reviewers: me },
        /* Findings that are yours to write, and comments on findings you wrote. */
        { 'findings.assignedTo': me },
        { 'findings.createdBy': me },
        /*
         * A question about one finding, asked of you or left open for anybody.
         *
         * `$elemMatch`, and this is not style. Written as
         * `{ 'findings.secondOpinion.askedAt': { $ne: null } }` it reads as "some finding has one",
         * and Mongo means the opposite: `$ne` against an array path matches only when *no* element
         * equals the value, so a single other finding with the field at its default of null made
         * the whole engagement fail the arm — and the question vanished from the inbox of the one
         * person it had been addressed to.
         */
        { findings: { $elemMatch: { 'secondOpinion.askedAt': { $ne: null } } } },
        /* Checks you were given, and checks you gave out. */
        { 'testChecks.assignedTo': me },
        { 'testChecks.createdBy': me },
      ],
    };

    const audits = await Audit.find(visibleAuditFilter(req.user, mightHaveSomething))
      // Only the fields the four sections need: an inbox must not drag whole
      // engagements (and their evidence-heavy rich text) across the wire.
      .select(
        'name reference state company approvals contentFingerprint reviewers collaborators creator updatedAt ' +
          'archivedAt ' +
          'findings._id findings.title findings.createdBy findings.comments ' +
          /*
           * For the findings that are somebody's. The vector and the override are here so the
           * list can be worst-first — which is the order a person picks what to write next — and
           * they are four short strings a finding, not the rich text this select exists to avoid.
           */
          'findings.identifier findings.assignedTo findings.cvssv3 findings.severityOverride ' +
          /* One question about one finding — see `secondOpinion` on the finding schema. */
          'findings.secondOpinion ' +
          /*
           * The six fields a check row is made of, not the whole check.
           *
           * A test check carries its result, its notes, who verified it and when — none of which
           * this page shows, and all of which was being read across every engagement.
           */
          'testChecks._id testChecks.title testChecks.category testChecks.createdAt ' +
          'testChecks.done testChecks.assignedTo testChecks.createdBy'
      )
      .populate([
        { path: 'company', select: 'name shortName' },
        { path: 'findings.comments.author', select: 'username firstname lastname' },
        { path: 'findings.secondOpinion.askedBy', select: 'username firstname lastname' },
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
    const opinions = [];
    /** Findings that are mine to write. */
    const findings = [];

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

      /*
       * Findings that are mine to write.
       *
       * What takes one out of this list is deliberately *not* a state on the finding: a finding
       * is never "done", it is delivered with the report. So the queue is emptied by the
       * engagement being approved — the writing is over — or by somebody handing it on. An
       * archived engagement is nobody's work either.
       *
       * Not folded in with the loop below, which is about a different obligation entirely:
       * "somebody commented on what I wrote" and "this is mine to write" are the mistake the
       * checks section already documents, where two obligations in one list counted twice.
       */
      if (audit.state !== 'APPROVED' && !audit.archivedAt) {
        for (const finding of audit.findings ?? []) {
          if (!sameId(finding.assignedTo, me)) continue;
          const rated = findingSeverity(finding);
          findings.push({
            auditId: audit._id,
            auditName: audit.name,
            reference: audit.reference ?? '',
            findingId: finding._id,
            identifier: finding.identifier ?? null,
            title: finding.title,
            severity: rated.severity,
            score: rated.score,
            sortScore: rated.sortScore,
          });
        }
      }

      /*
       * Somebody asked about one finding, and it is still open.
       *
       * Addressed to you, or addressed to nobody on an engagement you are on — "whoever is free"
       * is half of why anybody asks, and a question nobody can see is the chat message this
       * replaced. Your own question is not news to you.
       *
       * Included on an approved engagement, unlike the assigned list above: a question asked
       * during sign-off is exactly the one still worth answering, and the engagement being locked
       * is what makes it urgent rather than what makes it moot.
       */
      for (const finding of audit.findings ?? []) {
        const ask = finding.secondOpinion;
        if (!ask?.askedAt || ask.answeredAt) continue;
        if (sameId(ask.askedBy, me)) continue;
        if (ask.of && !sameId(ask.of, me)) continue;
        opinions.push({
          auditId: audit._id,
          auditName: audit.name,
          findingId: finding._id,
          findingTitle: finding.title,
          identifier: finding.identifier ?? null,
          question: ask.question ?? '',
          askedBy: ask.askedBy,
          askedAt: ask.askedAt,
          /* Whether it was aimed at you or left open, which changes how much it is your problem. */
          addressed: Boolean(ask.of),
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
    /* Worst first, which is the order somebody with nine findings to write works in. */
    findings.sort((a, b) => b.sortScore - a.sortScore);

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

    /* Aimed at you first, then oldest first: a question nobody has answered for a week is the
     * one that has stopped being a question and started being a problem. */
    opinions.sort(
      (a, b) => Number(b.addressed) - Number(a.addressed) || new Date(a.askedAt) - new Date(b.askedAt)
    );
    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    checks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      counts: {
        reviews: reviews.length,
        mentions: unreadMentions,
        comments: comments.length,
        checks: checks.length,
        assigned: assigned.length,
        findings: findings.length,
        opinions: opinions.length,
        total:
          reviews.length +
          unreadMentions +
          comments.length +
          checks.length +
          assigned.length +
          findings.length +
          opinions.length,
      },
      reviews,
      mentions,
      comments,
      checks,
      assigned,
      findings,
      opinions,
    });
  })
);

export default router;
