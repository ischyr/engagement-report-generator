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

const router = Router();

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
 * Read through the engagement rather than by itself, so a restricted engagement's renders are as
 * restricted as the engagement — `assertMayOpen` is the same gate the editor goes through.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.query.audit) throw badRequest('Say which engagement.');
    const audit = await Audit.findById(req.query.audit).select(
      'name reference creator collaborators reviewers classification deletedAt'
    );
    if (!audit) throw notFound('Engagement not found');
    assertMayOpen(audit, req.user);

    const records = await RenderRecord.find({ audit: audit._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const rows = records.map(present);
    /* Each row against its predecessor in time, which is the next one down the list. */
    res.json({
      renders: rows.map((row, index) => ({
        ...row,
        changedSincePrevious: differences(row, rows[index + 1] ?? null),
      })),
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
      { path: 'audit', select: 'name reference creator collaborators reviewers classification' },
    ]);
    if (!record) {
      throw notFound(
        'No record of that render. It may predate this feature, or have been generated on another instance.'
      );
    }
    if (record.audit) assertMayOpen(record.audit, req.user);
    res.json(present(record));
  })
);

export default router;
