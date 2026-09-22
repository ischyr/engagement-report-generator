/**
 * What produced a document, and what was different about the one before it.
 *
 * Two questions, both previously unanswerable. "The last report had a table of contents" — did it?
 * The settings are a singleton anybody may edit and the template has been saved twice since, so the
 * only honest answer used to be a shrug. And: somebody forwards a .docx with no covering note; which
 * job is it, which template made it, and is it the version the client signed?
 *
 * The second is why `GET /renders/:renderId` exists. That id is stamped into the file itself as a
 * custom document property, so a person holding a mystery document can read it out of Word — File →
 * Info → Properties → Advanced — and paste it here.
 */

import { Router } from 'express';

import { RenderRecord } from '../models/render-record.model.js';
import { Audit } from '../models/audit.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { assertMayOpen } from '../services/classification.service.js';
import { membershipExpired } from '../utils/audit-scope.js';
import { forbidden } from '../utils/http-error.js';
import { reportSnapshot, snapshotDifferences } from '../utils/report-fingerprint.js';

const router = Router();

/**
 * Both halves of "may this person see this engagement".
 *
 * `assertMayOpen` is the classification rule and nothing else: it returns immediately unless the
 * engagement is restricted. Every route here called it and stopped, so the render register — which
 * template produced a document, what changed between two versions of it, how many findings it had
 * — answered to any signed-in account that knew an engagement id.
 *
 * The membership rule is the one `loadAudit` applies to everything under `/audits/:id`: creator,
 * collaborator or reviewer, and not past an end date. Written out rather than imported from that
 * file, which is nine thousand lines and would bring the whole of it along for one comparison.
 *
 * Every projection in this file therefore has to carry `memberUntil` — a route that leaves it out
 * would silently stop enforcing the expiry half, which is the quietest way for this to come back.
 */
function assertMayRead(audit, user) {
  assertMayOpen(audit, user);
  if (user.role === 'admin') return;
  const uid = String(user._id);
  const allowed = [
    audit.creator?._id?.toString() ?? audit.creator?.toString(),
    ...(audit.collaborators ?? []).map((person) => person._id?.toString() ?? person.toString()),
    ...(audit.reviewers ?? []).map((person) => person._id?.toString() ?? person.toString()),
  ];
  if (!allowed.includes(uid)) throw forbidden('You do not have access to this engagement');
  if (membershipExpired(audit, user)) {
    throw forbidden('Your access to this engagement ended. Ask whoever runs it to extend it.');
  }
}

/** The shape both endpoints answer in, so one component renders either. */
const present = (record) => ({
  renderId: record.renderId,
  kind: record.kind,
  subject: record.subject,
  at: record.createdAt ?? record.at,
  by: record.byName,
  template: record.templateName,
  templateId: record.template?._id ?? record.template ?? null,
  templateVersion: record.templateVersion,
  /** The house style it took, if any: "ENGY house base (page, styles)". */
  inheritedFrom: record.inheritedFrom ?? '',
  inheritedParts: record.inheritedParts ?? [],
  build: record.build,
  filename: record.filename,
  size: record.size,
  outputHash: record.outputHash,
  ms: record.ms,
  /* Where the time went, so a slow render is a thing somebody can act on rather than endure.
     A Map on the document; a plain object on the wire. */
  stages: record.stages ? Object.fromEntries(record.stages) : null,
  counts: record.counts ?? {},
  settings: record.settings ?? {},
  audit: record.audit?._id ?? record.audit ?? null,
  auditName: record.audit?.name ?? '',
  proposal: record.proposal?._id ?? record.proposal ?? null,
});

/**
 * The settings and counts that differ between two renders.
 *
 * Computed rather than stored, over exactly the fields that change what comes out — so "what was
 * different about the last one" is a list of facts rather than two screens to compare by eye. The
 * template version is in here too: the commonest real answer is "the template changed".
 */
function differences(now, before) {
  if (!before) return [];
  const rows = [];
  const say = (what, from, to) => rows.push({ what, from, to });

  if (now.templateName !== before.templateName) {
    say('Template', before.templateName, now.templateName);
  } else if (now.templateVersion !== before.templateVersion) {
    say('Template version', before.templateVersion, now.templateVersion);
  }
  if (now.build !== before.build) say('App build', before.build, now.build);

  /*
   * The house style, which the template version cannot show: pointing a child at a base changes
   * every document it makes while the child's own bytes stay byte-for-byte identical.
   */
  if ((now.inheritedFrom ?? '') !== (before.inheritedFrom ?? '')) {
    say('House style', before.inheritedFrom || 'none', now.inheritedFrom || 'none');
  } else if ((now.inheritedParts ?? []).join(', ') !== (before.inheritedParts ?? []).join(', ')) {
    say(
      'Inherited parts',
      (before.inheritedParts ?? []).join(', ') || 'none',
      (now.inheritedParts ?? []).join(', ') || 'none'
    );
  }

  const LABELS = {
    dateFormat: 'Date format',
    captionStyle: 'Caption style',
    findingIdPrefix: 'Finding prefix',
    codeBlockTheme: 'Code theme',
    imageBorder: 'Image borders',
    imageBorderColor: 'Image border colour',
    updateFieldsOnOpen: 'Word refreshes fields on open',
  };
  for (const [key, label] of Object.entries(LABELS)) {
    const from = before.settings?.[key];
    const to = now.settings?.[key];
    if (String(from ?? '') !== String(to ?? '')) say(label, from, to);
  }

  for (const [key, label] of Object.entries({
    findings: 'Findings',
    sections: 'Sections',
    images: 'Images',
    scope: 'Scope rows',
  })) {
    const from = before.counts?.[key];
    const to = now.counts?.[key];
    if (from !== null && from !== undefined && to !== null && to !== undefined && from !== to) {
      say(label, from, to);
    }
  }
  return rows;
}

/**
 * Every render of one engagement, newest first, each with what changed since the one before it.
 *
 * Read through the engagement rather than by itself, so a render is exactly as restricted as the
 * engagement it came from — `assertMayRead` is the same pair of rules the editor goes through.
 *
 * It used to say that about `assertMayOpen`, which was the bug: that function is the
 * classification rule alone and says nothing about membership.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.query.audit) throw badRequest('Say which engagement.');
    const audit = await Audit.findById(req.query.audit).select(
      'name reference creator collaborators reviewers classification deletedAt memberUntil'
    );
    if (!audit) throw notFound('Engagement not found');
    assertMayRead(audit, req.user);

    const records = await RenderRecord.find({ audit: audit._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const rows = records.map(present);
    /* Each row against its predecessor in time, which is the next one down the list. */
    res.json({
      renders: rows.map((row, index) => ({
        ...row,
        changedSincePrevious: differences(row, rows[index + 1] ?? null),
        /*
         * And what was different *in the report*, which `differences` cannot see.
         *
         * That one compares how the document was produced — template, build, settings, counts. This
         * compares what was in it. "Findings: 12 → 14" and "these two findings are new" are
         * different answers, and only the second one ends the conversation.
         */
        contentChangedSincePrevious: snapshotDifferences(
          records[index + 1]?.snapshot ?? null,
          records[index].snapshot ?? null
        ),
      })),
    });
  })
);

/**
 * Two renders, side by side — any two, not just consecutive ones.
 *
 * The register's own question is "what changed between the version they have and the one I am
 * about to send", and those are rarely next to each other: a fortnight of drafts sits between the
 * copy the client signed and the revision answering their comments.
 *
 * Both are read through their engagement, so a restricted engagement's renders stay as restricted
 * as the engagement — and both must belong to the *same* one, because a comparison across two
 * clients is either a mistake or an attempt to read one of them through the other.
 */
router.get(
  '/compare',
  asyncHandler(async (req, res) => {
    const { a, b } = req.query;
    if (!a || !b) throw badRequest('Name two renders to compare.');

    const [from, to] = await Promise.all([
      RenderRecord.findOne({ renderId: String(a) }),
      RenderRecord.findOne({ renderId: String(b) }),
    ]);
    if (!from || !to) throw notFound('One of those renders is not on record.');
    if (String(from.audit ?? '') !== String(to.audit ?? '')) {
      throw badRequest('Those two documents are from different engagements.');
    }

    const audit = await Audit.findById(from.audit).select(
      'name reference creator collaborators reviewers classification deletedAt memberUntil'
    );
    if (!audit) throw notFound('Engagement not found');
    assertMayRead(audit, req.user);

    /* Oldest first whichever way round they were named: "what changed" has a direction. */
    const [before, after] = from.createdAt <= to.createdAt ? [from, to] : [to, from];
    res.json({
      before: present(before),
      after: present(after),
      changed: differences(present(after), present(before)),
      /* With the words, because this is the one view somebody is reading the change in. */
      contentChanged: snapshotDifferences(before.snapshot ?? null, after.snapshot ?? null, {
        withText: true,
      }),
    });
  })
);

/**
 * One render against the engagement as it stands now.
 *
 * The delivery register's question, asked from the other end: the client is holding this document,
 * and the honest answer to "is it still current" has until now been a yes or a no from one hash.
 * This says which findings they have not seen.
 *
 * Deliberately compares against live content rather than against the newest render — somebody may
 * not have generated anything since editing, and "nothing has changed" would then be wrong in the
 * most confident possible way.
 */
router.get(
  '/:renderId/since',
  asyncHandler(async (req, res) => {
    const record = await RenderRecord.findOne({ renderId: req.params.renderId });
    if (!record) throw notFound('No record of that render.');
    if (!record.audit) throw badRequest('That render was not of an engagement.');

    const audit = await Audit.findById(record.audit);
    if (!audit) throw notFound('Engagement not found');
    assertMayRead(audit, req.user);

    res.json({
      renderId: record.renderId,
      at: record.createdAt,
      filename: record.filename,
      /* Null when the render predates snapshots — reported as unknown, never as unchanged. */
      contentChanged: snapshotDifferences(record.snapshot ?? null, reportSnapshot(audit), {
        withText: true,
      }),
    });
  })
);

/**
 * One render, by the id written inside the file.
 *
 * Deliberately reachable with nothing but the id: the point is that somebody holding an unlabelled
 * document can find out what it is. Still gated on being able to open the engagement it belongs to,
 * because the record names the client — an id is not a capability.
 */
router.get(
  '/:renderId',
  asyncHandler(async (req, res) => {
    const record = await RenderRecord.findOne({ renderId: req.params.renderId }).populate([
      { path: 'audit', select: 'name reference creator collaborators reviewers classification memberUntil' },
    ]);
    if (!record) {
      throw notFound(
        'No record of that render. It may predate this feature, or have been generated on another instance.'
      );
    }
    if (record.audit) assertMayRead(record.audit, req.user);
    res.json(present(record));
  })
);

export default router;
