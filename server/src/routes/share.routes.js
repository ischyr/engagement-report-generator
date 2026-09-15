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
import { Company } from '../models/company.model.js';
import { recordActivity } from '../services/activity.service.js';
import env from '../config/env.js';
import { looksLikeAddress, mailConfig, sendMail } from '../services/mail/index.js';
import { shareLinkEmail } from '../services/mail/templates.js';
import {
  applyClientStatus,
  clientView,
  DEFAULT_DAYS,
  issueShareLink,
  MAX_DAYS,
  noteView,
  portfolioView,
  readShareLink,
  statusView,
} from '../services/share.service.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { isRestricted } from '../services/classification.service.js';
import { saveMedia } from '../services/media.service.js';
import { visibleAuditFilter, visibleClientFilter } from '../utils/audit-scope.js';

const router = Router();

/**
 * What to tell somebody whose link cannot do the thing they asked.
 *
 * Keyed by kind, because "this link shows progress only" is true of a status link and nonsense on
 * a client one — and a reader who is told the wrong reason concludes the page is broken rather
 * than that they have the wrong link.
 */
const SHOWS_ONLY = {
  status: 'This link shows progress only.',
  client: 'This link shows your engagements. Use the link for that engagement to change anything.',
};

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
    const colors = settings.report?.public?.cvssColors ?? {};
    /*
     * Three kinds, three whitelists, chosen here and nowhere else. Each answers a different
     * question of a different scope and is trusted with a different answer — the functions in
     * `share.service.js` are where what may be seen is actually decided.
     */
    const body =
      link.kind === 'status'
        ? statusView(link)
        : link.kind === 'client'
          ? portfolioView(link, colors)
          : clientView(link, colors);
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
    if (link.kind !== 'findings') throw forbidden(SHOWS_ONLY[link.kind] ?? 'This link is read-only.');
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
/**
 * Tells whoever is on the engagement that the client said something.
 *
 * Lifted out when the third caller appeared. Never throws: the question is recorded by the time
 * this runs, and failing to announce it must not undo that.
 */
async function tellTheTeam(audit, { type, message, findingId = null, target = '' }) {
  const team = [audit.creator, ...(audit.collaborators ?? [])]
    .map((person) => String(person?._id ?? person ?? ''))
    .filter(Boolean);
  const told = [...new Set(team)];
  if (!told.length) return;

  await Notification.insertMany(
    told.map((user) => ({
      user,
      type,
      actor: null,
      audit: audit._id,
      auditName: audit.name,
      findingId,
      target,
      message,
      /* To the tab that holds the conversation: the answer is written there. */
      href: `/engagements/${audit._id}?tab=questions`,
    }))
  ).catch(() => {});
}

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
    if (link.kind !== 'findings') throw forbidden(SHOWS_ONLY[link.kind] ?? 'This link is read-only.');
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

    await tellTheTeam(audit, {
      type: 'client-asked-question',
      findingId: finding._id,
      target: finding.identifier || finding.title,
      message: `${link.label || 'The client'} asked about ${
        finding.identifier || finding.title
      }: \u201c${req.body.text.slice(0, 120)}${req.body.text.length > 120 ? '\u2026' : ''}\u201d`,
    });

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
 * Telling the team something, without it being about one finding.
 *
 * The per-finding question above covers "what did you mean by number four". It does not cover the
 * thing a client is at least as likely to say — *we have a maintenance window on the 12th*, *the
 * host you tested is being decommissioned*, *who do we talk to about the retest* — and until now
 * the answer to all of those was to leave the page, find somebody's address, and send an email
 * that arrives nowhere near the engagement it is about. Which is the same sentence this file
 * already uses to justify the per-finding one.
 *
 * Same permission as that one, deliberately: `allowUpdates`. A read-only link is a statement that
 * this reader looks and does not touch, and a second switch would be more to explain than it is
 * worth.
 *
 * `context` is empty rather than an id, which is exactly what the question model documents it for:
 * free text naming what the question is about, and nothing is the honest value when it is about
 * the engagement rather than a part of it.
 */
router.post(
  '/:token/question',
  shareLimiter,
  validate(
    z.object({
      text: z.string().trim().min(3, 'Say a little more than that.').max(600),
    })
  ),
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    if (link.kind !== 'findings') throw forbidden(SHOWS_ONLY[link.kind] ?? 'This link is read-only.');
    if (!link.allowUpdates) throw forbidden('This link is read-only.');

    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    if (audit.state === 'APPROVED') {
      throw forbidden('This report is closed. Ask for it to be reopened and we will take a look.');
    }

    audit.questions.push({
      text: req.body.text,
      context: '',
      fromClient: link.label || 'the client',
      status: 'open',
      print: false,
      askedBy: null,
    });
    await audit.save();
    const asked = audit.questions.at(-1);

    await recordActivity({
      audit,
      actor: null,
      action: ACTIONS.CLIENT_ASKED_QUESTION,
      target: '',
      meta: { link: link.label || 'a shared link' },
      summary: `The client${link.label ? ` (${link.label})` : ''} asked a question about the engagement`,
    });

    await tellTheTeam(audit, {
      type: 'client-asked-question',
      message: `${link.label || 'The client'} asked: \u201c${req.body.text.slice(0, 120)}${
        req.body.text.length > 120 ? '\u2026' : ''
      }\u201d`,
    });

    res.status(201).json({ _id: String(asked._id), text: asked.text, createdAt: asked.createdAt });
  })
);

/**
 * Asking for a closed report to be opened again.
 *
 * The one route here that works *because* the report is closed. Every other write refuses an
 * approved engagement with "tell your contact and they will reopen it" — which sends the client
 * out of the app to find a human, at the exact moment they have discovered they need something.
 * Three places said that sentence and none of them offered a way to do it.
 *
 * It does not reopen anything. Reopening an approved report is a decision with a signature behind
 * it and it stays with the team; this is the request, recorded where the team already looks, with
 * a notification so it is not found a fortnight later. A client who asks twice gets one entry —
 * there is no value in a queue of identical pleas, and a "you have already asked" is a better
 * answer than silence.
 *
 * Deliberately *not* behind `allowUpdates`. A read-only link means this reader may not change the
 * report; asking a person for something is not changing the report, and a reader who cannot even
 * ask is a reader who will phone somebody instead.
 */
router.post(
  '/:token/reopen',
  shareLimiter,
  validate(
    z.object({
      reason: z.string().trim().max(600).optional().default(''),
    })
  ),
  asyncHandler(async (req, res) => {
    const link = await readShareLink(req.params.token);
    if (!link) throw notFound('That link is not valid any more.');
    if (link.kind !== 'findings') throw forbidden(SHOWS_ONLY[link.kind] ?? 'This link is read-only.');

    const audit = await Audit.findById(link.audit._id);
    if (!audit || audit.deletedAt) throw notFound('That link is not valid any more.');
    if (audit.state !== 'APPROVED') {
      /* Not an error: the client wants to say something and the report is already open. */
      return res.json({ ok: true, alreadyOpen: true });
    }

    const asking = `${link.label || 'The client'} has asked for this report to be reopened.${
      req.body.reason ? ` \u201c${req.body.reason}\u201d` : ''
    }`;

    /* One entry however many times they ask — the same request, not a queue of them. */
    const already = (audit.questions ?? []).find(
      (question) => question.context === 'reopen' && question.status === 'open'
    );
    if (already) {
      return res.json({ ok: true, alreadyAsked: true });
    }

    audit.questions.push({
      text: asking,
      /* Named rather than empty, so the team can see at a glance which kind of ask this is. */
      context: 'reopen',
      fromClient: link.label || 'the client',
      status: 'open',
      print: false,
      askedBy: null,
    });
    await audit.save();

    await recordActivity({
      audit,
      actor: null,
      action: ACTIONS.CLIENT_ASKED_QUESTION,
      target: 'reopening',
      meta: { link: link.label || 'a shared link' },
      summary: `The client${link.label ? ` (${link.label})` : ''} asked for the report to be reopened`,
    });

    await tellTheTeam(audit, { type: 'client-asked-question', message: asking });

    res.status(201).json({ ok: true });
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
    if (link.kind !== 'findings') throw forbidden(SHOWS_ONLY[link.kind] ?? 'This link is read-only.');
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
  /*
   * Who it was sent to, so the card can say so. Addresses and names only — the token is not here
   * and never was, and a link somebody pasted by hand has an empty list, which is honest rather
   * than a gap.
   */
  sentTo: (row.sentTo ?? []).map((entry) => ({
    name: entry.name ?? '',
    email: entry.email,
    at: entry.at,
  })),
  /** Whether this link chases, how often, and how many it has sent against the cap. */
  reminder: {
    everyDays: row.reminder?.everyDays ?? 0,
    lastAt: row.reminder?.lastAt ?? null,
    sent: row.reminder?.sent ?? 0,
  },
  createdAt: row.createdAt,
  createdBy: row.createdBy ?? null,
  /** Live only when it is still good for something, so the UI never offers a dead link. */
  live: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
  origin,
});

/**
 * Sends one freshly-issued link to the people named on the request.
 *
 * Never throws. A link that was issued is a link that exists, and losing it because a mail server
 * refused a connection would be the worst possible trade — so every failure comes back as a
 * description of what did not happen, and the URL is in the response either way.
 *
 * Addresses that are not addresses are dropped rather than refused, for the same reason: one
 * mistyped contact out of four should send the other three, and say which one it could not.
 */
async function sendLink({ req, audit, link, token }) {
  const wanted = req.body.recipients ?? [];
  if (!wanted.length) return { attempted: false, sent: [], refused: [], reason: '' };

  const settings = await Settings.getSettings();
  const config = await mailConfig(settings);
  if (!config.enabled) {
    return {
      attempted: true,
      sent: [],
      refused: wanted.map((person) => person.email),
      reason: `${config.reason ?? 'Email is not configured.'} The link is still yours to send by hand.`,
    };
  }

  const usable = wanted.filter((person) => looksLikeAddress(person.email));
  const unusable = wanted.filter((person) => !looksLikeAddress(person.email));
  if (!usable.length) {
    return { attempted: true, sent: [], refused: unusable.map((p) => p.email), reason: 'None of those looked like an email address.' };
  }

  const origin = (env.appUrl ?? '').replace(/\/$/, '');
  const body = shareLinkEmail({
    appName: settings.branding?.appName || 'Engy • Report Generation',
    engagement: audit.name,
    clientName: audit.company?.name ?? '',
    kind: link.kind,
    url: `${origin}/shared/${token}`,
    expiresAt: link.expiresAt,
    message: req.body.message,
    senderName: req.user.fullname || req.user.username,
    senderEmail: req.user.email ?? '',
  });

  const to = usable.map((person) => ({ name: person.name ?? '', email: person.email }));
  if (req.body.copyToMe && req.user.email) {
    to.push({ name: req.user.fullname || req.user.username, email: req.user.email });
  }

  let result;
  try {
    result = await sendMail(
      {
        to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        /* A client replying to this replies to a person, not to the instance. */
        replyTo: req.user.email
          ? { name: req.user.fullname || req.user.username, email: req.user.email }
          : undefined,
      },
      { settings, config }
    );
  } catch (error) {
    return { attempted: true, sent: [], refused: usable.map((p) => p.email), reason: String(error.message ?? error) };
  }

  if (!result.sent) {
    return { attempted: true, sent: [], refused: usable.map((p) => p.email), reason: result.reason ?? 'The mail server refused it.' };
  }

  const bounced = new Set((result.rejected ?? []).map((entry) => String(entry.address).toLowerCase()));
  const delivered = usable.filter((person) => !bounced.has(String(person.email).toLowerCase()));

  /*
   * Recorded on the link, which is what makes a reminder possible later and what lets the card
   * say "sent to three people on Tuesday" instead of nothing at all.
   */
  if (delivered.length) {
    link.sentTo.push(
      ...delivered.map((person) => ({
        name: person.name ?? '',
        email: person.email,
        client: person.client ?? null,
        at: new Date(),
        by: req.user._id,
      }))
    );
    await link.save();
  }

  return {
    attempted: true,
    sent: delivered.map((person) => ({ name: person.name ?? '', email: person.email })),
    refused: [...unusable.map((p) => p.email), ...[...bounced]],
    reason: '',
  };
}

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
      /*
       * Who to send it to, if anybody.
       *
       * Optional, and empty is the old behaviour exactly: the URL comes back once and somebody
       * sends it themselves. Given addresses, the link goes out from here — which is the only
       * moment it can, because what is stored is a hash and the token is returned once.
       */
      recipients: z
        .array(
          z.object({
            name: z.string().trim().max(160).optional().default(''),
            email: z.string().trim().max(200),
            /** Set when the address came off the contact list rather than being typed. */
            client: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
          })
        )
        .max(20)
        .optional()
        .default([]),
      /** The covering note, in the sender's words. Empty gets wording chosen by the kind. */
      message: z.string().max(4000).optional().default(''),
      copyToMe: z.boolean().optional().default(false),
      /*
       * Chase them about what is still open, this often.
       *
       * Zero is off and is the default, because this is the only thing the application sends to
       * somebody outside the firm without being asked at the time. It needs an address, so it
       * does nothing on a link nobody was sent from here — see `remediation-reminders`.
       */
      remindEveryDays: z.number().int().min(0).max(90).optional().default(0),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadForShare(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const { link, token } = await issueShareLink({ audit, ...req.body, actor: req.user });

    /*
     * Set after issuing rather than through `issueShareLink`: chasing is a property of this link
     * having been *sent*, and the send happens below. A link that fails to go out keeps the
     * setting and simply never becomes due, because nobody is recorded on it.
     */
    if (req.body.remindEveryDays) {
      link.reminder.everyDays = req.body.remindEveryDays;
      await link.save();
    }

    /*
     * And sent, if anybody was named.
     *
     * After the link exists and before the response, because this is the one moment the token is
     * in memory. A failure here must not lose the link — it has been issued, and the URL is in the
     * response whatever the mail server did — so the outcome is reported alongside it rather than
     * thrown. Somebody whose SMTP is down still gets a working link to paste, which is what they
     * had before this existed.
     */
    const sending = await sendLink({ req, audit, link, token });

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
        /* Who it went to, so the feed answers "was the client told" without asking anybody. */
        sentTo: sending.sent.map((person) => person.email),
      },
    });

    res.status(201).json({
      ...summary(link),
      /** The only time this is ever returned. */
      token,
      path: `/shared/${token}`,
      /** What the mail did, said rather than assumed — see `sendLink`. */
      sending,
    });
  })
);

/**
 * A link to everything this app has done for one client.
 *
 * Its own route rather than a `kind` on the engagement one, because it is scoped to a different
 * thing and reached from a different page — and because the two have different consequences if
 * they leak. An engagement link forwarded to the wrong person exposes one job; this exposes a
 * client's whole history with the firm, so it is made somewhere a person has deliberately gone.
 *
 * Read-only by construction. `issueShareLink` refuses to set `allowUpdates` on this kind, and
 * every write route in this file resolves an engagement from the link — which one of these does
 * not have.
 *
 * Visibility is the creator's, checked here: somebody may only hand out a view of a client they
 * can see themselves. `visibleClientFilter` is the same clause the Clients page uses, so a
 * company nobody has shown this person is not one they can publish.
 */
router.post(
  '/link/company/:companyId',
  validate(
    z.object({
      label: z.string().trim().max(160).optional().default(''),
      days: z.number().int().min(1).max(MAX_DAYS).optional().default(DEFAULT_DAYS),
      recipients: z
        .array(
          z.object({
            name: z.string().trim().max(160).optional().default(''),
            email: z.string().trim().max(200),
            client: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
          })
        )
        .max(20)
        .optional()
        .default([]),
      message: z.string().max(4000).optional().default(''),
      copyToMe: z.boolean().optional().default(false),
    })
  ),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const company = await Company.findOne({
      $and: [{ _id: req.params.companyId }, await visibleClientFilter(req.user)],
    }).select('name');
    if (!company) throw notFound('Client not found');

    const { link, token } = await issueShareLink({
      company,
      kind: 'client',
      label: req.body.label,
      days: req.body.days,
      actor: req.user,
    });

    /*
     * Sent the same way an engagement link is, with the company standing in for the engagement in
     * the wording. No engagement to write an activity entry against, which is the one thing this
     * route cannot do that its neighbour can — the record is the link itself.
     */
    const sending = await sendLink({
      req,
      audit: { name: `${company.name} — everything we have done`, company },
      link,
      token,
    });

    res.status(201).json({
      _id: String(link._id),
      label: link.label,
      kind: link.kind,
      expiresAt: link.expiresAt,
      token,
      path: `/shared/${token}`,
      sending,
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
