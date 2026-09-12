/**
 * The client's own view of their findings, and the team's control of it.
 *
 * Mounted **before** the authentication gate, like the intake questionnaire, because the person
 * this exists for has no account. Everything under `/share/link` applies `requireAuth` itself; the
 * two token routes are open by design and defended by four things instead:
 *
 *   1. the token is 32 random bytes, kept only as a hash
 *   2. every hit is rate limited per address
 *   3. a failure says nothing about why — expired, revoked and never-real are one answer
 *   4. what a valid token can reach is a whitelist in `share.service.js`, not a filter here
 *
 * ## The write, and why it is no longer one field
 *
 * It used to be, and the reason was good enough to quote:
 *
 *   "The write is deliberately one field with two values. Anything more — a comment, an
 *    attachment, a date — is a second thing to validate, sanitise, store and show to the team,
 *    over a credential that can be forwarded in an email."
 *
 * All of that is still true. What changed is the judgement of whether it is worth it, and what
 * changed it is what the boolean actually produced: a finding that said the client believed it was
 * fixed, and nothing about what they had done. The retest then began with an email asking them,
 * which is the conversation this link exists to save.
 *
 * So there are two more things now, each with the defences that decision demanded:
 *
 * **A note.** Plain text, capped at two thousand characters, stored as typed and rendered as text.
 * Every other free field in this application is editor HTML through a sanitiser; this one is not
 * offered the chance, because it arrives over a credential that may have been forwarded to
 * somebody nobody intended.
 *
 * **A screenshot.** Off unless somebody switched it on for this one link, refused outright on a
 * restricted engagement, images only and sniffed by content rather than trusted by their header,
 * five megabytes, at most six per link, and rate limited harder than reading is. It lands in the
 * evidence bin marked as the client's own and nothing puts it in a report by itself.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { Settings } from '../models/settings.model.js';
import { ACTIONS } from '../models/activity.model.js';
import { recordActivity } from '../services/activity.service.js';
import {
  applyClientStatus,
  clientView,
  DEFAULT_DAYS,
  issueShareLink,
  MAX_DAYS,
  noteView,
  readShareLink,
  statusView,
} from '../services/share.service.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { isRestricted } from '../services/classification.service.js';
import { saveMedia } from '../services/media.service.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const router = Router();

/**
 * The same shape the intake form uses, and for the same reason.
 *
 * A hundred an hour is far more than a client reading their report needs, and far less than
 * guessing a 32-byte token is worth.
 */
const shareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

/* -------------------------------------------------------------------------- */
/* What the client can reach                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  '/:token',
  shareLimiter,
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');

    const settings = await Settings.getSettings();
    await noteView(link);
    /*
     * Two kinds, two whitelists, chosen here and nowhere else. A status link asks a different
     * question of the same engagement and is trusted with a different answer — see the two
     * functions in `share.service.js`, which is where what may be seen is actually decided.
     */
    const body = link.kind === 'status'
      ? statusView(link)
      : clientView(link, settings.report?.public?.cvssColors ?? {});
    res.json({
      ...body,
      /* So the page can say whose report it is without the client asking. */
      firm: settings.branding?.appName ?? '',
    });
  })
);

router.post(
  '/:token/findings/:findingId',
  shareLimiter,
  validate(
    z.object({
      fixed: z.boolean(),
      /**
       * What they did about it, in their words.
       *
       * Optional, and capped here as well as in the schema: the body is parsed before anything
       * else looks at it, and a megabyte of prose over an open endpoint is a cost paid before any
       * of the checks below run.
       */
      note: z.string().max(2000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    /*
     * Said before the read-only check and separately from it. `allowUpdates` is a choice somebody
     * made about a findings link; a status link has no findings on it at all, and answering "this
     * link is read-only" would imply there is something here it could have written to.
     */
    if (link.kind === 'status') throw forbidden('This link shows progress only.');
    if (!link.allowUpdates) throw forbidden('This link is read-only.');

    /* Reloaded as a document: `readShareLink` populates a projection, and this one is saved. */
    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    if (audit.state === 'APPROVED') {
      throw forbidden('This report is closed. Tell your contact and they will reopen it.');
    }

    const { finding, from, to, noted } = applyClientStatus(
      audit,
      req.params.findingId,
      req.body.fixed,
      link.label,
      req.body.note ?? ''
    );

    /*
       * A note with no change of status is still worth saving and saying.
       *
       * The commonest sequence is a client ticking the box, then coming back to explain what they
       * changed. Recording the second half without a line in the log would leave the team with a
       * sentence nobody was told about.
       */
    if (from === to && noted) {
      await audit.save();
      await recordActivity({
        audit,
        actor: null,
        action: ACTIONS.CLIENT_UPDATED_FINDING,
        target: finding.identifier || finding.title,
        meta: { from, to, link: link.label || 'a shared link', note: true },
        summary: `The client${link.label ? ` (${link.label})` : ''} said what they did about ${
          finding.identifier || finding.title
        }`,
      });
    }

    if (from !== to) {
      await audit.save();
      /*
       * On the log with no actor, and a summary written here rather than built from one.
       * Everything else in the log was done by somebody with an account; this was not, and a
       * line that implied otherwise would be the most misleading kind of record.
       */
      await recordActivity({
        audit,
        actor: null,
        action: ACTIONS.CLIENT_UPDATED_FINDING,
        target: finding.identifier || finding.title,
        meta: { from, to, link: link.label || 'a shared link' },
        summary: `The client${link.label ? ` (${link.label})` : ''} marked ${
          finding.identifier || finding.title
        } as ${to === 'fixed' ? 'fixed' : 'still open'}`,
      });

      /*
       * And tell somebody.
       *
       * The log is where you look when you already know to look. A client acting on a report is
       * news — it is the thing the whole link exists to produce — and until now the team found out
       * by opening the engagement on the off-chance. Everyone on it is told, because "whose finding
       * was it" is not the question: a client fixing something is the engagement's business.
       *
       * No actor, deliberately. The bridge that turns these into email skips a notification you
       * caused yourself by comparing actors, and there is nobody here to compare — which is the
       * right outcome, because nobody on the team did this.
       */
      const team = [audit.creator, ...(audit.collaborators ?? [])]
        .map((person) => String(person?._id ?? person ?? ''))
        .filter(Boolean);
      const told = [...new Set(team)];
      if (told.length) {
        await Notification.insertMany(
          told.map((user) => ({
            user,
            type: 'client-updated-finding',
            actor: null,
            audit: audit._id,
            auditName: audit.name,
            findingId: finding._id,
            target: finding.identifier || finding.title,
            message: `${link.label || 'The client'} marked ${
              finding.identifier || finding.title
            } as ${to === 'fixed' ? 'fixed' : 'still open'}${
              noted ? ' and said what they did' : ''
            } — worth a look before the retest.`,
            /* Straight to the finding, not to a list of forty. */
            href: `/engagements/${audit._id}/findings/${finding._id}`,
          }))
        ).catch(() => {
          /* The client's change is recorded; failing to announce it must not undo that. */
        });
      }
    }

    const fresh = await readShareLink(req.params.token);
    res.json(clientView(fresh, (await Settings.getSettings()).report?.public?.cvssColors ?? {}));
  })
);

/**
 * Something the client wants to ask about a finding.
 *
 * The link has taken a status and a note for a while: the client can tell us what they *did*. What
 * it never took is a question — so a reader who wanted to know which of their three load balancers
 * a finding was about had to leave the page, find somebody's address, and send an email that
 * landed nowhere near the finding. The Questions tab has existed the whole time for exactly this
 * conversation, pointed the other way.
 *
 * Behind `allowUpdates`, the same switch as the claim. A question is a smaller write than a status
 * change, and it was tempting to give it its own permission — but a firm that hands somebody a
 * read-only link has said what it means, and a second switch would be more to explain and more to
 * get wrong than it is worth. Somebody who wants questions without claims can say so in the label.
 *
 * The question lands open and unprinted, which is what the model already does for any open
 * question: "they asked and nobody has replied" is a thing to chase rather than a caveat to
 * publish, until somebody decides otherwise.
 */
router.post(
  '/:token/findings/:findingId/question',
  shareLimiter,
  validate(
    z.object({
      /* Capped here as well as in the schema — the body is parsed before any of the checks run. */
      text: z.string().trim().min(3, 'Say a little more than that.').max(600),
    })
  ),
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    if (link.kind === 'status') throw forbidden('This link shows progress only.');
    if (!link.allowUpdates) throw forbidden('This link is read-only.');

    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    if (audit.state === 'APPROVED') {
      throw forbidden('This report is closed. Tell your contact and they will reopen it.');
    }

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('That finding is not on this report.');

    audit.questions.push({
      text: req.body.text,
      /*
       * The finding's id, so the page can hand the question back under the right heading and the
       * team can open the thing being asked about. `context` is documented as free text — "a
       * host, a finding, a screen" — and an id is the one form of it that can be followed.
       */
      context: String(finding._id),
      /* Which link, which is the only name anybody has for a reader with no account. */
      fromClient: link.label || 'the client',
      status: 'open',
      print: false,
      askedBy: null,
    });
    await audit.save();
    const asked = audit.questions.at(-1);

    /* No actor, like the claim: nobody with an account did this, and a log that implied one
       would be the most misleading kind of record. */
    await recordActivity({
      audit,
      actor: null,
      action: ACTIONS.CLIENT_ASKED_QUESTION,
      target: finding.identifier || finding.title,
      meta: { link: link.label || 'a shared link' },
      summary: `The client${link.label ? ` (${link.label})` : ''} asked about ${
        finding.identifier || finding.title
      }`,
    });

    const team = [audit.creator, ...(audit.collaborators ?? [])]
      .map((person) => String(person?._id ?? person ?? ''))
      .filter(Boolean);
    const told = [...new Set(team)];
    if (told.length) {
      await Notification.insertMany(
        told.map((user) => ({
          user,
          type: 'client-asked-question',
          actor: null,
          audit: audit._id,
          auditName: audit.name,
          findingId: finding._id,
          target: finding.identifier || finding.title,
          message: `${link.label || 'The client'} asked about ${
            finding.identifier || finding.title
          }: \u201c${req.body.text.slice(0, 120)}${req.body.text.length > 120 ? '\u2026' : ''}\u201d`,
          /* To the tab that holds the conversation, not to the finding — the answer is written
             there, and landing on the finding would leave somebody hunting for the box. */
          href: `/engagements/${audit._id}?tab=questions`,
        }))
      ).catch(() => {
        /* The question is recorded; failing to announce it must not undo that. */
      });
    }

    res.status(201).json({
      _id: String(asked._id),
      text: asked.text,
      askedAt: asked.createdAt ?? null,
      answer: '',
      answeredAt: null,
    });
  })
);

/**
 * A screenshot attached to a claim.
 *
 * The only route in this application that accepts a file from somebody with no account, which is
 * the whole reason it is written the way it is. Every limit below is deliberate and none of them is
 * generous:
 *
 *   1. **Somebody has to have allowed it.** `allowEvidence` is off by default and is a decision
 *      made per link, for one client, by somebody who knows who is on the other end.
 *   2. **Never on a restricted engagement.** Those demand a second factor to open in the app; an
 *      unauthenticated write into one is not a thing this should be able to do at all.
 *   3. **Images only, by content.** `saveMedia` sniffs the bytes and refuses anything whose
 *      magic numbers are not an image it knows. A shell script announced as a PNG is not evidence.
 *      Recordings are refused too: they are the one upload big enough to be worth abusing.
 *   4. **Five megabytes, six files per link.** A screenshot of a config change is under one. The
 *      count is per link rather than per request, so a forwarded token cannot be used as storage.
 *   5. **Ten an hour.** Reading is two hundred; this is the write, and it is not a thing anybody
 *      needs to do twice a minute.
 *   6. **Marked as theirs.** It goes into the evidence bin with `source: 'client'`, so nobody
 *      mistakes what the client sent for what the team captured, and nothing inserts it into a
 *      report on its own.
 */
const evidenceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attachments. Try again later.' },
});

/** In memory, and small: this is a screenshot of a settings page, not a recording. */
const CLIENT_EVIDENCE_BYTES = 5 * 1024 * 1024;
/** Per link, across every finding on it. */
const CLIENT_EVIDENCE_MAX = 6;

const clientUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CLIENT_EVIDENCE_BYTES, files: 1 },
}).single('file');

router.post(
  '/:token/findings/:findingId/evidence',
  evidenceLimiter,
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    if (link.kind === 'status') throw forbidden('This link shows progress only.');
    if (!link.allowUpdates) throw forbidden('This link is read-only.');
    if (!link.allowEvidence) throw forbidden('This link does not accept attachments.');

    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    /*
     * Said the same way the app says it, and checked here rather than trusted from the link: an
     * engagement can be marked restricted after a link was issued, and the answer has to follow the
     * engagement rather than the credential.
     */
    if (isRestricted(audit)) {
      throw forbidden('This engagement does not accept attachments through a link.');
    }
    if (audit.state === 'APPROVED') {
      throw forbidden('This report is closed. Tell your contact and they will reopen it.');
    }

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('That finding is not on this report');

    /* Counted across the engagement's claims, so the ceiling is on the link and not the request. */
    const already = (audit.findings ?? []).reduce(
      (total, row) => total + (row.clientClaim?.media?.length ?? 0),
      0
    );
    if (already >= CLIENT_EVIDENCE_MAX) {
      throw forbidden(
        `Thank you — that is as many attachments as this link takes (${CLIENT_EVIDENCE_MAX}). ` +
          'Anything else is best sent to your contact directly.'
      );
    }

    await new Promise((resolve, reject) => {
      clientUpload(req, res, (error) => (error ? reject(error) : resolve()));
    }).catch((error) => {
      /* multer's own message for an oversized file is unreadable; this one is not. */
      throw badRequest(
        error?.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than 5 MB. A screenshot of the change is usually enough.'
          : 'That upload could not be read.'
      );
    });

    if (!req.file) throw badRequest('No file was attached.');
    /*
     * Images, and nothing else. `saveMedia` sniffs the content and would refuse a video anyway on
     * a type it does not know, but a recording *is* a type it knows — so the refusal is here, where
     * the reason is "not over an open endpoint" rather than "not a format we recognise".
     */
    if (!String(req.file.mimetype ?? '').startsWith('image/')) {
      throw badRequest('Only an image can be attached here.');
    }

    const stored = await saveMedia({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      filename: req.file.originalname || 'client-evidence.png',
      /* No account, so no uploader. The label on the link is who this was, and it goes below. */
      uploader: null,
      audit: audit._id,
      source: 'client',
    });

    finding.clientClaim = {
      ...(finding.clientClaim?.toObject?.() ?? finding.clientClaim ?? {}),
      status: finding.clientClaim?.status || 'fixed',
      at: new Date(),
      by: String(link.label ?? '').slice(0, 160),
      media: [...(finding.clientClaim?.media ?? []), stored.id],
    };
    await audit.save();

    await recordActivity({
      audit,
      actor: null,
      action: ACTIONS.CLIENT_UPDATED_FINDING,
      target: finding.identifier || finding.title,
      meta: { link: link.label || 'a shared link', attachment: true },
      summary: `The client${link.label ? ` (${link.label})` : ''} attached a screenshot to ${
        finding.identifier || finding.title
      }`,
    });

    const team = [...new Set(
      [audit.creator, ...(audit.collaborators ?? [])]
        .map((person) => String(person?._id ?? person ?? ''))
        .filter(Boolean)
    )];
    if (team.length) {
      await Notification.insertMany(
        team.map((user) => ({
          user,
          type: 'client-updated-finding',
          actor: null,
          audit: audit._id,
          auditName: audit.name,
          findingId: finding._id,
          target: finding.identifier || finding.title,
          message: `${link.label || 'The client'} attached a screenshot to ${
            finding.identifier || finding.title
          } — it is in the evidence bin, marked as theirs.`,
          href: `/engagements/${audit._id}/findings/${finding._id}`,
        }))
      ).catch(() => {
        /* The attachment is stored and logged; failing to announce it must not undo that. */
      });
    }

    /* How many they have sent, so the page can stop offering when the ceiling is reached. */
    res.status(201).json({ attachments: already + 1, remaining: CLIENT_EVIDENCE_MAX - already - 1 });
  })
);

/* -------------------------------------------------------------------------- */
/* What the team can do about it                                               */
/* -------------------------------------------------------------------------- */

router.use(requireAuth);

/** Loads an engagement this person may open, or refuses without saying it exists. */
async function loadForShare(req) {
  const audit = await Audit.findOne({
    _id: req.params.auditId,
    ...visibleAuditFilter(req.user),
  }).select('name state deletedAt');
  if (!audit) throw notFound('Engagement not found');
  return audit;
}

const summary = (row, origin = '') => ({
  _id: row._id,
  label: row.label,
  kind: row.kind ?? 'findings',
  allowUpdates: row.allowUpdates,
  allowEvidence: Boolean(row.allowEvidence),
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt ?? null,
  views: row.views ?? 0,
  lastViewedAt: row.lastViewedAt ?? null,
  createdAt: row.createdAt,
  createdBy: row.createdBy ?? null,
  /** Live only when it is still good for something, so the UI never offers a dead link. */
  live: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
  origin,
});

router.get(
  '/link/:auditId',
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    const rows = await ShareLink.find({ audit: audit._id })
      .populate({ path: 'createdBy', select: 'username firstname lastname' })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ links: rows.map((row) => summary(row)) });
  })
);

/**
 * Issues one, and hands the URL back exactly once.
 *
 * Once, because only the hash is kept — the same contract as an invitation. Somebody who loses the
 * link makes another, and the old one can be revoked, which is a better outcome than a token this
 * app could hand out twice.
 */
router.post(
  '/link/:auditId',
  validate(
    z.object({
      label: z.string().trim().max(160).optional().default(''),
      days: z.number().int().min(1).max(MAX_DAYS).optional().default(DEFAULT_DAYS),
      allowUpdates: z.boolean().optional().default(true),
      /** Off unless asked for, per link. See the note on the upload route. */
      allowEvidence: z.boolean().optional().default(false),
      /** Which question it answers: what was found, or how far along we are. */
      kind: z.enum(['findings', 'status']).optional().default('findings'),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const { link, token } = await issueShareLink({ audit, ...req.body, actor: req.user });
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SHARE_LINK_CREATED,
      target: req.body.label || 'the client',
      meta: {
        days: req.body.days,
        kind: req.body.kind,
        /* A status link is read-only whatever was asked for, so the log says what was made. */
        readOnly: req.body.kind === 'status' || !req.body.allowUpdates,
      },
    });

    res.status(201).json({
      ...summary(link),
      /** The only time this is ever returned. */
      token,
      path: `/shared/${token}`,
    });
  })
);

router.post(
  '/link/:auditId/:linkId/revoke',
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await ShareLink.findOne({ _id: req.params.linkId, audit: audit._id });
    if (!row) throw notFound('That link is not on this engagement');
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      row.revokedBy = req.user._id;
      await row.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.SHARE_LINK_REVOKED,
        target: row.label || 'a shared link',
      });
    }
    res.json(summary(row));
  })
);

export default router;
