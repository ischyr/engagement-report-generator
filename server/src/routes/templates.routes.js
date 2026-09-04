import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';

import env from '../config/env.js';
import { Template, PROPOSAL_DOC_TYPES } from '../models/template.model.js';
import { AuditType } from '../models/taxonomy.model.js';
import { Audit } from '../models/audit.model.js';
import { Settings } from '../models/settings.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, conflict, notFound, unprocessable } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireWrite } from '../middleware/auth.js';
import { uploadTemplate } from '../middleware/upload.js';
import { contentDisposition } from '../utils/content-disposition.js';
import { extractTemplateTags } from '../services/report.service.js';

import { lintTemplateTags, testRenderTemplate } from '../services/template-test.service.js';
import { outlineTemplate } from '../services/template-outline.service.js';
import { extractHtmlTags } from '../services/html-report.service.js';
import { STARTER_HTML_TEMPLATE } from '../services/html-template-starter.js';
import { TAG_REFERENCE, knownTagRoots } from '../services/tag-reference.js';
import { log } from '../utils/logger.js';

/**
 * The tag analysis for a template that is being written, or null if it could not run.
 *
 * Never allowed to fail the write. A template is a file somebody spent an afternoon on; refusing
 * to store it because the analyser tripped over something would lose the afternoon, and the
 * analysis is a warning, not a gate.
 */
async function lintOf({ buffer, html, user }) {
  try {
    const settings = await Settings.getSettings();
    return lintTemplateTags({ buffer, html, settings, user });
  } catch (error) {
    log.warn(`Template tag analysis skipped: ${error.message}`);
    return null;
  }
}

const router = Router();

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Deletes an orphaned upload; failure here must not mask the real error. */
async function discard(filename) {
  if (!filename) return;
  try {
    await fs.unlink(path.join(env.storage.templates, filename));
  } catch (err) {
    log.warn(`Could not remove orphaned upload ${filename}: ${err.message}`);
  }
}

/** The full tag catalogue, for the in-app reference panel. */
router.get('/tag-reference', (_req, res) => {
  res.json(TAG_REFERENCE);
});

/** The markup a new HTML template starts from. */
router.get('/starter-html', (_req, res) => {
  res.json({ html: STARTER_HTML_TEMPLATE });
});

const htmlTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(160),
  description: z.string().trim().max(1000).optional().default(''),
  html: z.string().min(1, 'The template cannot be empty').max(2_000_000),
});

/** Creates an HTML template. No upload — the body is edited in the app. */
router.post(
  '/html',
  requireWrite,
  validate(htmlTemplateSchema),
  asyncHandler(async (req, res) => {
    if (await Template.findOne({ name: req.body.name })) {
      throw conflict(`A template named "${req.body.name}" already exists`);
    }
    const detectedTags = extractHtmlTags(req.body.html);
    const lint = await lintOf({ html: req.body.html, user: req.user });
    const template = await Template.create({
      ...req.body,
      kind: 'html',
      ext: 'html',
      detectedTags,
      ...(lint ? { lint } : {}),
      size: Buffer.byteLength(req.body.html, 'utf8'),
      uploadedBy: req.user._id,
    });
    res.status(201).json({
      ...template.toObject(),
      unknownTags: detectedTags.filter((tag) => !knownTagRoots().has(tagRoot(tag))),
    });
  })
);

/** Saves edits to an HTML template's markup. */
router.put(
  '/:id/html',
  requireWrite,
  validate(htmlTemplateSchema.partial()),
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');
    if (template.kind !== 'html') throw badRequest('That template is a Word document, not HTML.');

    if (req.body.name !== undefined) template.name = req.body.name;
    if (req.body.description !== undefined) template.description = req.body.description;
    if (req.body.html !== undefined) {
      template.html = req.body.html;
      template.detectedTags = extractHtmlTags(req.body.html);
      template.size = Buffer.byteLength(req.body.html, 'utf8');
      const relint = await lintOf({ html: req.body.html, user: req.user });
      if (relint) template.lint = relint;
    }
    await template.save();

    res.json({
      ...template.toObject(),
      unknownTags: template.detectedTags.filter((tag) => !knownTagRoots().has(tagRoot(tag))),
    });
  })
);

/**
 * Every template, or one purpose's worth.
 *
 * `?purpose=report` matters more than it looks: an engagement's template picker asks this
 * route, and without the filter it would offer the NDA as something to render a penetration
 * test report from. The Templates page itself passes nothing, because managing them means
 * seeing all of them.
 *
 * `report` is expressed as "not proposal paperwork" rather than as `purpose: 'report'`, and that
 * is not pedantry — it is a bug this route already had. A Mongoose default applies when a
 * document is *created*; it does nothing to rows already in the database. So every template
 * uploaded before this field existed has no `purpose` key at all, an exact match skipped them,
 * and somebody's only report template went missing from the picker and from the dashboard's
 * "no template uploaded yet" check. The boot backfill fills the field in; this makes the read
 * right regardless of whether it has run.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter =
      req.query.purpose === 'report'
        ? { purpose: { $ne: 'proposal' } }
        : req.query.purpose === 'proposal'
          ? { purpose: 'proposal' }
          : {};
    const templates = await Template.find(filter).sort({ name: 1 }).populate('uploadedBy', 'username');
    res.json(templates);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id).populate('uploadedBy', 'username');
    if (!template) throw notFound('Template not found');
    res.json(template);
  })
);

router.post(
  '/',
  requireWrite,
  uploadTemplate,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded — send it as multipart field "file"');

    const name = String(req.body.name ?? '').trim() || path.parse(req.file.originalname).name;
    const description = String(req.body.description ?? '').trim();

    try {
      if (await Template.findOne({ name })) {
        throw conflict(`A template named "${name}" already exists`);
      }

      const buffer = await fs.readFile(req.file.path);
      // Throws if the upload is not a real .docx.
      const detectedTags = extractTemplateTags(buffer);
      /*
       * Analysed at upload rather than the first time somebody asks.
       *
       * A misspelled tag renders as nothing at all — `{{ .titel }}` produces a gap, not an
       * error — so the moment to say so is while the person who wrote it is still looking at it.
       */
      const lint = await lintOf({ buffer, user: req.user });

      /*
       * What this template is for, and which document it produces.
       *
       * Defaulted rather than required, so every existing caller — and every template already
       * uploaded — stays a report template without being asked.
       */
      const purpose = req.body.purpose === 'proposal' ? 'proposal' : 'report';
      const docType =
        purpose === 'proposal' && PROPOSAL_DOC_TYPES.includes(req.body.docType)
          ? req.body.docType
          : '';

      const template = await Template.create({
        name,
        description,
        purpose,
        docType,
        ext: 'docx',
        filename: req.file.filename,
        detectedTags,
        ...(lint ? { lint } : {}),
        size: req.file.size,
        uploadedBy: req.user._id,
      });

      res.status(201).json({
        ...template.toObject(),
        /** The old flat check, kept for callers that read it: root names only. */
        unknownTags: detectedTags.filter((tag) => !knownTagRoots().has(tagRoot(tag))),
      });
    } catch (err) {
      await discard(req.file.filename);
      throw err;
    }
  })
);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  /** Re-labelling a template after upload, rather than deleting and re-uploading it. */
  purpose: z.enum(['report', 'proposal']).optional(),
  docType: z.enum(['', ...PROPOSAL_DOC_TYPES]).optional(),
  /** The template this one takes its look from, or null to stand alone. See the model. */
  inherits: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Not a template id')
    .nullable()
    .optional(),
  inheritParts: z
    .object({
      styles: z.boolean().optional(),
      numbering: z.boolean().optional(),
      theme: z.boolean().optional(),
      page: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Whether making `child` inherit from `baseId` would produce a loop.
 *
 * Walked rather than assumed: A → B is fine, and A → B → A is a render that recurses until the
 * process gives up. Bounded as well as cycle-checked, because a chain long enough to be a mistake is
 * a mistake even when it terminates — five documents deep means nobody can say what a template looks
 * like without opening five others.
 */
async function inheritanceProblem(child, baseId) {
  if (!baseId) return null;
  if (String(baseId) === String(child._id)) return 'A template cannot inherit from itself.';

  let at = await Template.findById(baseId).select('name kind inherits filename');
  const chain = [];
  while (at) {
    if (String(at._id) === String(child._id)) {
      return `That would make a loop: ${[child.name, ...chain.map((t) => t.name)].join(' → ')} → ${child.name}.`;
    }
    if (at.kind && at.kind !== 'docx') {
      return `"${at.name}" is not a Word template, so there is nothing to inherit from it.`;
    }
    if (!at.filename) return `"${at.name}" has no uploaded file to take anything from.`;
    chain.push(at);
    if (chain.length > 3) return 'That is too many templates deep. Keep a base and its children.';
    at = at.inherits ? await Template.findById(at.inherits).select('name kind inherits filename') : null;
  }
  return null;
}

router.put(
  '/:id',
  requireWrite,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');

    if (req.body.inherits !== undefined) {
      if (req.body.inherits && template.kind === 'html') {
        throw badRequest(
          'An HTML template shares markup with {{> a partial }} instead. Inheriting parts is for Word templates.'
        );
      }
      const problem = await inheritanceProblem(template, req.body.inherits);
      if (problem) throw badRequest(problem);
    }

    const { inheritParts, ...rest } = req.body;
    Object.assign(template, rest);
    /* Merged, so a form that sends only one flag does not clear the other three. */
    if (inheritParts) Object.assign(template.inheritParts, inheritParts);
    await template.save();
    res.json(template);
  })
);

/** Replaces the document while keeping the same template id and references. */
router.put(
  '/:id/file',
  requireWrite,
  uploadTemplate,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded — send it as multipart field "file"');
    const template = await Template.findById(req.params.id);
    if (!template) {
      await discard(req.file.filename);
      throw notFound('Template not found');
    }

    try {
      const buffer = await fs.readFile(req.file.path);
      template.detectedTags = extractTemplateTags(buffer);
      // Re-analysed, because replacing the file is exactly when a tag gets misspelled.
      const lint = await lintOf({ buffer, user: req.user });
      if (lint) template.lint = lint;
    } catch (err) {
      await discard(req.file.filename);
      throw err;
    }

    const previous = template.filename;
    template.filename = req.file.filename;
    template.size = req.file.size;
    await template.save();
    await discard(previous);

    res.json(template);
  })
);

/**
 * Renders the template against the sample engagement and reports what happened.
 *
 * The point of the whole app is that the report's look lives in *your* document, and the
 * only way to find out whether it worked was to attach it to a real engagement,
 * generate, and open Word. A misspelled tag does not raise an error — it leaves a gap —
 * so the loop was slow and the failure was quiet.
 */
router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');

    const settings = await Settings.getSettings();
    const result = await testRenderTemplate({ template, settings, user: req.user });

    res.json({
      ok: result.ok,
      error: result.error ?? '',
      problems: result.problems ?? [],
      size: result.size ?? 0,
      ...result.analysis,
      /** So the client can offer the file without rendering it twice by accident. */
      downloadable: result.ok && template.kind === 'docx',
    });
  })
);

/**
 * Everything the playground needs, in one request.
 *
 * The same test render as `/test` — so the verdicts are the ones a render actually produces, not a
 * second opinion — plus the template walked in reading order, so the page can show each tag where
 * it sits instead of as a name in a list. One request rather than two because they have to agree:
 * the outline looks each tag's verdict up by scope and name, and two calls against a file somebody
 * is in the middle of replacing would disagree.
 */
router.get(
  '/:id/playground',
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');

    const settings = await Settings.getSettings();
    const result = await testRenderTemplate({ template, settings, user: req.user });

    let outline = { kind: template.kind, parts: [] };
    let outlineError = '';
    try {
      outline = await outlineTemplate({ template, tags: result.analysis?.tags ?? [] });
    } catch (error) {
      // A missing or corrupt file is the render's story to tell; the outline just has nothing
      // to show, and saying so beats a 500 on a page whose whole job is diagnosing templates.
      outlineError = error.message || 'The document could not be read';
    }

    res.json({
      template: {
        id: template._id,
        name: template.name,
        kind: template.kind,
        purpose: template.purpose ?? '',
        size: template.size ?? 0,
        updatedAt: template.updatedAt,
      },
      render: {
        ok: result.ok,
        error: result.error ?? '',
        problems: result.problems ?? [],
        size: result.size ?? 0,
        downloadable: result.ok && template.kind === 'docx',
      },
      counts: result.analysis?.counts ?? { total: 0, ok: 0, empty: 0, unknown: 0 },
      tags: result.analysis?.tags ?? [],
      outline,
      outlineError,
    });
  })
);

/** The same render, as a file — for opening in Word and looking at it. */
router.get(
  '/:id/test-render',
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');
    if (template.kind !== 'docx') {
      throw badRequest('HTML templates have a live preview — use that instead.');
    }

    const settings = await Settings.getSettings();
    const result = await testRenderTemplate({ template, settings, user: req.user });
    if (!result.ok) {
      // The JSON route explains it properly; this one only has a file to offer.
      throw unprocessable(result.error, result.problems);
    }

    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`Sample report — ${template.name}.docx`)
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(result.buffer);
  })
);

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');

    if (template.kind !== 'docx') {
      throw badRequest('That is an HTML template — open it in the editor instead.');
    }

    const filePath = path.join(env.storage.templates, template.filename);
    try {
      await fs.access(filePath);
    } catch {
      throw notFound('Template file is missing from storage');
    }

    res.setHeader('Content-Type', DOCX_MIME);
    // Was stripped to word characters, which turned an accented template name into
    // underscores. The RFC 6266 form keeps the real name and still degrades safely.
    res.setHeader('Content-Disposition', contentDisposition(`${template.name}.docx`));
    res.sendFile(filePath);
  })
);

router.delete(
  '/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const template = await Template.findById(req.params.id);
    if (!template) throw notFound('Template not found');

    // Refuse to break audits or audit types that point at this template.
    const [auditCount, typeCount] = await Promise.all([
      Audit.countDocuments({ template: template._id }),
      AuditType.countDocuments({ 'templates.template': template._id }),
    ]);
    if (auditCount > 0 || typeCount > 0) {
      throw conflict(
        `Still in use by ${auditCount} audit(s) and ${typeCount} audit type(s). Reassign them first.`
      );
    }

    await template.deleteOne();
    // Only docx templates own a file on disk.
    if (template.kind === 'docx') await discard(template.filename);
    res.json({ ok: true, id: req.params.id });
  })
);

function tagRoot(tag) {
  return String(tag)
    .replace(/^[#/^@]/, '')
    .replace(/^\.+/, '')
    .trim()
    .split(/[.|\s([]/)[0];
}

export default router;
