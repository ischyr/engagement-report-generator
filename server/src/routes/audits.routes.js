import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import {
  Audit,
  AUDIT_STATES,
  ENGAGEMENT_KINDS,
  REMEDIATION_STATUSES,
  RECIPIENT_ROLES,
} from '../models/audit.model.js';
import { Template } from '../models/template.model.js';
import { AuditType, SectionDefinition } from '../models/taxonomy.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { Settings } from '../models/settings.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound, HttpError } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireRole, requireWrite } from '../middleware/auth.js';
import { buildReportData, generateReport } from '../services/report.service.js';
import { purgeAuditData } from '../services/trash.service.js';
import { renderHtmlReport, partialResolver } from '../services/html-report.service.js';
import { expandPartials } from '../services/template-inheritance.service.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_MEDIA_BYTES,
  inlineMediaInHtml,
  loadMediaMap,
  mediaIdsInAudit,
  repointMedia,
  saveMedia,
  stripImages,
} from '../services/media.service.js';
import multer from 'multer';
import { preflightAudit } from '../services/preflight.service.js';
import { buildFindingsSheet } from '../services/findings-sheet.service.js';
// The instance's own date pattern, so a delivery date in a report matches every other date.
import { formatDate } from '../services/template-parser.js';
import { resolveReportSettings } from '../services/report.service.js';
import { mergeHostsIntoScope, parseNmapXml } from '../services/scan-import.service.js';
import { findPreset, presetSummaries } from '../services/test-check-presets.js';
import {
  ACTIONS,
  clearApprovalsIfConfigured,
  notifyCheckAssigned,
  notifyMentions,
  notifyReviewRequested,
  recordActivity,
} from '../services/activity.service.js';
import { Activity } from '../models/activity.model.js';
import { Notification } from '../models/notification.model.js';
import { Booking } from '../models/booking.model.js';
import {
  CLASSIFICATIONS,
  assertMayOpen,
  assertMayPromoteToLibrary,
  resolveCredentialExpiry,
} from '../services/classification.service.js';
import { DeletedFinding } from '../models/deleted-finding.model.js';
import { RenderRecord } from '../models/render-record.model.js';
import { log } from '../utils/logger.js';
import { Credential } from '../models/credential.model.js';
import {
  assertVault,
  decryptSecret,
  encryptSecret,
  vaultEnabled,
  VAULT_DISABLED_MESSAGE,
} from '../services/vault.service.js';
import { assertFresh } from '../utils/concurrency.js';
import { freshApprovals, reportFingerprint } from '../utils/report-fingerprint.js';
import { findingHistoryFor, normaliseTitle } from '../services/finding-history.service.js';
import { effortFor } from '../services/effort.service.js';
import { Delivery, DELIVERY_CHANNELS } from '../models/delivery.model.js';
import { deliveriesFor } from '../services/deliveries.service.js';
import { scopeChangesFor } from '../services/scope-changes.service.js';
import { signaturesFor } from '../services/signatures.service.js';
import { Signature, MAX_SIGNATURE_BYTES } from '../models/signature.model.js';
import { ScopeChange, SCOPE_CHANGE_KINDS } from '../models/scope-change.model.js';
import {
  DetectionEvent,
  DETECTION_OUTCOMES,
  DETECTION_OUTCOME_LABELS,
  DETECTION_NOISE,
  DETECTION_NOISE_LABELS,
  detectionProblems,
} from '../models/detection-event.model.js';
import {
  describeLatency,
  detectionFor,
  detectionLatency,
  detectionSummary,
  responseLatency,
} from '../services/detection.service.js';
import { visibleAuditFilter, membershipExpired, today } from '../utils/audit-scope.js';
import { activityCalendar } from '../services/activity-calendar.service.js';
import { reviewReadiness } from '../services/review-availability.service.js';
import { hostBoard, hostDetail } from '../services/host-view.service.js';
import { engagementHealth } from '../services/engagement-health.service.js';
import { EngagementDocument, DOCUMENT_KINDS } from '../models/document.model.js';
import { PhishingTarget, outcomeOf } from '../models/phishing-target.model.js';
import { KitItem, KIT_KINDS, KIT_STATUSES } from '../models/kit-item.model.js';
import {
  KIT_SUGGESTIONS,
  kitSummary,
  tagClashes,
  whereIs,
} from '../services/kit.service.js';
import { campaignSummary, importResults, phishingFor } from '../services/phishing.service.js';
import {
  MAX_DOCUMENT_BYTES,
  deleteDocumentFile,
  openDocument,
  safeFilename,
  serveableType,
  storeDocument,
} from '../services/documents.service.js';
import { suggestReviewers } from '../services/reviewer-suggestions.service.js';
import { findingTimeline } from '../services/finding-timeline.service.js';
import { advanceDue } from '../services/recurrence-reminders.service.js';
import { contentDisposition } from '../utils/content-disposition.js';

import { uploadMemory, uploadDocument } from '../middleware/upload.js';
import { findingSeverity, calculateCvss, CVSS_DEFAULT_VECTOR } from '../services/cvss.js';
import { User } from '../models/user.model.js';
import {
  assertUnlocked,
  describeLock,
  releaseLock,
  takeLock,
} from '../services/finding-lock.service.js';

const router = Router();

/**
 * Clients send the `updatedAt` they last saw so a stale write can be refused
 * rather than silently overwriting someone else's edit.
 */
const withVersion = (schema) =>
  schema.extend({ expectedUpdatedAt: z.string().datetime().optional() });

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** How many engagements one person may keep at the top of their list. */
const MAX_PINS = 8;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');
const nullableId = objectId.nullable().optional();

const customFieldValue = z.object({
  key: z.string(),
  label: z.string().optional().default(''),
  fieldType: z.string().optional().default('input'),
  value: z.any().optional().default(''),
});

const findingSchema = z.object({
  _id: objectId.optional(),
  // `identifier` is deliberately absent: the server allocates it, because it is
  // what the report prints as VULN-03 and a client-supplied value could collide
  // with an existing finding's or renumber one that has already been referenced.
  title: z.string().trim().min(1, 'Finding title is required').max(400),
  vulnType: z.string().trim().max(120).optional().default(''),
  description: z.string().optional().default(''),
  observation: z.string().optional().default(''),
  remediation: z.string().optional().default(''),
  remediationComplexity: z.number().int().min(1).max(3).nullable().optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  references: z.array(z.string().trim()).optional().default([]),
  cvssv3: z.string().trim().max(300).optional().default(CVSS_DEFAULT_VECTOR),
  scope: z.string().optional().default(''),
  poc: z.string().optional().default(''),
  status: z.number().int().optional().default(0),
  remediationStatus: z.enum(REMEDIATION_STATUSES).optional().default('open'),
  /**
   * A severity the team is standing behind, when it differs from the vector's.
   *
   * The reason is enforced by the route rather than the schema: it is only required when the
   * override actually changes something, and zod cannot see the computed severity to know.
   */
  severityOverride: z.enum(['', 'Critical', 'High', 'Medium', 'Low', 'None']).optional(),
  severityOverrideReason: z.string().trim().max(500).optional(),
  category: z.string().trim().max(120).optional().default(''),
  vulnerability: nullableId,
  customFields: z.array(customFieldValue).optional().default([]),
  sortIndex: z.number().int().optional().default(0),
});

const sectionSchema = z.object({
  _id: objectId.optional(),
  field: z.string().trim().min(1),
  name: z.string().trim().min(1),
  text: z.string().optional().default(''),
  customFields: z.array(customFieldValue).optional().default([]),
});

const scopeSchema = z.object({
  name: z.string().trim().max(200).optional().default(''),
  hosts: z
    .array(
      z.object({
        hostname: z.string().trim().max(255).optional().default(''),
        ip: z.string().trim().max(64).optional().default(''),
        os: z.string().trim().max(120).optional().default(''),
        /** Whether it was actually reached — see the host schema for why there are three. */
        status: z.enum(['pending', 'tested', 'excluded']).optional().default('pending'),
        statusNote: z.string().trim().max(300).optional().default(''),
        /** The operator's working notes. Never reaches a report; see the host schema. */
        notes: z.string().max(8000).optional().default(''),
        services: z
          .array(
            z.object({
              port: z.number().int().min(0).max(65535).optional(),
              protocol: z.string().trim().max(20).optional().default(''),
              name: z.string().trim().max(80).optional().default(''),
              product: z.string().trim().max(160).optional().default(''),
            })
          )
          .optional()
          .default([]),
      })
    )
    .optional()
    .default([]),
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'Engagement name is required').max(200),
  auditType: z.string().trim().max(120).optional().default(''),
  /** Which parts of the app this engagement has. See the audit schema. */
  kind: z.enum(ENGAGEMENT_KINDS).optional(),
  language: z.string().trim().min(2).max(10).optional().default('en'),
  reference: z.string().trim().max(80).optional().default(''),
  company: nullableId,
  client: nullableId,
  /** Everyone the report goes to. The primary is kept first, server-side. */
  recipients: z.array(objectId).optional(),
  /** What each of them is to this report; anybody left out is a technical contact. */
  recipientRoles: z
    .array(z.object({ client: objectId, role: z.enum(RECIPIENT_ROLES) }))
    .max(50)
    .optional(),
  template: nullableId,
  collaborators: z.array(objectId).optional().default([]),
  /** When somebody's access ends. Anybody left out is a permanent member. */
  memberUntil: z
    .array(z.object({ user: objectId, until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .max(50)
    .optional(),
  reviewers: z.array(objectId).optional().default([]),
  date: z.string().trim().max(40).optional().default(''),
  date_start: z.string().trim().max(40).optional().default(''),
  date_end: z.string().trim().max(40).optional().default(''),
});

const updateSchema = createSchema.partial().extend({
  /** Lower-cased and de-duplicated, so "PCI" and "pci" cannot both exist. */
  kind: z.enum(ENGAGEMENT_KINDS).optional(),
  tags: z
    .array(z.string().trim().toLowerCase().max(40))
    .max(20)
    .optional()
    .transform((tags) => (tags ? [...new Set(tags.filter(Boolean))] : tags)),
  scope: z.array(scopeSchema).optional(),
  sections: z.array(sectionSchema).optional(),
  customFields: z.array(customFieldValue).optional(),
  sortFindings: z.boolean().optional(),
  state: z.enum(AUDIT_STATES).optional(),
});

const POPULATE = [
  { path: 'findings.comments.author', select: 'username firstname lastname' },
  // The findings list shows who wrote each one, so these resolve to people.
  { path: 'findings.createdBy', select: 'username firstname lastname' },
  // Who holds a finding, so the editor can name them rather than saying "locked".
  { path: 'findings.lockedBy', select: 'username firstname lastname lastSeenAt' },
  { path: 'findings.updatedBy', select: 'username firstname lastname' },
  // Reports print who verified each check, so these must be resolved to people.
  { path: 'testChecks.createdBy', select: 'username firstname lastname' },
  { path: 'testChecks.doneBy', select: 'username firstname lastname' },
  /*
   * Who stopped work and who restarted it. On the shared list rather than resolved per route
   * because the banner is shown on every tab of an engagement, so this is wanted on every load
   * of one — and "Stopped by somebody" is not a record anybody can act on.
   */
  { path: 'holds.startedBy', select: 'username firstname lastname' },
  { path: 'holds.endedBy', select: 'username firstname lastname' },
  // And who marked it restricted, for the same reason: "marked by somebody" is not a record.
  { path: 'classifiedBy', select: 'username firstname lastname' },
  { path: 'company' },
  { path: 'client', populate: { path: 'company' } },
  { path: 'recipients', populate: { path: 'company' } },
  { path: 'recipientRoles.client', select: 'firstname lastname email title' },
  // `profile.certifications` rides along so a report can name who tested and what they
  // hold; nothing else from the profile is exposed to a template.
  { path: 'creator', select: 'username firstname lastname email phone title role profile.certifications' },
  { path: 'collaborators', select: 'username firstname lastname email phone title role profile.certifications' },
  { path: 'reviewers', select: 'username firstname lastname email phone title role profile.certifications' },
  { path: 'approvals.user', select: 'username firstname lastname email title' },
  { path: 'template' },
];

/** Loads an audit the caller is allowed to see, or throws. */
async function loadAudit(req, { populate = true, includeDeleted = false } = {}) {
  const query = Audit.findById(req.params.id);
  if (populate) query.populate(POPULATE);
  const audit = await query;
  if (!audit) throw notFound('Engagement not found');
  // A trashed engagement is invisible except to the routes that manage the trash.
  if (audit.deletedAt && !includeDeleted) throw notFound('Engagement is in the trash');

  /*
   * Above the admin short-circuit on purpose.
   *
   * An account that can read every engagement in the instance is exactly the one whose password
   * should not be enough on its own, so the two-factor requirement on restricted work applies to
   * admins first rather than last.
   */
  assertMayOpen(audit, req.user);

  if (req.user.role === 'admin') return audit;
  const uid = req.user._id.toString();
  const allowed = [
    audit.creator?._id?.toString() ?? audit.creator?.toString(),
    ...(audit.collaborators ?? []).map((c) => c._id?.toString() ?? c.toString()),
    ...(audit.reviewers ?? []).map((r) => r._id?.toString() ?? r.toString()),
  ];
  if (!allowed.includes(uid)) throw forbidden('You do not have access to this engagement');
  /*
   * Membership with an end date that has passed is not membership.
   *
   * Checked here as well as in the query clause because everything under `/audits/:id` is
   * loaded through this function — findings, sections, credentials, hours, deliveries. The
   * clause hides the engagement from lists; this closes the door on the engagement itself.
   */
  if (membershipExpired(audit, req.user)) {
    throw forbidden('Your access to this engagement ended. Ask whoever runs it to extend it.');
  }
  return audit;
}

/**
 * Every reference here can arrive populated or raw, depending on how the audit was
 * loaded, so identity comparisons all go through this.
 */
const idOf = (value) => String(value?._id ?? value ?? '');

/**
 * Keeps the primary contact and the recipient list consistent.
 *
 * One rule: the primary is always the first recipient. Templates read
 * `{{ .client.fullname }}` for the "prepared for" line and loop `recipients` for the
 * distribution list, and those two must never contradict each other — so whichever
 * the caller supplied, the other is derived rather than left stale.
 *
 * @param {object} target the audit (or a payload) to normalise in place
 */
function normaliseRecipients(target) {
  const listed = (target.recipients ?? []).map(idOf).filter(Boolean);
  const primary = idOf(target.client) || listed[0] || '';

  if (!primary) {
    target.recipients = [];
    target.recipientRoles = [];
    target.client = null;
    return;
  }

  // Primary first, no duplicates, order otherwise preserved.
  target.client = primary;
  target.recipients = [primary, ...listed.filter((id) => id !== primary)];

  /*
   * Roles follow the list rather than living alongside it: anything for a contact who is no
   * longer a recipient is dropped, and anybody without a role recorded is a technical
   * contact, which is what they were before roles existed.
   */
  const given = new Map(
    (target.recipientRoles ?? [])
      .map((entry) => [idOf(entry.client), RECIPIENT_ROLES.includes(entry.role) ? entry.role : 'technical'])
      .filter(([id]) => id)
  );
  target.recipientRoles = target.recipients.map((id) => ({
    client: id,
    role: given.get(String(id)) ?? 'technical',
  }));
}

/**
 * Keeps the access-expiry list describing people who are actually on the team.
 *
 * The same discipline as `normaliseRecipients()`: an entry for somebody who has been removed
 * is dropped, and the creator can never have one — an engagement whose owner is locked out of
 * it is not a state worth being able to reach.
 */
function normaliseMembership(target) {
  const members = new Set([
    ...(target.collaborators ?? []).map(idOf),
    ...(target.reviewers ?? []).map(idOf),
  ]);
  const creator = idOf(target.creator);

  const seen = new Set();
  target.memberUntil = (target.memberUntil ?? [])
    .map((entry) => ({ user: idOf(entry.user), until: entry.until }))
    .filter((entry) => {
      if (!entry.user || !entry.until) return false;
      if (entry.user === creator) return false;
      if (!members.has(entry.user)) return false;
      // One limit per person; the first wins, which is the one the form sent.
      if (seen.has(entry.user)) return false;
      seen.add(entry.user);
      return true;
    });
}

/** Whether this user created the engagement, tolerating populated or raw ids. */
const isCreator = (audit, user) => idOf(audit.creator) === String(user._id);

/** Set comparison, so re-sending an unchanged team does not read as a change. */
function sameMembers(current, next) {
  const before = new Set((current ?? []).map((entry) => String(entry?._id ?? entry)));
  const after = new Set((next ?? []).map((entry) => String(entry?._id ?? entry)));
  if (before.size !== after.size) return false;
  for (const id of before) if (!after.has(id)) return false;
  return true;
}

/**
 * The next finding identifier for an engagement.
 *
 * From the highest one in use, not from the count: with `length + 1`, deleting the
 * second of three findings made the next one identifier 3 as well, so two findings
 * shared a number — and that number is what the report prints as VULN-03.
 */
/**
 * One finding, in the shape `GET /audits/:id` returns it.
 *
 * The write routes used to answer with the raw subdocument, whose `lockedBy` and `createdBy` are
 * bare ids — so a page that put the response straight into its state would lose the names it had a
 * moment ago. Populating the same four paths the engagement read populates means a caller can patch
 * one finding into the copy it holds instead of refetching every finding, every section and every
 * note to pick up a title change. On a long engagement that is the difference between a save that
 * feels instant and one that reloads a megabyte.
 */
async function presentFinding(audit, findingId) {
  await audit.populate([
    { path: 'findings.createdBy', select: 'username firstname lastname' },
    { path: 'findings.updatedBy', select: 'username firstname lastname' },
    { path: 'findings.lockedBy', select: 'username firstname lastname lastSeenAt' },
    { path: 'findings.comments.author', select: 'username firstname lastname' },
  ]);
  return audit.findings.id(findingId);
}

async function nextIdentifier(audit) {
  const used = (audit.findings ?? [])
    .map((finding) => finding.identifier)
    .filter((value) => Number.isFinite(value));

  /*
   * Numbers held by restorable findings are not free either.
   *
   * Deleting the highest-numbered finding used to release its number to the next one written,
   * and restoring it then brought the original back carrying the same identifier — two
   * findings printed as VULN-04 in one report, and a delivery record hashing a document with
   * a duplicate reference in it. The trash is part of the engagement until it expires, so its
   * numbers stay reserved for as long as they can come back.
   */
  const trashed = await DeletedFinding.find({ audit: audit._id }).select('finding.identifier').lean();
  for (const row of trashed) {
    const value = row.finding?.identifier;
    if (Number.isFinite(value)) used.push(value);
  }

  return (used.length ? Math.max(...used) : 0) + 1;
}

/** APPROVED reports are frozen; only an admin can reopen them. */
/**
 * The user holding a finding's lock, or null.
 *
 * Loaded per check rather than populated, because the answer is needed on the save path and only
 * when a lock actually exists — which is the minority of saves. `lastSeenAt` is the field that
 * matters: it is what tells a live lock from one held by a laptop that closed.
 */
async function lockHolder(finding) {
  if (!finding?.lockedBy) return null;
  return User.findById(finding.lockedBy).select('username firstname lastname lastSeenAt role');
}

function assertEditable(audit, user) {
  if (audit.state === 'APPROVED' && user.role !== 'admin') {
    throw forbidden('This engagement is approved and locked. Ask an admin to reopen it.');
  }
  if (user.role === 'readonly') throw forbidden('Your account is read-only');
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                 */
/* -------------------------------------------------------------------------- */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const extra = {};
    if (req.query.state) extra.state = req.query.state;
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      extra.$and = [{ $or: [{ name: rx }, { reference: rx }, { auditType: rx }] }];
    }
    // One definition of "engagements you may see", shared with the inbox and insights.
    const filter = visibleAuditFilter(req.user, extra);

    // Pinned first, then most recently touched. Sorted here rather than in the browser so
    // the order is the same for any future caller, paginated or not.
    const pinned = new Set((req.user.pinnedAudits ?? []).map(idOf));

    /*
     * Exactly the fields the list draws, named rather than excluded.
     *
     * It used to ask for everything but sections and scope, which meant every finding's
     * description, observation and proof of concept — HTML with base64 screenshots in it —
     * crossed the wire to produce a severity chip and a count. The three finding fields below
     * are all the list needs, now that the evidence count is stored rather than derived.
     */
    /*
     * A tag filter, applied in the query rather than in the browser: the whole point of tags is
     * the cross-cutting question, and answering it by shipping every engagement and filtering
     * client-side would be the same page it already was.
     */
    /*
     * Archived engagements are out of the working list, and only that list.
     *
     * Not folded into `visibleAuditFilter`, deliberately: the register, the client's page and the
     * insights all want finished work included, and putting it in the shared filter would have
     * quietly rewritten the history those pages exist to show. `?archived=1` asks for them.
     */
    const wantArchived = req.query.archived === '1' || req.query.archived === 'true';
    filter.archivedAt = wantArchived ? { $ne: null } : null;

    const wantedTags = String(req.query.tags ?? '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (wantedTags.length) filter.tags = { $all: wantedTags };

    const audits = await Audit.find(filter)
      .select(
        'name reference auditType kind state language date date_start date_end company client tags ' +
          'creator collaborators reviewers template updatedAt createdAt deletedAt onHold holds ' +
          'archivedAt archivedBy ' +
          'findings.cvssv3 findings.severityOverride findings.evidenceCount ' +
          'findings.remediationStatus testChecks.done'
      )
      .populate([
        { path: 'company', select: 'name shortName' },
        { path: 'client', select: 'firstname lastname email' },
        { path: 'creator', select: 'username firstname lastname' },
        { path: 'collaborators', select: 'username firstname lastname' },
        { path: 'template', select: 'name' },
      ])
      .sort({ updatedAt: -1 });

    // Summarise findings so the list can show severity chips without the payload.
    const rows = audits.map((audit) => {
        const object = audit.toObject();
        // The severity the team stands behind, so the chips on the list match the report.
        const severities = (object.findings ?? []).map((f) => findingSeverity(f).severity);
        const count = (severity) => severities.filter((s) => s === severity).length;

        // Four plain facts that mean somebody should look at this. Shared with the dashboard,
        // because two places that each decided what "needs attention" meant would drift.
        const health = engagementHealth(object);

        delete object.findings;
        delete object.testChecks;
        return {
          ...object,
          pinned: pinned.has(String(object._id)),
          health,
          findingCount: severities.length,
          severityCounts: {
            critical: count('Critical'),
            high: count('High'),
            medium: count('Medium'),
            low: count('Low'),
            none: count('None'),
          },
        };
    });

    rows.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    res.json(rows);
  })
);

/**
 * Every tag in use, with how many engagements carry it.
 *
 * Declared before anything parameterised, or Express reads "tags" as an engagement id. Scoped
 * like every list: a tag only used on engagements you cannot see is not a tag you should be
 * offered, because the suggestion itself would say it exists.
 */
router.get(
  '/tags',
  asyncHandler(async (req, res) => {
    const rows = await Audit.aggregate([
      { $match: visibleAuditFilter(req.user) },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 200 },
    ]);
    res.json(rows.map((row) => ({ tag: row._id, count: row.count })));
  })
);

router.post(
  '/',
  requireWrite,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const payload = { ...req.body, creator: req.user._id };

    /*
     * The engagement type is a blueprint: sections, methodology, the usual
     * reviewers, the scope groups. Anything the caller supplied explicitly wins —
     * the blueprint fills blanks, it does not override choices.
     */
    const type = payload.auditType ? await AuditType.findOne({ name: payload.auditType }) : null;

    /*
     * The shape of work, when the type knows it and the caller did not say.
     *
     * Which is the common case: somebody picks "Phishing Campaign" from the type list and should
     * not then have to tell the app a second time what that means.
     */
    if (!payload.kind && type?.kind) payload.kind = type.kind;

    // Resolve the template from the audit type when the caller did not pick one.
    if (!payload.template && type) {
      const match =
        type.templates?.find((t) => t.locale === payload.language) ?? type.templates?.[0];
      if (match?.template) payload.template = match.template;
    }

    // Pre-fill the narrative sections configured for this audit type.
    const fields = type?.sections?.length ? type.sections : [];
    if (fields.length) {
      const definitions = await SectionDefinition.find({ field: { $in: fields } });
      payload.sections = definitions.map((d) => ({ field: d.field, name: d.name, text: '' }));
    }

    if (type?.scopeGroups?.length && !(payload.scope ?? []).length) {
      payload.scope = type.scopeGroups
        .filter(Boolean)
        .map((name) => ({ name, hosts: [] }));
    }

    if (type?.reviewers?.length && !(payload.reviewers ?? []).length) {
      // Never the creator: a reviewer who wrote the report is not a second pair of eyes.
      payload.reviewers = type.reviewers
        .map(String)
        .filter((id) => id !== req.user._id.toString());
    }

    // The creator is always a collaborator, so access checks stay simple.
    payload.collaborators = [
      ...new Set([
        ...(payload.collaborators ?? []).map(String),
        ...(type?.collaborators ?? []).map(String),
        req.user._id.toString(),
      ]),
    ];

    normaliseRecipients(payload);
    // Also at creation, not only on edit: an engagement born with an expiry against its own
    // creator, or against somebody who is not on the team, is a state worth not reaching.
    normaliseMembership(payload);

    const audit = await Audit.create(payload);
    await recordActivity({ audit, actor: req.user, action: ACTIONS.AUDIT_CREATED, target: audit.name });

    /*
     * Checklists last, and as a copy: the engagement owns its checks from here, so
     * later edits to the methodology never rewrite an engagement already underway.
     */
    const applied = [];
    for (const checklistId of type?.checklists ?? []) {
      const checklist = await findPreset(String(checklistId));
      if (!checklist) continue;

      const existing = new Set(
        audit.testChecks.map((c) => `${c.category ?? ''}|${c.title}`.toLowerCase())
      );
      let order = Math.max(0, ...audit.testChecks.map((c) => c.order ?? 0));

      for (const check of checklist.checks ?? []) {
        const key = `${check.category ?? ''}|${check.title}`.toLowerCase();
        if (existing.has(key)) continue;
        existing.add(key);
        order += 1;
        audit.testChecks.push({
          title: check.title,
          description: check.description ?? '',
          category: check.category ?? '',
          createdBy: req.user._id,
          order,
        });
      }
      applied.push(checklist.name);
    }

    if (applied.length) {
      await audit.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.CHECKS_ADDED,
        meta: { added: audit.testChecks.length, preset: applied.join(', ') },
      });
    }

    const populated = await Audit.findById(audit._id).populate(POPULATE);
    res.status(201).json(populated);
  })
);

/**
 * The catalogue of ready-made checklists.
 *
 * Must be declared before `/:id` — Express matches in order, and a literal path
 * placed after a parameterised one is swallowed by it.
 */
router.get(
  '/test-check-presets',
  asyncHandler(async (_req, res) => {
    // Reads the Checklist collection, so a team's own methodologies appear in the
    // picker beside the shipped ones. Manage them under Checklists.
    res.json(await presetSummaries());
  })
);

/** Engagements in the trash, with how long is left before they are purged. */
router.get(
  '/trash',
  asyncHandler(async (req, res) => {
    const visible =
      req.user.role === 'admin'
        ? {}
        : { $or: [{ creator: req.user._id }, { collaborators: req.user._id }] };

    const audits = await Audit.find({ deletedAt: { $ne: null }, ...visible })
      .select('name reference auditType deletedAt deletedBy company findings')
      .populate([
        { path: 'company', select: 'name' },
        { path: 'deletedBy', select: 'username firstname lastname' },
      ])
      .sort({ deletedAt: -1 });

    const settings = await Settings.getSettings();
    const retentionDays = settings.danger?.public?.nbdaydelete ?? 15;

    res.json({
      retentionDays,
      audits: audits.map((audit) => {
        const object = audit.toObject();
        const elapsed = (Date.now() - new Date(audit.deletedAt).getTime()) / 86_400_000;
        return {
          ...object,
          findingCount: object.findings?.length ?? 0,
          findings: undefined,
          // What the user actually wants to know: how long they have to change their mind.
          daysLeft: Math.max(0, Math.ceil(retentionDays - elapsed)),
        };
      }),
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Single engagement                                                          */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);
    /*
     * One count from a side collection, attached rather than fetched separately.
     *
     * The tab bar needs to know whether there is a mailing list, so that a kind-specific tab
     * stays visible on an engagement whose kind was changed after the fact — a list that vanished
     * because somebody flipped a dropdown would look exactly like data loss. A second round trip
     * on every engagement load to answer one number would be the wrong trade.
     */
    const phishingCount = await PhishingTarget.countDocuments({ audit: audit._id });
    res.json({ ...audit.toObject(), phishingCount });
  })
);

router.put(
  '/:id',
  validate(withVersion(updateSchema)),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    // `state` has its own endpoint so review rules are enforced in one place.
    const { state, expectedUpdatedAt, ...rest } = req.body;

    /*
     * Who is on the engagement is the creator's call, or an admin's. Anyone with
     * write access could previously add or remove colleagues — including removing
     * the people reviewing their own work.
     *
     * Checked against what is actually stored rather than on the field being
     * present: the details form posts the whole record every time, so rejecting a
     * mere mention of the team would stop a collaborator saving a date change.
     */
    const teamChanges = ['collaborators', 'reviewers'].filter(
      (field) => rest[field] !== undefined && !sameMembers(audit[field], rest[field])
    );
    if (teamChanges.length && !isCreator(audit, req.user) && req.user.role !== 'admin') {
      throw forbidden(
        `Only the engagement's creator or an admin can change who is on the team (${teamChanges.join(' and ')})`
      );
    }
    // Compared against the details marker rather than `updatedAt`: only a change
    // to these same fields should count as a conflict here.
    assertFresh({ updatedAt: audit.detailsUpdatedAt }, expectedUpdatedAt, {
      label: 'this engagement',
      current: audit,
    });

    const scopeChanged = rest.scope !== undefined;
    Object.assign(audit, rest);
    // Only when the caller touched either field — otherwise a details-only save
    // would rewrite the list from whatever happened to be populated on the document.
    if (rest.client !== undefined || rest.recipients !== undefined || rest.recipientRoles !== undefined) {
      normaliseRecipients(audit);
    }
    if (
      rest.collaborators !== undefined ||
      rest.reviewers !== undefined ||
      rest.memberUntil !== undefined
    ) {
      normaliseMembership(audit);
    }
    audit.detailsUpdatedAt = new Date();
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: scopeChanged ? ACTIONS.SCOPE_UPDATED : ACTIONS.AUDIT_UPDATED,
      fields: Object.keys(rest),
    });

    const populated = await Audit.findById(audit._id).populate(POPULATE);
    res.json(populated);
  })
);

/**
 * Moves an engagement to the trash.
 *
 * Not a real delete: an engagement is weeks of work, and a mis-click should be
 * recoverable. It is purged for good once the retention window in Settings has
 * passed — see `npm run purge-trash`.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role !== 'admin' && !audit.creator?.equals(req.user._id)) {
      throw forbidden('Only the creator or an admin can delete an engagement');
    }

    audit.deletedAt = new Date();
    audit.deletedBy = req.user._id;
    await audit.save();

    const settings = await Settings.getSettings();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.AUDIT_DELETED });

    res.json({
      ok: true,
      id: req.params.id,
      trashed: true,
      retentionDays: settings.danger?.public?.nbdaydelete ?? 15,
    });
  })
);

router.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false, includeDeleted: true });
    if (!audit.deletedAt) throw badRequest('That engagement is not in the trash.');
    if (req.user.role !== 'admin' && !audit.creator?.equals(req.user._id)) {
      throw forbidden('Only the creator or an admin can restore an engagement');
    }

    audit.deletedAt = null;
    audit.deletedBy = null;
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.AUDIT_RESTORED });

    res.json({ ok: true, id: req.params.id });
  })
);

/** Permanent, admin-only, and irreversible. */
router.delete(
  '/:id/purge',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false, includeDeleted: true });
    if (!audit.deletedAt) {
      throw badRequest('Move the engagement to the trash first.');
    }
    /*
     * Everything that lives in its own collection but belongs to this engagement.
     *
     * Only the activity log used to go, which left the client's encrypted credentials, the
     * delivery record and the sign-offs behind for ever — rows nothing can reach and nothing
     * will ever delete, after somebody chose the option called permanent. A purge that keeps
     * a borrowed password is the one failure this collection was built to avoid.
     */
    // The shared list, so this path and the scheduled sweep cannot drift apart again.
    await purgeAuditData([audit._id]);
    await audit.deleteOne();
    res.json({ ok: true, id: req.params.id, purged: true });
  })
);

/**
 * Pins an engagement to the top of your own list, or unpins it.
 *
 * A toggle rather than a pair of routes: there is one bit of state and no third option, and
 * a client that had to know the current value first would be a round trip that adds nothing.
 */
router.post(
  '/:id/pin',
  asyncHandler(async (req, res) => {
    // Loaded through the usual guard: pinning something you cannot see would leak that it
    // exists, and would put a dead id in your list.
    const audit = await loadAudit(req, { populate: false });

    const current = (req.user.pinnedAudits ?? []).map(idOf);
    const already = current.includes(String(audit._id));
    const next = already
      ? current.filter((id) => id !== String(audit._id))
      : [...current, String(audit._id)];

    /*
     * A cap, because a list where everything is pinned is the list you started with. Eight
     * is more than anybody runs at once and small enough that the top of the page stays
     * meaningful.
     */
    if (!already && next.length > MAX_PINS) {
      throw badRequest(
        `You can pin ${MAX_PINS} engagements. Unpin one first — a list where everything is pinned is just the list.`
      );
    }

    req.user.pinnedAudits = next;
    await req.user.save({ validateBeforeSave: false });
    res.json({ ok: true, pinned: !already, pins: next.length });
  })
);

/**
 * Which of this engagement's findings the client has been told about before.
 *
 * Its own endpoint rather than part of the engagement payload: it needs every other
 * engagement for the same company, and the findings list must not wait on that.
 */
router.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const history = await findingHistoryFor(audit, req.user);
    res.json({ byFinding: Object.fromEntries(history), repeats: history.size });
  })
);

/** The per-engagement audit trail, newest first. */
/**
 * The same log, counted by day.
 *
 * "What happened" the list already answers. "When was this actually worked on" it cannot: the
 * answer is spread over three hundred rows in reverse order, and the interesting part — the
 * fortnight in the middle where nothing moved — is invisible precisely because nothing is there.
 *
 * Declared before `/:id/activity` would matter if the paths could collide; they cannot, but it
 * lives here because it is the same data and the two should be read together.
 */
router.get(
  '/:id/activity/calendar',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false, includeDeleted: true });
    res.json(
      await activityCalendar({
        audit,
        days: Number(req.query.days) || 180,
        from: req.query.from,
        to: req.query.to,
      })
    );
  })
);

router.get(
  '/:id/activity',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false, includeDeleted: true });
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const before = req.query.before ? new Date(req.query.before) : null;

    const filter = { audit: audit._id };
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

    const entries = await Activity.find(filter)
      .populate('actor', 'username firstname lastname')
      .sort({ createdAt: -1 })
      .limit(limit + 1);

    res.json({
      entries: entries.slice(0, limit),
      hasMore: entries.length > limit,
    });
  })
);

/**
 * Who else could be asked, given what this engagement is about and who is free.
 *
 * A separate call from the readiness check on purpose: readiness is read on every render of the
 * sign-off card, and this one walks every enabled account's skills. It is wanted at the moment
 * somebody is deciding, which is a much rarer event.
 */
router.get(
  '/:id/reviewer-suggestions',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '') ? req.query.from : undefined;
    res.json(await suggestReviewers({ audit, from }));
  })
);

/**
 * Who could actually review this, over the next working week.
 *
 * A read, so the panel can show it and the button can ask before committing — the whole point is
 * to answer before the request goes out rather than after the silence.
 */
router.get(
  '/:id/review-readiness',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    /*
     * `from` moves the window — "what about the week of the 12th". Whether somebody's access has
     * already run out is deliberately not moved with it: that is a fact about today, and it is
     * why their notification was skipped a moment ago.
     */
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '') ? req.query.from : undefined;
    res.json(await reviewReadiness({ audit, from }));
  })
);

/**
 * Moves an engagement between in-progress, in review and approved.
 *
 * A move into review answers with `review`: who can actually look at it. The check is here as
 * well as in front of the button so that anything driving this route — a script, a future API
 * client — gets the same answer, and so a lead who pressed on regardless still has the sentence
 * in the toast rather than only in a dialog they dismissed.
 */
router.put(
  '/:id/state',
  validate(z.object({ state: z.enum(AUDIT_STATES) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const settings = await Settings.getSettings();
    const nextState = req.body.state;

    if (nextState === 'APPROVED') {
      const minReviewers = settings.reviews?.public?.minReviewers ?? 1;
      if (settings.reviews?.enabled && settings.reviews.public?.mandatoryReview) {
        // Only signatures that still cover the current text count. A quorum made of
        // sign-offs given before the report was rewritten is the exact thing a
        // mandatory review is supposed to prevent.
        const fresh = freshApprovals(audit).length;
        const stale = (audit.approvals ?? []).length - fresh;
        if (fresh < minReviewers) {
          throw badRequest(
            stale
              ? `This engagement needs ${minReviewers} approval(s), and ${stale} of the ${
                  stale + fresh
                } given no longer cover the report as it stands. Ask those reviewers again.`
              : `This engagement needs ${minReviewers} approval(s) before it can be marked approved.`
          );
        }
      }
    }
    if (audit.state === 'APPROVED' && nextState !== 'APPROVED' && req.user.role !== 'admin') {
      throw forbidden('Only an admin can reopen an approved engagement');
    }

    const previous = audit.state;
    audit.state = nextState;
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.STATE_CHANGED,
      meta: { from: previous, to: nextState },
    });
    // Reviewers should not have to notice for themselves.
    let review = null;
    if (nextState === 'REVIEW' && previous !== 'REVIEW') {
      const notified = await notifyReviewRequested({ audit, actor: req.user });
      /*
       * Read after the notification, not before: the answer describes what the request just ran
       * into, and it is the same object the dialog in front of the button showed — so a lead who
       * pressed on anyway sees the same sentence rather than a differently worded second opinion.
       */
      review = { ...(await reviewReadiness({ audit })), notified };
    }

    res.json({ ok: true, state: audit.state, ...(review ? { review } : {}) });
  })
);

/**
 * Signs the report off, or withdraws a signature.
 *
 * Being able to open an engagement is not authority to bless it. This used to accept
 * whoever called it, so the quorum `minReviewers` counts could be made up entirely
 * of the author's own signature — the gate looked like control and enforced nothing.
 *
 * Withdrawal is deliberately unguarded beyond identity: you must always be able to
 * take your name off something, whatever state it has reached since.
 */
router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const uid = req.user._id.toString();
    const already = (audit.approvals ?? []).some((a) => idOf(a.user) === uid);

    if (!already) {
      if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
      if (!(audit.reviewers ?? []).some((r) => idOf(r) === uid)) {
        // Including admins. An admin may add themselves as a reviewer and then sign
        // off — which is the point: the record shows they did both.
        throw forbidden(
          'Only a reviewer on this engagement can sign it off. The creator or an admin can add you as one.'
        );
      }
      if (idOf(audit.creator) === uid) {
        throw forbidden(
          'You created this engagement, so you cannot sign off your own report. It needs another reviewer.'
        );
      }
      if (audit.state === 'EDIT') {
        throw badRequest(
          'This engagement is still in progress. Move it to review before asking for sign-off.'
        );
      }
    }

    audit.approvals = already
      ? audit.approvals.filter((a) => idOf(a.user) !== uid)
      : [
          ...(audit.approvals ?? []),
          // Computed rather than read off the document: on an engagement saved
          // before fingerprints existed the field is still empty at this point, and
          // the pre-save hook is about to write exactly this value.
          { user: req.user._id, at: new Date(), fingerprint: reportFingerprint(audit) },
        ];
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: already ? ACTIONS.APPROVAL_WITHDRAWN : ACTIONS.APPROVED,
    });
    res.json({
      ok: true,
      approved: !already,
      approvals: audit.approvals.length,
      fresh: freshApprovals(audit).length,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

router.post(
  '/:id/findings',
  validate(findingSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const finding = {
      ...req.body,
      identifier: await nextIdentifier(audit),
      sortIndex: req.body.sortIndex ?? (audit.findings ?? []).length,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    };
    audit.findings.push(finding);
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.FINDING_CREATED, target: finding.title });
    /* The same shape a read returns, so the page can add it to what it holds. */
    res.status(201).json(await presentFinding(audit, audit.findings.at(-1)._id));
  })
);

/** Copies an entry from the shared library into the engagement. */
router.post(
  '/:id/findings/from-library',
  validate(z.object({ vulnerability: objectId, locale: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const vulnerability = await Vulnerability.findById(req.body.vulnerability);
    if (!vulnerability) throw notFound('Vulnerability not found in the library');

    const locale = req.body.locale ?? audit.language ?? 'en';
    const detail =
      vulnerability.details.find((d) => d.locale === locale) ?? vulnerability.details[0];
    if (!detail) throw badRequest('That library entry has no content to copy');

    audit.findings.push({
      title: detail.title || 'Untitled finding',
      vulnType: detail.vulnType ?? '',
      description: detail.description ?? '',
      observation: detail.observation ?? '',
      remediation: detail.remediation ?? '',
      references: detail.references ?? [],
      customFields: detail.customFields ?? [],
      cvssv3: vulnerability.cvssv3,
      priority: vulnerability.priority ?? null,
      remediationComplexity: vulnerability.remediationComplexity ?? null,
      category: vulnerability.category ?? '',
      vulnerability: vulnerability._id,
      identifier: await nextIdentifier(audit),
      sortIndex: (audit.findings ?? []).length,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_IMPORTED,
      target: detail.title,
    });
    res.status(201).json(audit.findings.at(-1));
  })
);

/**
 * One finding, rendered the way the report will render it.
 *
 * The loop it removes: write a finding, generate the whole report, open Word, find the finding,
 * discover the table has no header row or that eight screenshots in a row have pushed the
 * remediation onto its own page. That is four steps and a Word licence to answer a question about
 * one paragraph.
 *
 * The draft is posted rather than read from the database, because the version worth checking is the
 * one on screen — a preview of what was last saved answers a question nobody asked. Nothing is
 * written: the draft is substituted into the engagement in memory and the whole report data is
 * built from it, which is what makes this the real thing rather than an approximation. Figure
 * numbers, severity labels, the client's own date format and their renamed severities all come out
 * exactly as they will in the document.
 */
router.post(
  '/:id/findings/:findingId/preview',
  validate(findingSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);

    /*
     * `new` means a finding that has not been saved yet — quick-capture, or the first write-up of
     * the day. It is appended so the numbering matches where it will actually land.
     */
    const isNew = req.params.findingId === 'new';
    const target = isNew ? null : audit.findings.id(req.params.findingId);
    if (!isNew && !target) throw notFound('Finding not found');

    if (isNew) audit.findings.push(req.body);
    else target.set(req.body);

    const settings = await Settings.getSettings();
    const data = buildReportData(audit, settings, { parts: null, numbering: null }, {
      target: 'html',
      user: req.user,
      history: await findingHistoryFor(audit, req.user),
    });

    const wanted = isNew
      ? data.findings.at(-1)
      : data.findings.find((entry) => String(entry._id ?? entry.id) === req.params.findingId);
    if (!wanted) throw notFound('Finding not found');

    // Only what a preview shows. The finding object carries the whole engagement's worth of
    // derived fields, and sending all of it would make this the heaviest request on the page.
    res.json({
      finding: {
        positionId: wanted.positionId ?? '',
        number: wanted.number ?? null,
        title: wanted.title ?? '',
        severityLabel: wanted.severityLabel ?? '',
        severityColor: wanted.severityColor ?? '',
        cvssScore: wanted.cvssScore ?? '',
        cvssVector: wanted.cvssVector ?? '',
        cvssVersion: wanted.cvssVersion ?? '',
        category: wanted.category ?? '',
        vulnType: wanted.vulnType ?? '',
        priorityLabel: wanted.priorityLabel ?? '',
        remediationStatusLabel: wanted.remediationStatusLabel ?? '',
        remediationComplexityLabel: wanted.remediationComplexityLabel ?? '',
        references: wanted.references ?? [],
        previously: wanted.previously ?? '',
        rich: {
          description: wanted.rich?.description ?? '',
          scope: wanted.rich?.scope ?? '',
          poc: wanted.rich?.poc ?? '',
          observation: wanted.rich?.observation ?? '',
          remediation: wanted.rich?.remediation ?? '',
        },
      },
    });
  })
);

/**
 * Has anything changed? — the cheap question, asked on a timer.
 *
 * Two people on one engagement each hold a copy of it in a browser, and until now the only way to
 * see a colleague's work was to reload the page or leave and come back. Polling the engagement itself
 * would fix that and cost too much: the document carries every finding's HTML, its comments and its
 * evidence references, so a refetch every few seconds for every open tab is megabytes of the same
 * text over and over.
 *
 * So this returns a fingerprint instead — timestamps, counts and locks, no prose — and the client
 * refetches the real thing only when the fingerprint moves. A poll costs a projected read and a few
 * hundred bytes.
 *
 * It reports per-finding timestamps rather than one number for the whole engagement, because the
 * client needs to know *which* finding moved: the one somebody has open is the one worth telling them
 * about, and the rest can refresh silently underneath.
 */
router.get(
  '/:id/pulse',
  asyncHandler(async (req, res) => {
    /*
     * Projected rather than `loadAudit`, which reads the whole document — the point of this route is
     * to be cheap. The fields at the front are exactly what the access check needs; a pulse must not
     * be a way to learn that an engagement exists.
     */
    const audit = await Audit.findById(req.params.id)
      .select(
        'creator collaborators reviewers classification classifiedBy deletedAt state updatedAt ' +
          'findings._id findings.updatedAt findings.updatedBy findings.lockedBy findings.lockedAt ' +
          'notes._id notes.updatedAt sections._id sections.updatedAt testChecks._id testChecks.updatedAt'
      )
      .populate('findings.updatedBy', 'username firstname lastname')
      .populate('findings.lockedBy', 'username firstname lastname lastSeenAt');

    if (!audit) throw notFound('Engagement not found');
    if (audit.deletedAt) throw notFound('Engagement is in the trash');
    assertMayOpen(audit, req.user);
    if (req.user.role !== 'admin') {
      const uid = req.user._id.toString();
      const allowed = [
        audit.creator?._id?.toString() ?? audit.creator?.toString(),
        ...(audit.collaborators ?? []).map((c) => c._id?.toString() ?? c.toString()),
        ...(audit.reviewers ?? []).map((r) => r._id?.toString() ?? r.toString()),
      ];
      if (!allowed.includes(uid)) throw forbidden('You do not have access to this engagement');
    }

    const findings = (audit.findings ?? []).map((finding) => ({
      id: String(finding._id),
      updatedAt: finding.updatedAt,
      updatedBy: finding.updatedBy
        ? {
            id: String(finding.updatedBy._id ?? finding.updatedBy),
            fullname:
              [finding.updatedBy.firstname, finding.updatedBy.lastname].filter(Boolean).join(' ') ||
              finding.updatedBy.username,
          }
        : null,
      lockedBy: finding.lockedBy
        ? {
            id: String(finding.lockedBy._id ?? finding.lockedBy),
            fullname:
              [finding.lockedBy.firstname, finding.lockedBy.lastname].filter(Boolean).join(' ') ||
              finding.lockedBy.username,
          }
        : null,
      lockedAt: finding.lockedAt,
    }));

    const stamp = (list) =>
      (list ?? [])
        .map((row) => `${row._id}:${new Date(row.updatedAt ?? 0).getTime()}`)
        .join(',');

    /*
     * One string that changes whenever anything a colleague could have done changes. Compared rather
     * than parsed, so adding something to it later cannot break a client that only ever asks "is this
     * the same as last time".
     */
    const fingerprint = [
      new Date(audit.updatedAt ?? 0).getTime(),
      audit.state,
      stamp(audit.findings),
      stamp(audit.notes),
      stamp(audit.sections),
      stamp(audit.testChecks),
      findings.map((f) => `${f.id}:${f.lockedBy?.id ?? ''}`).join(','),
    ].join('|');

    res.json({
      at: audit.updatedAt,
      state: audit.state,
      counts: {
        findings: (audit.findings ?? []).length,
        notes: (audit.notes ?? []).length,
        sections: (audit.sections ?? []).length,
        checks: (audit.testChecks ?? []).length,
      },
      findings,
      fingerprint,
    });
  })
);

/**
 * Taking a finding for editing, and giving it back.
 *
 * Deliberately explicit rather than implicit-on-typing: a lock somebody did not ask for is a lock
 * they will not remember to release, and the failure mode of this feature is a report full of
 * findings nobody can edit because four people went home holding them. Pressing a button is the
 * thing that makes it theirs, and the button says so.
 */
router.post(
  '/:id/findings/:findingId/lock',
  validate(
    z.object({
      note: z.string().trim().max(200).optional().default(''),
      /** A lead taking a live lock off somebody else. Refused for anybody else. */
      force: z.boolean().optional().default(false),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');

    const holder = await lockHolder(finding);
    const wasHeldByOther = finding.lockedBy && String(finding.lockedBy) !== String(req.user._id);

    takeLock(finding, req.user, holder, { note: req.body.note, force: req.body.force });
    await audit.save();

    /*
     * Only a takeover is worth an activity entry. Somebody locking a finding they are about to edit
     * is the normal case and would drown the feed; taking one off a colleague is a thing the team
     * may need to reconstruct later.
     */
    if (wasHeldByOther) {
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.FINDING_UPDATED,
        target: finding.title,
        meta: { lockTakenFrom: holder?.username ?? String(finding.lockedBy ?? '') },
      });
    }

    res.json({ lock: describeLock(finding, await lockHolder(finding), req.user) });
  })
);

router.delete(
  '/:id/findings/:findingId/lock',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');

    releaseLock(finding, req.user, await lockHolder(finding));
    await audit.save();
    res.json({ lock: null });
  })
);

/** Every lock on this engagement, so a lead can see what is held and by whom. */
router.get(
  '/:id/locks',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const locked = (audit.findings ?? []).filter((finding) => finding.lockedBy);
    const holders = await User.find({ _id: { $in: locked.map((f) => f.lockedBy) } }).select(
      'username firstname lastname lastSeenAt'
    );
    const byId = new Map(holders.map((holder) => [String(holder._id), holder]));

    res.json({
      locks: locked.map((finding) => ({
        finding: String(finding._id),
        title: finding.title,
        ...describeLock(finding, byId.get(String(finding.lockedBy)), req.user),
      })),
    });
  })
);

router.put(
  '/:id/findings/:findingId',
  validate(withVersion(findingSchema.partial())),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');
    // Before the freshness check, because "somebody has taken this" is a different answer from
    // "somebody changed it while you were typing", and the more useful one.
    assertUnlocked(finding, req.user, await lockHolder(finding));

    const { expectedUpdatedAt, ...patch } = req.body;
    // Refuse the write rather than clobber a colleague's edit.
    assertFresh(finding, expectedUpdatedAt, {
      label: `the finding "${finding.title}"`,
      current: finding,
    });

    const changed = Object.keys(patch).filter(
      (key) => JSON.stringify(finding[key]) !== JSON.stringify(patch[key])
    );
    finding.set(patch);

    /*
     * An override has to say why.
     *
     * Enforced here rather than in the schema because it is only required when the override
     * actually changes something — moving a High to High needs no justification, and the schema
     * cannot see the computed severity to know the difference. An unexplained departure from the
     * score is exactly what a client disputes, so it is refused rather than stored blank.
     */
    if (patch.severityOverride !== undefined || patch.severityOverrideReason !== undefined) {
      const rated = findingSeverity(finding);
      if (rated.overridden && !String(finding.severityOverrideReason ?? '').trim()) {
        throw badRequest(
          `Say why this is ${rated.severity} rather than ${rated.cvssSeverity}. It prints beside the score.`
        );
      }
      if (changed.includes('severityOverride')) {
        finding.severityOverrideBy = rated.overridden ? req.user._id : null;
        finding.severityOverrideAt = rated.overridden ? new Date() : null;
      }
    }

    /*
     * A status move is appended to the finding's own history.
     *
     * The status was one value, so a finding could say it was fixed and nothing could say when,
     * by whom, or that it had been marked fixed once already and come back — which is exactly
     * what a retest argument turns on. Recorded on the finding rather than left to the activity
     * log, because the log is keyed by engagement and identifies a finding by its title, and a
     * title changes.
     */
    if (changed.includes('remediationStatus')) {
      finding.statusHistory.push({
        status: finding.remediationStatus,
        at: new Date(),
        by: req.user._id,
      });
    }

    // `createdBy` is deliberately not filled in here: on a finding written before
    // authorship was recorded, the first person to edit it is not its author, and
    // guessing would put someone else's name on their work.
    if (changed.length) finding.updatedBy = req.user._id;

    const settings = await Settings.getSettings();
    await clearApprovalsIfConfigured({
      audit,
      actor: req.user,
      settings,
      target: finding.title,
    });

    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_UPDATED,
      target: finding.title,
      fields: changed,
    });
    res.json(await presentFinding(audit, finding._id));
  })
);

/**
 * Folds one finding into another.
 *
 * Two people on one engagement write the same issue more often than anybody admits — one calls it
 * "IDOR on document download", the other "missing authorisation on /documents" — and it is usually
 * found while assembling the report, which is the worst moment and the one where somebody's hour of
 * writing gets deleted to tidy up.
 *
 * So: concatenate rather than choose. Each rich field becomes the survivor's text followed by the
 * other's, evidence and all, and the references are unioned. Nothing is summarised, nothing is
 * dropped, and the result reads like two people wrote it — which is true, and much easier to edit
 * down than it is to recover a paragraph nobody kept.
 *
 * The severity is the *higher* of the two. A merged finding covering both write-ups is at least as
 * bad as the worse of them, and under-rating it is the one outcome with a consequence outside this
 * app. The other finding then goes to the same trash a deletion uses, so a merge is reversible for
 * as long as a delete is.
 */
router.post(
  '/:id/findings/:findingId/merge',
  validate(
    z.object({
      /** The finding to fold in. It is the one that ends up in the trash. */
      from: objectId,
      /** Which title to keep. The other is appended to the survivor's description as a line. */
      title: z.enum(['keep', 'take']).optional().default('keep'),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const target = audit.findings.id(req.params.findingId);
    const source = audit.findings.id(req.body.from);
    if (!target || !source) throw notFound('Finding not found');
    if (String(target._id) === String(source._id)) {
      throw badRequest('A finding cannot be merged into itself');
    }
    // Both halves: one is rewritten, the other is removed, and either being held by somebody else
    // makes this the wrong moment.
    assertUnlocked(target, req.user, await lockHolder(target));
    assertUnlocked(source, req.user, await lockHolder(source));

    const RICH = ['description', 'observation', 'remediation', 'poc', 'scope'];
    const joined = {};
    for (const field of RICH) {
      const mine = (target[field] ?? '').trim();
      const theirs = (source[field] ?? '').trim();
      /*
       * A rule and a separator, not cleverness. The `<hr>` survives into Word and the HTML report as
       * a real horizontal rule, so whoever edits the merged finding can see exactly where the seam
       * is — and delete it once they have read both halves.
       */
      joined[field] = mine && theirs ? `${mine}<hr>${theirs}` : mine || theirs;
    }

    const wasTitle = target.title;
    const otherTitle = source.title;
    if (req.body.title === 'take') target.title = otherTitle;

    // Which write-up was called what is worth keeping: it is how somebody finds this later.
    const note = `<p><em>Merged from “${otherTitle}”.</em></p>`;
    joined.description = `${joined.description ?? ''}${note}`;

    for (const field of RICH) target[field] = joined[field];

    target.references = [...new Set([...(target.references ?? []), ...(source.references ?? [])])];

    // Custom fields the survivor does not have. Its own values win: it is the one being kept.
    const have = new Set((target.customFields ?? []).map((field) => field.key ?? field.label));
    for (const field of source.customFields ?? []) {
      if (!have.has(field.key ?? field.label)) target.customFields.push(field);
    }

    /* The worse of the two scores, so a merge can never quietly downgrade a finding. */
    const scoreOf = (finding) => calculateCvss(finding.cvssv3 ?? '').baseScore ?? 0;
    if (scoreOf(source) > scoreOf(target)) target.cvssv3 = source.cvssv3;
    // A reported severity somebody argued for is kept if the survivor has none of its own.
    if (!target.severityOverride && source.severityOverride) {
      target.severityOverride = source.severityOverride;
      target.severityOverrideReason = source.severityOverrideReason;
    }
    target.updatedBy = req.user._id;

    const settings = await Settings.getSettings();
    const days = settings.danger?.public?.nbdaydelete ?? 15;
    await DeletedFinding.create({
      audit: audit._id,
      findingId: source._id,
      title: otherTitle,
      finding: source.toObject(),
      deletedBy: req.user._id,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });
    source.deleteOne();
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_DELETED,
      target: otherTitle,
      meta: { mergedInto: wasTitle },
    });

    res.json({
      finding: audit.findings.id(target._id),
      mergedTitle: otherTitle,
      restorableForDays: days,
    });
  })
);

router.delete(
  '/:id/findings/:findingId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');
    assertUnlocked(finding, req.user, await lockHolder(finding));
    const title = finding.title;

    /*
     * Kept, not destroyed. A finding is often an hour of writing with screenshots
     * attached, and the only thing standing between it and oblivion was a confirm
     * dialog — while its parent engagement gets a trash with a retention window.
     *
     * Stored verbatim in another collection so a restore is lossless and, more
     * importantly, so a deleted finding cannot leak into a report, a count or a
     * recurrence check by way of a filter somebody forgot.
     */
    const settings = await Settings.getSettings();
    const days = settings.danger?.public?.nbdaydelete ?? 15;
    await DeletedFinding.create({
      audit: audit._id,
      findingId: finding._id,
      title,
      finding: finding.toObject(),
      deletedBy: req.user._id,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });

    finding.deleteOne();
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.FINDING_DELETED, target: title });
    res.json({ ok: true, id: req.params.findingId, restorableForDays: days });
  })
);

/** What has been deleted from this engagement and can still be put back. */
router.get(
  '/:id/findings/deleted',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await DeletedFinding.find({ audit: audit._id })
      .populate('deletedBy', 'username firstname lastname')
      .sort({ createdAt: -1 });

    res.json(
      rows.map((row) => ({
        id: row._id.toString(),
        findingId: row.findingId.toString(),
        title: row.title || row.finding?.title || 'Untitled finding',
        severity: findingSeverity(row.finding ?? {}).severity,
        score: calculateCvss(row.finding?.cvssv3).baseScore,
        deletedAt: row.createdAt,
        deletedBy: row.deletedBy,
        expiresAt: row.expiresAt,
      }))
    );
  })
);

/**
 * Deletes one out of the trash, now, rather than waiting for the window to pass.
 *
 * The trash exists to make a mis-click survivable, not to make deletion take a fortnight.
 * Somebody who deleted a finding on purpose — a duplicate, a false positive, a paragraph
 * pasted into the wrong engagement — should not have to look at it for two weeks, and the
 * alternative people reach for otherwise is emptying the collection by hand.
 *
 * Whoever deleted it, the engagement's creator, or an admin. The person who wrote a finding
 * and then deleted it is exactly the person entitled to say it was never wanted; requiring an
 * admin for that would mean asking somebody else to confirm your own typo.
 *
 * Evidence in GridFS is left to `npm run media:gc`, like every other deletion path in this
 * app: images are shared by hash, so a screenshot in this finding may be the same bytes as
 * one in a live finding, and deleting it here would blank a picture somebody else is using.
 */
router.delete(
  '/:id/findings/deleted/:findingId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await DeletedFinding.findOne({ audit: audit._id, findingId: req.params.findingId });
    if (!row) {
      throw notFound('That finding is not in the trash — it may have been restored, or purged already.');
    }

    const deletedBy = idOf(row.deletedBy);
    const mayPurge =
      req.user.role === 'admin' ||
      isCreator(audit, req.user) ||
      (deletedBy && deletedBy === String(req.user._id));
    if (!mayPurge) {
      throw forbidden(
        'Only whoever deleted it, the engagement’s creator or an admin can delete a finding for good.'
      );
    }

    await DeletedFinding.deleteOne({ _id: row._id });

    /*
     * Recorded, because this is the one deletion in the app with nothing left to inspect
     * afterwards. The number the finding held becomes free for a new one again, which is the
     * intended consequence: allocation reserves numbers held in the trash so a restore cannot
     * collide, and there is now nothing to restore.
     */
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_PURGED,
      target: row.title || row.finding?.title || 'a finding',
    });

    res.json({ ok: true, id: req.params.findingId, purged: true });
  })
);

/**
 * Puts one back, with its original id.
 *
 * The id matters: comments hang off it, the activity log names it, and the recurrence
 * check across a client's engagements matches on it. A restore that minted a new id
 * would look like the same finding and behave like a different one.
 */
router.post(
  '/:id/findings/:findingId/restore',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await DeletedFinding.findOne({ audit: audit._id, findingId: req.params.findingId });
    if (!row) {
      throw notFound('That finding is not in the trash — it may have been restored already.');
    }
    if (audit.findings.id(req.params.findingId)) {
      // Somebody else got there first. Tidy up rather than duplicating the finding.
      await DeletedFinding.deleteOne({ _id: row._id });
      throw badRequest('That finding has already been restored.');
    }

    audit.findings.push(row.finding);
    const restored = audit.findings.id(req.params.findingId);

    /*
     * A safety net, not the fix.
     *
     * Allocation now reserves numbers held in the trash, so a fresh collision cannot be
     * created — but an engagement that already contains one, from before that was true, must
     * not restore into a duplicate. Renumbering loses the tie to a number a client may have
     * seen; printing the same number twice loses the reader entirely.
     */
    const taken = audit.findings.some(
      (finding) => finding !== restored && finding.identifier === restored.identifier
    );
    const renumberedFrom = taken ? restored.identifier : null;
    if (taken) restored.identifier = await nextIdentifier(audit);

    await audit.save();
    await DeletedFinding.deleteOne({ _id: row._id });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_RESTORED,
      target: row.title,
      ...(renumberedFrom ? { meta: { renumberedFrom, to: restored.identifier } } : {}),
    });

    await audit.populate(POPULATE);
    res.json({
      ...audit.findings.id(req.params.findingId).toObject(),
      /** Set only when the number it had was already in use, so the UI can say so. */
      renumberedFrom,
    });
  })
);

/** Persists a manual ordering produced by drag-and-drop. */
router.put(
  '/:id/findings-order',
  validate(z.object({ order: z.array(objectId) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    req.body.order.forEach((findingId, index) => {
      const finding = audit.findings.id(findingId);
      if (finding) finding.sortIndex = index;
    });
    audit.sortFindings = false;
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.FINDINGS_REORDERED });
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------------------- */
/* Doing one thing to a lot of findings                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a bulk action may change, and — just as important — what it may not.
 *
 * Only scalar fields: a severity, a status, a category, a priority. Never prose. That is what makes
 * it safe to skip the freshness check every single-finding write does: a colleague retyping the
 * description of one of these forty findings cannot lose a word to somebody re-scoping the batch,
 * because the two are not touching the same field. Bulk-editing a description would need per-item
 * versions and would be a worse feature than doing it one at a time.
 */
const BULK_ACTIONS = ['status', 'severity', 'category', 'vulnType', 'priority', 'complexity', 'delete', 'transfer'];

const bulkSchema = z.object({
  /*
   * Bounded, because this is one document save and mongo has a 16 MB limit on it. Two hundred is
   * far past any real engagement and still nowhere near the ceiling.
   */
  ids: z.array(objectId).min(1, 'Nothing was selected').max(200),
  action: z.enum(BULK_ACTIONS),
  /** The new value, whose shape depends on the action. Checked in the handler, where the message can say why. */
  value: z.union([z.string(), z.number(), z.null()]).optional(),
  /** Required when overriding a severity, exactly as it is for one finding. */
  reason: z.string().trim().max(500).optional(),
  /** Where a transfer is going, and whether the original stays. */
  target: objectId.optional(),
  mode: z.enum(['move', 'copy']).optional(),
});

/**
 * One action, applied to a selection.
 *
 * A forty-finding internal ends with somebody re-scoping every Medium to Low because the client
 * turned out to have compensating controls, or marking eleven things retested after a fix window.
 * Both were forty dialogs. This is one.
 *
 * **Partial success is the contract**, not an error. A finding somebody else has locked is skipped
 * and named rather than failing the batch — the alternative is that one colleague reading a
 * write-up blocks a change to the other thirty-nine, which is how people learn to work around a
 * feature. The response says what changed, what did not, and why, and the page reports it.
 *
 * Every rule the single-finding routes enforce is enforced here too, and by the same code where
 * there is any: the lock check, the "an override has to say why" rule, the status history, the
 * approval reset, and the trash a delete goes to. A bulk endpoint that quietly skipped one of
 * those would be a way round it.
 */
router.post(
  '/:id/findings/bulk',
  requireWrite,
  validate(bulkSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const { ids, action, value, reason } = req.body;
    /** What actually happened, per finding, in the order they were asked for. */
    const changed = [];
    const skipped = [];

    /*
     * The findings this caller may touch, resolved before anything is written.
     *
     * A lock is read per finding rather than once for the engagement because `lockHolder` answers
     * "is the holder still around", and a stale lock is not a lock — the same call the single-write
     * path makes, so a finding that could be edited one at a time can be edited in a batch.
     */
    const workable = [];
    for (const id of ids) {
      const finding = audit.findings.id(id);
      if (!finding) {
        skipped.push({ id, reason: 'missing', message: 'It is no longer on this engagement.' });
        continue;
      }
      try {
        assertUnlocked(finding, req.user, await lockHolder(finding));
      } catch (error) {
        skipped.push({
          id,
          title: finding.title,
          reason: 'locked',
          by: error.details?.by ?? '',
          message: error.message,
        });
        continue;
      }
      workable.push(finding);
    }

    if (!workable.length) {
      /*
       * 200, not an error. Nothing was written, and the page has a precise account of why —
       * which is a different thing from a request that failed.
       */
      return res.json({ action, changed, skipped, findings: [] });
    }

    /* --------------------------------------------------------------- transfer --- */
    if (action === 'transfer') {
      if (!req.body.target) throw badRequest('Say which engagement to move them to.');
      if (String(req.body.target) === String(audit._id)) {
        throw badRequest('That is the engagement they are already on.');
      }
      const target = await loadOtherAudit(req, req.body.target);
      assertEditable(target, req.user);
      const move = req.body.mode !== 'copy';

      let imagesRemoved = 0;
      for (const finding of workable) {
        const result = await transferOneFinding({
          source: audit,
          target,
          finding,
          user: req.user,
          move,
        });
        imagesRemoved += result.imagesRemoved;
        changed.push({ id: String(result.landed._id), title: result.title, identifier: result.landed.identifier });
      }
      await target.save();
      if (move) await audit.save();

      /* One entry a side, naming the count. Forty rows saying the same thing is not a log. */
      for (const [where, direction, other] of [
        [audit, move ? 'out' : 'copied-from', target],
        [target, 'in', audit],
      ]) {
        await recordActivity({
          audit: where,
          actor: req.user,
          action: ACTIONS.FINDING_TRANSFERRED,
          target: `${changed.length} finding${changed.length === 1 ? '' : 's'}`,
          meta: {
            mode: move ? 'move' : 'copy',
            direction,
            other: other.reference || other.name,
            count: changed.length,
            titles: changed.map((row) => row.title).slice(0, 20),
          },
        });
      }

      return res.json({
        action,
        mode: move ? 'move' : 'copy',
        target: String(target._id),
        targetName: target.name,
        changed,
        skipped,
        imagesRemoved,
        findings: move ? [] : changed.map((row) => row.id),
      });
    }

    /* ----------------------------------------------------------------- delete --- */
    if (action === 'delete') {
      const settings = await Settings.getSettings();
      const days = settings.danger?.public?.nbdaydelete ?? 15;
      for (const finding of workable) {
        /*
         * The same trash a single delete uses. A finding is often an hour of writing with
         * screenshots attached, and a batch is exactly where somebody deletes one they meant to
         * keep — so the undo has to be there for all of them, not just the careful ones.
         */
        await DeletedFinding.create({
          audit: audit._id,
          findingId: finding._id,
          title: finding.title,
          finding: finding.toObject(),
          deletedBy: req.user._id,
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        });
        changed.push({ id: String(finding._id), title: finding.title });
        finding.deleteOne();
      }
      await audit.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.FINDING_DELETED,
        target: `${changed.length} finding${changed.length === 1 ? '' : 's'}`,
        meta: { count: changed.length, titles: changed.map((row) => row.title).slice(0, 20) },
      });
      return res.json({ action, changed, skipped, restorableForDays: days, findings: [] });
    }

    /* ------------------------------------------------------------ a field, then --- */
    /** Which field each action writes, and how to read the value it was given. */
    const FIELDS = {
      status: {
        field: 'remediationStatus',
        read: () => {
          if (!REMEDIATION_STATUSES.includes(value)) {
            throw badRequest(`"${value}" is not a status a finding can have.`);
          }
          return value;
        },
      },
      severity: {
        field: 'severityOverride',
        read: () => {
          const allowed = ['', 'Critical', 'High', 'Medium', 'Low', 'None'];
          if (!allowed.includes(value)) throw badRequest(`"${value}" is not a severity.`);
          return value;
        },
      },
      category: {
        field: 'category',
        read: () => String(value ?? '').trim().slice(0, 120),
      },
      vulnType: {
        field: 'vulnType',
        read: () => String(value ?? '').trim().slice(0, 120),
      },
      priority: {
        field: 'priority',
        read: () => {
          if (value === null || value === '') return null;
          const number = Number(value);
          if (!Number.isInteger(number) || number < 1 || number > 4) {
            throw badRequest('A priority is 1, 2, 3 or 4.');
          }
          return number;
        },
      },
      complexity: {
        field: 'remediationComplexity',
        read: () => {
          if (value === null || value === '') return null;
          const number = Number(value);
          if (!Number.isInteger(number) || number < 1 || number > 3) {
            throw badRequest('A remediation complexity is 1, 2 or 3.');
          }
          return number;
        },
      },
    };

    const { field, read } = FIELDS[action];
    const next = read();

    /*
     * An override still has to say why — the same rule as one finding at a time, and the reason
     * a bulk endpoint is not a way round it. Asked for once and stored on each, because the
     * reason for re-scoping a batch is one sentence about all of them ("compensating control
     * agreed with the client at the kickoff"), which is exactly what should print beside each score.
     */
    if (action === 'severity' && next !== '' && !String(reason ?? '').trim()) {
      throw badRequest('Say why these are being re-scored. It prints beside each score.');
    }

    for (const finding of workable) {
      if (JSON.stringify(finding[field]) === JSON.stringify(next)) {
        /* Already there. Reported rather than counted as a change, so the total is honest. */
        skipped.push({
          id: String(finding._id),
          title: finding.title,
          reason: 'unchanged',
          message: 'It was already that.',
        });
        continue;
      }

      finding.set({ [field]: next });

      if (action === 'severity') {
        const rated = findingSeverity(finding);
        finding.severityOverrideReason = next === '' ? '' : String(reason ?? '').trim();
        finding.severityOverrideBy = rated.overridden ? req.user._id : null;
        finding.severityOverrideAt = rated.overridden ? new Date() : null;
      }

      if (action === 'status') {
        /* Appended, exactly as a single change is: this is the history a retest turns on. */
        finding.statusHistory.push({ status: next, at: new Date(), by: req.user._id });
      }

      finding.updatedBy = req.user._id;
      changed.push({ id: String(finding._id), title: finding.title });
    }

    if (changed.length) {
      const settings = await Settings.getSettings();
      await clearApprovalsIfConfigured({
        audit,
        actor: req.user,
        settings,
        target: `${changed.length} finding${changed.length === 1 ? '' : 's'}`,
      });
      await audit.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.FINDING_UPDATED,
        target: `${changed.length} finding${changed.length === 1 ? '' : 's'}`,
        fields: [field],
        meta: {
          bulk: true,
          count: changed.length,
          value: next,
          ...(action === 'severity' && reason ? { reason: String(reason).trim() } : {}),
          titles: changed.map((row) => row.title).slice(0, 20),
        },
      });
    }

    res.json({ action, field, value: next, changed, skipped, findings: changed.map((row) => row.id) });
  })
);

/**
 * Renumbers every finding to match the order they are in.
 *
 * `identifier` is what the report prints as VULN-03, and it is allocated when a finding is written
 * — so a report whose findings were reordered, or where two drafts were deleted, prints VULN-01,
 * VULN-04, VULN-07 in that order. Nobody wants to explain that to a client, and the alternative
 * until now was a maintenance script.
 *
 * Refused once anything has been delivered. An identifier is a reference the client has written
 * their remediation tickets against: renumbering after a report has gone out means their VULN-04
 * and ours are different findings, which is worse than an untidy sequence. Same reasoning as the
 * trash reserving the numbers of restorable findings.
 */
router.post(
  '/:id/findings/renumber',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const delivered = await Delivery.countDocuments({ audit: audit._id });
    if (delivered) {
      throw badRequest(
        `This engagement has been delivered ${delivered} time${delivered === 1 ? '' : 's'}. ` +
          'Its findings keep the numbers the client is holding.'
      );
    }
    /*
     * The trash still holds numbers, and a restore brings its finding back carrying one. Renumbering
     * around them would hand a live finding a number the trash can produce a second copy of.
     */
    const trashed = await DeletedFinding.countDocuments({ audit: audit._id });
    if (trashed) {
      throw badRequest(
        `${trashed} deleted finding${trashed === 1 ? '' : 's'} can still be restored, and ${
          trashed === 1 ? 'it holds a number' : 'they hold numbers'
        }. Empty the trash first, or restore ${trashed === 1 ? 'it' : 'them'}.`
      );
    }

    /* The order the page shows, which is the order the report prints. */
    const ordered = [...audit.findings].sort((a, b) =>
      audit.sortFindings === false
        ? (a.sortIndex ?? 0) - (b.sortIndex ?? 0)
        : (calculateCvss(b.cvssv3).baseScore ?? -1) - (calculateCvss(a.cvssv3).baseScore ?? -1) ||
          String(a.title).localeCompare(String(b.title))
    );

    const before = ordered.map((finding) => finding.identifier);
    ordered.forEach((finding, index) => {
      finding.identifier = index + 1;
    });
    const moved = ordered.filter((finding, index) => before[index] !== finding.identifier).length;

    if (moved) {
      await audit.save();
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.FINDINGS_REORDERED,
        target: `${moved} finding${moved === 1 ? '' : 's'} renumbered`,
        meta: { renumbered: moved, total: ordered.length },
      });
    }

    res.json({
      renumbered: moved,
      total: ordered.length,
      order: ordered.map((finding) => ({ id: String(finding._id), identifier: finding.identifier })),
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

router.post(
  '/:id/sections',
  validate(sectionSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    if (audit.sections.some((s) => s.field === req.body.field)) {
      throw badRequest(`This engagement already has a "${req.body.field}" section`);
    }
    audit.sections.push(req.body);
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SECTION_CREATED,
      target: req.body.name,
    });
    res.status(201).json(audit.sections.at(-1));
  })
);

router.put(
  '/:id/sections/:sectionId',
  validate(withVersion(sectionSchema.partial())),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    const section = audit.sections.id(req.params.sectionId);
    if (!section) throw notFound('Section not found');

    const { expectedUpdatedAt, ...patch } = req.body;
    assertFresh(section, expectedUpdatedAt, {
      label: `the "${section.name}" section`,
      current: section,
    });
    const textBefore = section.text;
    section.set(patch);

    const settings = await Settings.getSettings();
    await clearApprovalsIfConfigured({ audit, actor: req.user, settings, target: section.name });

    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SECTION_UPDATED,
      target: section.name,
    });
    // A section is client-facing text, so a handle left in it would ship. Notifying
    // the person is also the fastest way for somebody to notice and take it out.
    const mentions = await notifyMentions({
      body: section.text,
      previousBody: textBefore,
      actor: req.user,
      audit,
      where: 'section',
      title: section.name,
    });
    res.json({ ...section.toObject(), _mentions: mentions });
  })
);

router.delete(
  '/:id/sections/:sectionId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    const section = audit.sections.id(req.params.sectionId);
    if (!section) throw notFound('Section not found');
    const name = section.name;
    section.deleteOne();
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.SECTION_DELETED, target: name });
    res.json({ ok: true, id: req.params.sectionId });
  })
);

/* -------------------------------------------------------------------------- */
/* Notes — the tester's scratchpad, never part of a report                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Handover                                                                   */
/* -------------------------------------------------------------------------- */

const handoverSchema = z.object({
  did: z.string().trim().max(4000).optional().default(''),
  next: z.string().trim().max(4000).optional().default(''),
  blockers: z.string().trim().max(4000).optional().default(''),
  credentials: z.string().trim().max(1000).optional().default(''),
});

/**
 * The engagement's handover log, newest first.
 *
 * Read far more often than written, and read in a hurry — somebody starting their day on a job
 * somebody else was on yesterday. So it is its own route rather than something to find inside the
 * engagement document, and it comes back with the authors resolved to names.
 */
router.get(
  '/:id/handovers',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    await audit.populate({ path: 'handovers.author', select: 'username firstname lastname' });
    const entries = [...(audit.handovers ?? [])].sort(
      (a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0)
    );
    res.json(entries);
  })
);

router.post(
  '/:id/handovers',
  validate(handoverSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    // An entry saying nothing is worse than no entry: it reads as a session where nothing happened.
    if (!req.body.did.trim() && !req.body.next.trim() && !req.body.blockers.trim()) {
      throw badRequest('Say what you did, what is next, or what is in the way');
    }

    audit.handovers.push({ ...req.body, author: req.user._id });
    await audit.save();
    const entry = audit.handovers.at(-1);

    /*
     * Not written to the activity log. The entry is itself a dated, attributed record — logging
     * "somebody added a handover" beside it would be the same fact twice, and the activity tab is
     * for things that changed the engagement rather than notes about working on it.
     */
    await audit.populate({ path: 'handovers.author', select: 'username firstname lastname' });
    res.status(201).json(audit.handovers.id(entry._id));
  })
);

/**
 * Only the author, and only their own.
 *
 * A handover is testimony about what one person did. Somebody else editing it would make it
 * unreliable in exactly the situation it exists for, and an engagement lead who disagrees with one
 * can add their own entry saying so.
 */
router.put(
  '/:id/handovers/:handoverId',
  validate(handoverSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const entry = audit.handovers.id(req.params.handoverId);
    if (!entry) throw notFound('Handover not found');
    if (String(entry.author) !== String(req.user._id)) {
      throw forbidden('Only the person who wrote a handover can change it');
    }

    entry.set(req.body);
    await audit.save();
    await audit.populate({ path: 'handovers.author', select: 'username firstname lastname' });
    res.json(audit.handovers.id(entry._id));
  })
);

router.delete(
  '/:id/handovers/:handoverId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const entry = audit.handovers.id(req.params.handoverId);
    if (!entry) throw notFound('Handover not found');
    if (String(entry.author) !== String(req.user._id) && req.user.role !== 'admin') {
      throw forbidden('Only the person who wrote a handover can remove it');
    }
    entry.deleteOne();
    await audit.save();
    res.json({ ok: true });
  })
);

const noteSchema = z.object({
  title: z.string().trim().max(200).optional().default('Untitled note'),
  content: z.string().optional().default(''),
  icon: z.string().trim().max(60).optional().default(''),
  pinned: z.boolean().optional().default(false),
});

router.get(
  '/:id/notes',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    await audit.populate([
      { path: 'notes.author', select: 'username firstname lastname' },
      { path: 'notes.updatedBy', select: 'username firstname lastname' },
    ]);
    res.json(audit.notes ?? []);
  })
);

router.post(
  '/:id/notes',
  validate(noteSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    audit.notes.push({
      ...req.body,
      author: req.user._id,
      updatedBy: req.user._id,
      // New notes go to the top; a scratchpad is written newest-first.
      order: Math.min(0, ...(audit.notes ?? []).map((n) => n.order ?? 0)) - 1,
    });
    await audit.save();
    const note = audit.notes.at(-1);
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.NOTE_CREATED,
      target: note.title,
    });
    const mentions = await notifyMentions({
      body: note.content,
      actor: req.user,
      audit,
      where: 'note',
      title: note.title,
    });
    res.status(201).json({ ...note.toObject(), _mentions: mentions });
  })
);

router.put(
  '/:id/notes/:noteId',
  validate(withVersion(noteSchema.partial().extend({ order: z.number().int().optional() }))),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const note = audit.notes.id(req.params.noteId);
    if (!note) throw notFound('Note not found');

    const { expectedUpdatedAt, ...patch } = req.body;
    assertFresh(note, expectedUpdatedAt, {
      label: `the note "${note.title}"`,
      current: note,
    });

    const contentBefore = note.content;
    note.set({ ...patch, updatedBy: req.user._id });
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.NOTE_UPDATED,
      target: note.title,
    });
    // Only handles the note did not already contain, so saving repeatedly while
    // writing does not notify the same person on every keystroke-triggered save.
    const mentions = await notifyMentions({
      body: note.content,
      previousBody: contentBefore,
      actor: req.user,
      audit,
      where: 'note',
      title: note.title,
    });
    res.json({ ...note.toObject(), _mentions: mentions });
  })
);

/**
 * Writes a note up as a finding.
 *
 * Notes are deliberately invisible to report templates — half-formed leads, things to try, the
 * password that worked. But the path from "capture first, write up later" to an actual finding
 * was copy and paste, and images pasted into a note had to be pasted again, which is the point
 * at which people stop using the scratchpad and start writing findings they are not sure of.
 *
 * The note is kept, not consumed, and gains a link to the finding. It is the raw log of what was
 * tried; capturing is only safe if capturing costs nothing. The link is also what stops two
 * people reading the same scratchpad writing the same lead up twice.
 *
 * Evidence needs no copying: images are referenced by id and deduplicated by hash, so the
 * finding and the note point at the same bytes. `media:gc` counts references, so nothing is
 * swept while either still holds one.
 */
router.post(
  '/:id/notes/:noteId/promote',
  validate(
    z.object({
      title: z.string().trim().max(300).optional(),
      /** Which part of the finding the note becomes. Most notes are observations. */
      field: z.enum(['description', 'observation', 'poc']).optional().default('description'),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const note = audit.notes.id(req.params.noteId);
    if (!note) throw notFound('Note not found');

    /*
     * Refused only while the finding it made still exists. A stale link — the finding was
     * deleted since — should not stop somebody writing the lead up again, and silently making
     * a second finding while the first is still there is how a report grows duplicates.
     */
    if (note.promotedTo && audit.findings.id(note.promotedTo)) {
      const existing = audit.findings.id(note.promotedTo);
      throw badRequest(
        `That note has already been written up as "${existing.title}". Edit the finding instead, or copy what you need.`
      );
    }

    const title =
      req.body.title?.trim() ||
      (note.title && note.title !== 'Untitled note' ? note.title : 'Untitled finding');

    audit.findings.push({
      title,
      [req.body.field]: note.content ?? '',
      identifier: await nextIdentifier(audit),
      sortIndex: (audit.findings ?? []).length,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    const finding = audit.findings.at(-1);

    note.promotedTo = finding._id;
    note.promotedAt = new Date();
    note.promotedBy = req.user._id;
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.NOTE_PROMOTED,
      target: note.title,
      meta: { finding: finding.title, findingId: finding._id.toString() },
    });

    res.status(201).json({
      finding: audit.findings.id(finding._id),
      note: { _id: note._id, promotedTo: note.promotedTo, promotedAt: note.promotedAt },
    });
  })
);

router.delete(
  '/:id/notes/:noteId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    const note = audit.notes.id(req.params.noteId);
    if (!note) throw notFound('Note not found');
    const title = note.title;
    note.deleteOne();
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.NOTE_DELETED, target: title });
    res.json({ ok: true, id: req.params.noteId });
  })
);

/**
 * Puts the sections in the order the report should read them in.
 *
 * Findings have had this since they were droppable; sections never did, so the narrative order
 * of every report was the order somebody happened to create them in — and the fix was to delete
 * a section and write it again further down.
 *
 * The array *is* the order. Sections carry no sort field, unlike findings, because nothing
 * sorts them automatically: `{{#sections}}` walks the array, and the tab renders the array, so
 * one place decides and there is nothing to keep in step.
 *
 * Ids the caller leaves out keep their relative order at the end rather than disappearing. A
 * client that has just added a section and sends a stale order would otherwise silently drop
 * the new one, and losing written prose to a reordering is not a trade worth making.
 */
router.put(
  '/:id/sections-order',
  validate(z.object({ order: z.array(objectId) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const current = (audit.sections ?? []).map((section) => section.toObject());
    const byId = new Map(current.map((section) => [String(section._id), section]));

    const ordered = [];
    for (const id of req.body.order) {
      const section = byId.get(String(id));
      if (section) {
        ordered.push(section);
        byId.delete(String(id));
      }
    }
    // Whatever was not mentioned, in the order it already had.
    for (const section of current) {
      if (byId.has(String(section._id))) ordered.push(section);
    }

    /*
     * Assigned as plain objects, which keeps every `_id` — and therefore the placeholders a
     * template already refers to, since a section is addressed by its `field` and its id is what
     * the editor writes back to.
     */
    audit.sections = ordered;
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.SECTIONS_REORDERED });

    res.json({ ok: true, order: audit.sections.map((section) => section._id) });
  })
);

/* -------------------------------------------------------------------------- */
/* Credentials — the client's, for the length of the engagement               */
/* -------------------------------------------------------------------------- */

const credentialSchema = z.object({
  label: z.string().trim().min(1, 'Give it a name you will recognise').max(160),
  username: z.string().trim().max(200).optional().default(''),
  secret: z.string().min(1, 'There is nothing to store').max(4000),
  url: z.string().trim().max(500).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
  /** ISO date, or null for "keep until somebody deletes it". */
  expiresAt: z.string().datetime().nullable().optional(),
});

/** Everything except the secret. The list is meant to be readable at a glance. */
const credentialSummary = (row) => ({
  _id: row._id,
  label: row.label,
  username: row.username,
  url: row.url,
  notes: row.notes,
  createdBy: row.createdBy,
  updatedBy: row.updatedBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  reveals: row.reveals,
  lastRevealedAt: row.lastRevealedAt,
  lastRevealedBy: row.lastRevealedBy,
  expiresAt: row.expiresAt,
});

const CREDENTIAL_POPULATE = [
  { path: 'createdBy', select: 'username firstname lastname' },
  { path: 'updatedBy', select: 'username firstname lastname' },
  { path: 'lastRevealedBy', select: 'username firstname lastname' },
];

router.get(
  '/:id/credentials',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await Credential.find({ audit: audit._id })
      .populate(CREDENTIAL_POPULATE)
      .sort({ createdAt: -1 });

    res.json({
      /** So the page can explain itself rather than failing on the first save. */
      enabled: vaultEnabled(),
      disabledReason: vaultEnabled() ? '' : VAULT_DISABLED_MESSAGE,
      credentials: rows.map(credentialSummary),
    });
  })
);

router.post(
  '/:id/credentials',
  validate(credentialSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    assertVault();

    const { secret, expiresAt, ...rest } = req.body;
    const row = await Credential.create({
      ...rest,
      audit: audit._id,
      secret: encryptSecret(secret),
      // On a restricted engagement a borrowed password has to be temporary, and the cap is
      // applied rather than argued about. See classification.service.js.
      expiresAt: resolveCredentialExpiry(audit, expiresAt ? new Date(expiresAt) : null),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CREDENTIAL_ADDED,
      target: row.label,
    });
    await row.populate(CREDENTIAL_POPULATE);
    res.status(201).json(credentialSummary(row));
  })
);

/**
 * Hands the secret over, and says so.
 *
 * A POST rather than a GET on purpose: this is not a page you can land on, it must not sit
 * in browser history or a proxy log, and it changes something — the access trail.
 */
router.post(
  '/:id/credentials/:credentialId/reveal',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const row = await Credential.findOne({ _id: req.params.credentialId, audit: audit._id });
    if (!row) throw notFound('Credential not found');

    const secret = decryptSecret(row.secret);
    row.reveals += 1;
    row.lastRevealedAt = new Date();
    row.lastRevealedBy = req.user._id;
    await row.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CREDENTIAL_REVEALED,
      target: row.label,
    });
    res.json({ secret, reveals: row.reveals });
  })
);

router.put(
  '/:id/credentials/:credentialId',
  validate(credentialSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await Credential.findOne({ _id: req.params.credentialId, audit: audit._id });
    if (!row) throw notFound('Credential not found');

    const { secret, expiresAt, ...rest } = req.body;
    row.set({ ...rest, updatedBy: req.user._id });
    // Only touched when a new one is supplied: an edit to the label must not require
    // re-typing the password.
    if (secret !== undefined) row.secret = encryptSecret(secret);
    if (expiresAt !== undefined) row.expiresAt = expiresAt ? new Date(expiresAt) : null;
    await row.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CREDENTIAL_UPDATED,
      target: row.label,
    });
    await row.populate(CREDENTIAL_POPULATE);
    res.json(credentialSummary(row));
  })
);

router.delete(
  '/:id/credentials/:credentialId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await Credential.findOne({ _id: req.params.credentialId, audit: audit._id });
    if (!row) throw notFound('Credential not found');
    const label = row.label;
    await Credential.deleteOne({ _id: row._id });

    await recordActivity({ audit, actor: req.user, action: ACTIONS.CREDENTIAL_DELETED, target: label });
    res.json({ ok: true, id: req.params.credentialId });
  })
);

/** The end-of-engagement sweep: nothing kept that was only borrowed. */
router.delete(
  '/:id/credentials',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const result = await Credential.deleteMany({ audit: audit._id });
    const removed = result.deletedCount ?? 0;
    if (removed) {
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.CREDENTIALS_PURGED,
        meta: { removed },
      });
    }
    res.json({ ok: true, removed });
  })
);

/* -------------------------------------------------------------------------- */
/* Comments on findings — internal review chatter                             */
/* -------------------------------------------------------------------------- */

router.post(
  '/:id/findings/:findingId/comments',
  validate(
    z.object({
      body: z.string().trim().min(1, 'Write something first').max(4000),
      field: z.string().trim().max(60).optional().default(''),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    // Reviewers must be able to comment on an approved engagement, so this is
    // deliberately not gated on assertEditable.
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');

    finding.comments.push({ ...req.body, author: req.user._id });
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.COMMENT_ADDED,
      target: finding.title,
    });
    // @name in the body notifies that person, if the handle matches an account.
    const mentions = await notifyMentions({
      body: req.body.body,
      actor: req.user,
      audit,
      finding,
    });

    await audit.populate({ path: 'findings.comments.author', select: 'username firstname lastname' });
    res.status(201).json({
      ...audit.findings.id(req.params.findingId).comments.at(-1).toObject(),
      mentioned: mentions.notified,
      unknownMentions: mentions.unknown,
    });
  })
);

router.put(
  '/:id/findings/:findingId/comments/:commentId',
  validate(
    z.object({
      body: z.string().trim().min(1).max(4000).optional(),
      resolved: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');
    const comment = finding.comments.id(req.params.commentId);
    if (!comment) throw notFound('Comment not found');

    // Only the author may reword a comment; anyone on the team may resolve one.
    const bodyBefore = comment.body;
    if (req.body.body !== undefined) {
      if (!comment.author.equals(req.user._id) && req.user.role !== 'admin') {
        throw forbidden('You can only edit your own comments');
      }
      comment.body = req.body.body;
    }
    if (req.body.resolved !== undefined) {
      comment.resolved = req.body.resolved;
      comment.resolvedBy = req.body.resolved ? req.user._id : null;
      comment.resolvedAt = req.body.resolved ? new Date() : null;
      await recordActivity({
        audit,
        actor: req.user,
        action: req.body.resolved ? ACTIONS.COMMENT_RESOLVED : ACTIONS.COMMENT_REOPENED,
        target: finding.title,
      });
    }

    await audit.save();
    // Adding a name to a comment you already posted is the same act as writing it
    // there in the first place, and used to reach nobody.
    const mentions = await notifyMentions({
      body: comment.body,
      previousBody: bodyBefore,
      actor: req.user,
      audit,
      finding,
    });
    res.json({
      ...comment.toObject(),
      mentioned: mentions.notified,
      unknownMentions: mentions.unknown,
    });
  })
);

router.delete(
  '/:id/findings/:findingId/comments/:commentId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');
    const comment = finding.comments.id(req.params.commentId);
    if (!comment) throw notFound('Comment not found');
    if (!comment.author.equals(req.user._id) && req.user.role !== 'admin') {
      throw forbidden('You can only delete your own comments');
    }
    comment.deleteOne();
    await audit.save();
    res.json({ ok: true, id: req.params.commentId });
  })
);

/* -------------------------------------------------------------------------- */
/* Test checks — what the team said it would test, and whether it did         */
/* -------------------------------------------------------------------------- */

const CHECK_POPULATE = [
  { path: 'testChecks.createdBy', select: 'username firstname lastname' },
  { path: 'testChecks.doneBy', select: 'username firstname lastname' },
  { path: 'testChecks.assignedTo', select: 'username firstname lastname' },
];

/**
 * Checks that whoever is being given work is actually on the engagement.
 *
 * Anybody with write access may assign, not just the creator — splitting a checklist is
 * ordinary collaborative work, unlike changing who is on the team, which is a claim on
 * somebody's week. But the person has to be a member, or the check would point at somebody who
 * cannot open the engagement to do it.
 */
function assertAssignable(audit, userId) {
  if (!userId) return null;
  const team = [
    idOf(audit.creator),
    ...(audit.collaborators ?? []).map(idOf),
    ...(audit.reviewers ?? []).map(idOf),
  ];
  if (!team.includes(String(userId))) {
    throw badRequest('That person is not on this engagement, so a check cannot be theirs.');
  }
  return String(userId);
}

const testCheckSchema = z.object({
  title: z.string().trim().min(1, 'Describe what should be tested').max(300),
  description: z.string().trim().max(2000).optional().default(''),
  category: z.string().trim().max(120).optional().default(''),
});

router.get(
  '/:id/test-checks',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    await audit.populate(CHECK_POPULATE);
    res.json(audit.testChecks ?? []);
  })
);

router.post(
  '/:id/test-checks',
  validate(testCheckSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    audit.testChecks.push({
      ...req.body,
      createdBy: req.user._id,
      // Appended, because a checklist reads in the order it was written.
      order: Math.max(0, ...(audit.testChecks ?? []).map((c) => c.order ?? 0)) + 1,
    });
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CHECK_CREATED,
      target: req.body.title,
    });
    await audit.populate(CHECK_POPULATE);
    res.status(201).json(audit.testChecks.at(-1));
  })
);

/** Adds a whole preset, skipping titles the engagement already has. */
router.post(
  '/:id/test-checks/preset',
  validate(z.object({ preset: z.string().trim().min(1) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const preset = await findPreset(req.body.preset);
    if (!preset) throw badRequest('That checklist does not exist.');

    // Re-adding a preset should top up rather than duplicate, so a team can pull
    // in the web list and later add the API items without cleaning up by hand.
    const existing = new Set(
      (audit.testChecks ?? []).map((c) => `${c.category}|${c.title}`.toLowerCase())
    );
    let order = Math.max(0, ...(audit.testChecks ?? []).map((c) => c.order ?? 0));
    let added = 0;

    for (const check of preset.checks) {
      const key = `${check.category ?? ''}|${check.title}`.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      order += 1;
      // Copied field by field: checklists are documents now, and spreading a
      // Mongoose subdocument yields its internals rather than its values — which
      // inserted checks with no title at all.
      audit.testChecks.push({
        title: check.title,
        description: check.description ?? '',
        category: check.category ?? '',
        createdBy: req.user._id,
        order,
      });
      added += 1;
    }

    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CHECKS_ADDED,
      meta: { added, preset: preset.name },
    });
    await audit.populate(CHECK_POPULATE);
    res.json({ added, skipped: preset.checks.length - added, testChecks: audit.testChecks });
  })
);

/**
 * Ticks a check identified by its wording rather than its id, adding it first if
 * the engagement does not have it yet.
 *
 * This is what lets the checklist library tick against a chosen engagement: there,
 * the row is a methodology item, and the engagement may not carry it yet. Doing it
 * in one request keeps "add it" and "mark it done" from being two states a refresh
 * could land between, and keeps the accountability identical to ticking on the
 * Checks tab — the same doneBy, doneAt and activity entry.
 */
router.post(
  '/:id/test-checks/toggle',
  validate(
    z.object({
      title: z.string().trim().min(1).max(300),
      category: z.string().trim().max(120).optional().default(''),
      description: z.string().trim().max(2000).optional().default(''),
      done: z.boolean(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    // Ticking is not editing the report, so an approved engagement still allows it.
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const key = (category, title) => `${category ?? ''}|${title}`.trim().toLowerCase();
    const wanted = key(req.body.category, req.body.title);

    let check = (audit.testChecks ?? []).find((c) => key(c.category, c.title) === wanted);
    let created = false;

    if (!check) {
      audit.testChecks.push({
        title: req.body.title,
        category: req.body.category,
        description: req.body.description,
        createdBy: req.user._id,
        order: Math.max(0, ...(audit.testChecks ?? []).map((c) => c.order ?? 0)) + 1,
      });
      check = audit.testChecks.at(-1);
      created = true;
    }

    const changed = check.done !== req.body.done;
    check.done = req.body.done;
    check.doneBy = req.body.done ? req.user._id : null;
    check.doneAt = req.body.done ? new Date() : null;

    await audit.save();

    if (changed || created) {
      await recordActivity({
        audit,
        actor: req.user,
        action: req.body.done ? ACTIONS.CHECK_TICKED : ACTIONS.CHECK_UNTICKED,
        target: check.title,
        meta: created ? { addedFromChecklist: true } : undefined,
      });
    }

    await audit.populate(CHECK_POPULATE);
    res.json({ created, check: audit.testChecks.id(check._id) });
  })
);

router.put(
  '/:id/test-checks/:checkId',
  validate(
    testCheckSchema.partial().extend({
      done: z.boolean().optional(),
      /** Cannot be done, and why. The reason is enforced by the route, not the schema. */
      blocked: z.boolean().optional(),
      blockedReason: z.string().trim().max(300).optional(),
      result: z.string().trim().max(2000).optional(),
      order: z.number().int().optional(),
      /** `null` gives it back to nobody in particular. */
      assignedTo: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    // Ticking is not editing the report, and a reviewer should be able to work
    // through the list on an approved engagement.
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const check = audit.testChecks.id(req.params.checkId);
    if (!check) throw notFound('Check not found');

    const { done, assignedTo, blocked, blockedReason, ...rest } = req.body;
    // Editing the wording of a check is a report change; ticking is not, and neither is
    // handing one to a colleague — a signed-off engagement can still have its list divided up.
    if (Object.keys(rest).length) assertEditable(audit, req.user);
    const resultBefore = check.result;
    check.set(rest);

    const assignedBefore = idOf(check.assignedTo);
    if (assignedTo !== undefined) {
      check.assignedTo = assignedTo ? assertAssignable(audit, assignedTo) : null;
    }
    const assignmentChanged = assignedTo !== undefined && idOf(check.assignedTo) !== assignedBefore;

    const ticked = done !== undefined && done !== check.done;
    if (ticked) {
      check.done = done;
      // Record who signed it off, so the checklist is accountable.
      check.doneBy = done ? req.user._id : null;
      check.doneAt = done ? new Date() : null;
      /*
       * Ticking clears blocked. You did it, so it was not blocked — and a check that claimed both
       * would make every count that reads one of them wrong.
       */
      if (done) {
        check.blocked = false;
        check.blockedReason = '';
        check.blockedBy = null;
        check.blockedAt = null;
      }
    }

    const blockChanged = blocked !== undefined && blocked !== check.blocked;
    if (blocked !== undefined || blockedReason !== undefined) {
      const wanted = blocked ?? check.blocked;
      const reason = (blockedReason ?? check.blockedReason ?? '').trim();
      if (wanted) {
        // "Blocked" with no reason is a shrug: whoever finds it next has to ask somebody.
        if (!reason) throw badRequest('Say what is blocking it — that is the useful half.');
        if (check.done) {
          throw badRequest('That check is already done, so nothing is blocking it.');
        }
        check.blocked = true;
        check.blockedReason = reason;
        check.blockedBy = req.user._id;
        check.blockedAt = check.blockedAt ?? new Date();
      } else {
        check.blocked = false;
        check.blockedReason = '';
        check.blockedBy = null;
        check.blockedAt = null;
      }
    }

    await audit.save();
    if (blockChanged) {
      await recordActivity({
        audit,
        actor: req.user,
        action: check.blocked ? ACTIONS.CHECK_BLOCKED : ACTIONS.CHECK_UNBLOCKED,
        target: check.title,
        meta: check.blocked ? { reason: check.blockedReason } : null,
      });
    }
    await recordActivity({
      audit,
      actor: req.user,
      action: assignmentChanged
        ? ACTIONS.CHECK_ASSIGNED
        : ticked
          ? done
            ? ACTIONS.CHECK_TICKED
            : ACTIONS.CHECK_UNTICKED
          : ACTIONS.CHECK_UPDATED,
      target: check.title,
      ...(assignmentChanged ? { meta: { assigned: Boolean(check.assignedTo) } } : {}),
    });

    /*
     * Tell them.
     *
     * Being given work is exactly the kind of thing the notification bell is for, and it was
     * one of only three events that ever reached it. Not for taking a check yourself: telling
     * somebody what they just did is noise, and noise is what makes a bell get ignored.
     */
    if (assignmentChanged && check.assignedTo && idOf(check.assignedTo) !== String(req.user._id)) {
      await notifyCheckAssigned({
        user: check.assignedTo,
        actor: req.user,
        audit,
        title: check.title,
      });
    }
    // "@nadia this needs a second pair of eyes" in a check result is the most
    // natural place to hand work over, and used to notify nobody.
    const mentions = await notifyMentions({
      body: check.result,
      previousBody: resultBefore,
      actor: req.user,
      audit,
      where: 'check',
      title: check.title,
    });
    await audit.populate(CHECK_POPULATE);
    res.json({ ...audit.testChecks.id(req.params.checkId).toObject(), _mentions: mentions });
  })
);

router.delete(
  '/:id/test-checks/:checkId',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    const check = audit.testChecks.id(req.params.checkId);
    if (!check) throw notFound('Check not found');
    const title = check.title;
    check.deleteOne();
    await audit.save();
    await recordActivity({ audit, actor: req.user, action: ACTIONS.CHECK_DELETED, target: title });
    res.json({ ok: true, id: req.params.checkId });
  })
);

/** Clears the whole list — useful after pulling in the wrong preset. */
router.delete(
  '/:id/test-checks',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    const removed = audit.testChecks.length;
    audit.testChecks = [];
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.CHECKS_CLEARED,
      meta: { removed },
    });
    res.json({ ok: true, removed });
  })
);

/* -------------------------------------------------------------------------- */
/* Preflight and scan import                                                  */
/* -------------------------------------------------------------------------- */

/** What is missing or suspicious before this becomes a client deliverable. */
router.get(
  '/:id/preflight',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);
    res.json(preflightAudit(audit));
  })
);

/**
 * Imports hosts and services from an Nmap XML scan into the scope.
 *
 * Re-importable: hosts are matched on IP then hostname, so a later scan of the
 * same range updates rather than duplicates.
 */
router.post(
  '/:id/scope/import',
  uploadMemory,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    if (!req.file) throw badRequest('No file uploaded — send it as multipart field "file"');

    const groupName = String(req.body.group ?? '').trim() || 'Imported from Nmap';
    const parsed = parseNmapXml(req.file.buffer.toString('utf8'), {
      onlyOpen: req.body.onlyOpen !== 'false',
      includeDown: req.body.includeDown === 'true',
    });

    const { scope, added, updated } = mergeHostsIntoScope(audit.scope, parsed.hosts, groupName);
    audit.scope = scope;
    // Counts as a details change, so an open scope editor is warned rather than
    // quietly overwriting the imported hosts.
    audit.detailsUpdatedAt = new Date();
    await audit.save();
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SCOPE_IMPORTED,
      meta: { added, updated, group: groupName },
    });

    res.json({
      added,
      updated,
      group: groupName,
      stats: parsed.stats,
      scanner: parsed.meta,
      scope: audit.scope,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Report generation                                                          */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id/report',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);

    let template = audit.template;
    // Allow previewing against a different template without saving the choice.
    if (req.query.template) {
      template = await Template.findById(req.query.template);
      if (!template) throw notFound('Template not found');
    }
    if (!template) {
      throw badRequest('Assign a template to this engagement before generating a report.');
    }
    if (template.kind === 'html') {
      throw badRequest(
        `"${template.name}" is an HTML template. Open the print view to save it as a PDF.`
      );
    }

    const settings = await Settings.getSettings();
    const { buffer, filename, provenance } = await generateReport({
      audit,
      template,
      settings,
      // Feeds `{{ .generatedBy }}` in a document control table.
      user: req.user,
      // So the report can say "previously reported in PT-2025-004".
      history: await findingHistoryFor(audit, req.user),
      // And "this assessment took 6.5 person-days", from the hours actually logged.
      effort: await effortFor(audit._id),
      // The document-control table, from the deliveries the team recorded.
      deliveries: await deliveriesFor(audit._id, (value) =>
        formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
      ),
      // And "the API host was added on the 14th, agreed by Dana".
      scopeChanges: await scopeChangesFor(audit._id, (value) =>
        formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
      ),
      // And whether their side ever noticed. The date half uses this client's own pattern so
      // it reads like every other date in the document; the time is appended because a
      // detection log without minutes cannot answer the only question it is asked.
      detection: await detectionFor(audit._id, (value) =>
        formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
      ),
      // And, for a phishing engagement, who it went to and what happened.
      phishing: await phishingFor(audit._id, (value) =>
        formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
      ),
      // And the team's own signatures, as images for the sign-off page.
      signatures: await signaturesFor(audit._id, (value) =>
        formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
      ),
    });
    /*
     * What produced this file, kept so the question can be answered later.
     *
     * Never allowed to fail the download: the report is built and the person is waiting for it, and
     * a bookkeeping row is not worth throwing that away. The file carries the same render id in its
     * own properties, so even a lost record leaves the document self-describing.
     */
    await RenderRecord.create({
      ...provenance,
      kind: 'report',
      audit: audit._id,
    }).catch((error) => log.warn(`Could not record the render of ${filename}: ${error.message}`));

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.REPORT_GENERATED,
      meta: {
        template: template.name,
        /* On the activity entry too, so the feed can link a line to the exact render. */
        renderId: provenance.renderId,
        templateVersion: provenance.templateVersion,
      },
    });

    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Length', buffer.length);
    // Never interpolated raw: an engagement named with an em dash or an accent is
    // outside latin1, and Node refuses the header — failing the download after the
    // document had already been built.
    res.setHeader('Content-Disposition', contentDisposition(filename));
    // The digest of exactly these bytes, so "record this as sent" needs no retyping.
    attachDigest(res, buffer);
    res.end(buffer);
  })
);

/* -------------------------------------------------------------------------- */
/* Replacing a screenshot everywhere it appears                                */
/* -------------------------------------------------------------------------- */

/**
 * One file, in memory, with the same limits the media uploader applies.
 *
 * Declared here rather than shared with `media.routes.js` because the two do different jobs:
 * that one stores an image, this one stores an image *and* rewrites a document, and they
 * should not be able to drift into disagreeing about what is allowed.
 */
const replacementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(badRequest(`${file.mimetype || 'That file'} is not an image we can store`));
    }
    return cb(null, true);
  },
}).single('file');

/**
 * Retook a screenshot: put it everywhere the old one was.
 *
 * The alternative was uploading the new image and hunting through every finding, section and
 * note for the old reference by hand — which is exactly the job nobody finishes, so reports
 * went out with one figure updated and three stale.
 */
router.post(
  '/:id/media/:mediaId/replace',
  requireWrite,
  replacementUpload,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    if (!req.file) throw badRequest('No file was uploaded');

    /*
     * This rewrites the markup of every finding citing the image, so a lock anywhere in that set
     * blocks it. Checked before the upload rather than after: storing bytes nobody will reference
     * leaves an orphan for the sweeper to collect, for no reason.
     */
    for (const finding of audit.findings ?? []) {
      if (!finding.lockedBy) continue;
      const cites = ['description', 'observation', 'remediation', 'poc', 'scope'].some((field) =>
        String(finding[field] ?? '').includes(`/api/media/${req.params.mediaId}`)
      );
      if (cites) assertUnlocked(finding, req.user, await lockHolder(finding));
    }

    const stored = await saveMedia({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      filename: req.file.originalname,
      uploader: req.user,
      audit: audit._id,
    });

    if (String(stored.id) === String(req.params.mediaId)) {
      /*
       * The same bytes came back as the same stored object, so there is nothing to repoint.
       * Worth saying rather than reporting a successful replacement of an image by itself —
       * it usually means the wrong file was picked.
       */
      return res.json({
        id: stored.id,
        url: stored.url,
        replaced: 0,
        unchanged: true,
      });
    }

    const replaced = repointMedia(audit, req.params.mediaId, stored.id);
    if (replaced) await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.MEDIA_REPLACED,
      target: stored.originalName ?? req.file.originalname ?? 'a screenshot',
      meta: { places: replaced },
    });

    return res.json({
      id: stored.id,
      url: stored.url,
      width: stored.width,
      height: stored.height,
      /** How many places in this engagement now point at the new file. */
      replaced,
      unchanged: false,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Moving or copying a finding to another engagement                           */
/* -------------------------------------------------------------------------- */

const transferSchema = z.object({
  target: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Pick an engagement'),
  mode: z.enum(['move', 'copy']).optional().default('move'),
});

/**
 * The same visibility and editability rules as `loadAudit`, for an engagement named in the
 * body rather than the path.
 *
 * Written out rather than faked by rewriting `req.params`, because a transfer touches two
 * engagements and both have to be checked in their own right — the thing that makes this
 * route worth being careful about is precisely that it writes somewhere the URL does not
 * mention.
 */
async function loadOtherAudit(req, id) {
  const audit = await Audit.findById(id);
  if (!audit || audit.deletedAt) throw notFound('The other engagement was not found');
  if (req.user.role !== 'admin') {
    const uid = req.user._id.toString();
    const allowed = [
      audit.creator?.toString(),
      ...(audit.collaborators ?? []).map((entry) => entry.toString()),
      ...(audit.reviewers ?? []).map((entry) => entry.toString()),
    ];
    if (!allowed.includes(uid)) {
      throw forbidden('You are not on the engagement you are moving this finding to.');
    }
  }
  return audit;
}

/**
 * Moves or copies one finding onto another engagement.
 *
 * Lifted out of the route below so the bulk version cannot drift from it. Everything subtle about
 * a transfer is in here — which fields travel, when the evidence has to stay behind, who gets the
 * number — and a second copy of that in a batch handler would be wrong within a month.
 *
 * Saves neither engagement: a batch saves once at the end, and this returning before the write
 * means a caller can transfer twenty findings in two saves rather than forty.
 *
 * @returns {{landed: object, imagesRemoved: number, sameClient: boolean, title: string}}
 */
async function transferOneFinding({ source, target, finding, user, move }) {
  const title = finding.title;

  /*
   * Whether the evidence travels.
   *
   * A move is the same work, filed correctly, so its screenshots go with it — and the source is
   * not keeping them either way. A copy to the *same client* is still that client's own data. A
   * copy to a different client is the one case where the images have to stay behind, because the
   * alternative is one client's screenshot in another's report.
   */
  const sameClient = Boolean(source.company) && String(source.company) === String(target.company);
  const keepEvidence = move || sameClient;

  const copied = finding.toObject();
  delete copied._id;
  let imagesRemoved = 0;
  if (!keepEvidence) {
    for (const field of ['description', 'observation', 'remediation', 'poc', 'scope']) {
      const result = stripImages(copied[field] ?? '');
      copied[field] = result.html;
      imagesRemoved += result.removed;
    }
  }

  target.findings.push({
    ...copied,
    // Its number belongs to the engagement it is on, so the target allocates a new one.
    identifier: await nextIdentifier(target),
    sortIndex: (target.findings ?? []).length,
    /*
     * Review comments stay behind on purpose: they were a conversation about the other report,
     * and arriving as unanswered remarks on a new engagement is worse than losing them — the
     * source keeps them if this was a copy.
     */
    comments: [],
    // Authorship survives: whoever wrote it up still wrote it up.
    createdBy: finding.createdBy ?? null,
    updatedBy: user._id,
  });
  const landed = target.findings[target.findings.length - 1];

  if (move) {
    /*
     * Removed rather than trashed. The finding demonstrably still exists — it is on the other
     * engagement — and a restorable copy here would let somebody put back a second original
     * nobody wants.
     */
    finding.deleteOne();
  }

  return { landed, imagesRemoved, sameClient, title };
}

/**
 * Files a finding where it belongs.
 *
 * Two real situations: it was written on the wrong engagement, and the same issue turned up
 * on a second job for the same client. Both were done by hand — copy five rich-text fields
 * through the clipboard and lose the screenshots on the way — which is why findings quietly
 * stayed on the wrong engagement instead.
 */
router.post(
  '/:id/findings/:findingId/transfer',
  requireWrite,
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const source = await loadAudit(req, { populate: false });
    assertEditable(source, req.user);

    if (String(req.body.target) === String(source._id)) {
      throw badRequest('That is the engagement it is already on.');
    }
    const target = await loadOtherAudit(req, req.body.target);
    assertEditable(target, req.user);

    const finding = source.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');
    // A move takes it out from under whoever holds it; a copy leaves the original alone but still
    // reads a write-up somebody is in the middle of changing.
    assertUnlocked(finding, req.user, await lockHolder(finding));
    const move = req.body.mode !== 'copy';

    const { landed, imagesRemoved, sameClient, title } = await transferOneFinding({
      source,
      target,
      finding,
      user: req.user,
      move,
    });
    await target.save();
    if (move) await source.save();

    for (const [audit, direction, other] of [
      [source, move ? 'out' : 'copied-from', target],
      [target, 'in', source],
    ]) {
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.FINDING_TRANSFERRED,
        target: title,
        meta: {
          mode: move ? 'move' : 'copy',
          direction,
          other: other.reference || other.name,
        },
      });
    }

    res.status(201).json({
      mode: move ? 'move' : 'copy',
      target: String(target._id),
      targetName: target.name,
      targetReference: target.reference ?? '',
      findingId: String(landed._id),
      identifier: landed.identifier,
      /** Zero unless a copy crossed to another client, where evidence stays behind. */
      imagesRemoved,
      sameClient,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Promoting a finding into the library                                        */
/* -------------------------------------------------------------------------- */

/**
 * The fields of a finding that generalise, and the ones that never do.
 *
 * A library entry is a *reusable* write-up, so what makes this finding this client's has to
 * be left behind: the proof of concept, the affected hosts, and every screenshot. The detail
 * schema has no place for the first two, which is the schema being right — this only has to
 * take the images out of the prose.
 */
const LIBRARY_TEXT_FIELDS = ['description', 'observation', 'remediation'];

const promoteSchema = z.object({
  /** Which locale's body this becomes. Defaults to the engagement's own language. */
  locale: z.string().trim().min(2).max(10).optional(),
  category: z.string().trim().max(120).optional(),
  /** Update this existing entry instead of creating a second one. */
  replace: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

router.post(
  '/:id/findings/:findingId/promote',
  requireWrite,
  validate(promoteSchema),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    // The library is readable by everybody with an account, so a restricted engagement's text
    // does not go into it. See classification.service.js.
    assertMayPromoteToLibrary(audit);

    const finding = audit.findings?.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');

    const locale = req.body.locale ?? audit.language ?? 'en';
    const title = String(finding.title ?? '').trim();
    if (!title) throw badRequest('A finding needs a title before it can go in the library.');

    let removed = 0;
    const text = {};
    for (const field of LIBRARY_TEXT_FIELDS) {
      const result = stripImages(finding[field] ?? '');
      text[field] = result.html;
      removed += result.removed;
    }

    const detail = {
      locale,
      title,
      vulnType: finding.vulnType ?? '',
      ...text,
      references: [...(finding.references ?? [])],
      // Engagement-specific values are dropped; the *shape* of the fields is what is worth
      // keeping, so a promoted entry prompts for them next time rather than asserting last
      // time's answer.
      customFields: (finding.customFields ?? []).map((field) => ({
        key: field.key,
        label: field.label ?? '',
        fieldType: field.fieldType ?? 'input',
        value: '',
      })),
    };

    const shared = {
      cvssv3: finding.cvssv3,
      priority: finding.priority ?? null,
      remediationComplexity: finding.remediationComplexity ?? null,
      category: req.body.category ?? finding.category ?? '',
    };

    /*
     * An existing entry for the same issue is offered rather than silently duplicated.
     *
     * The library is only worth curating if it does not fill up with four versions of "SQL
     * injection", so a match by normalised title comes back as a 409 with the entry attached
     * — the same shape the app uses for a stale write — and the client decides whether to
     * update it or make a second entry on purpose.
     */
    if (!req.body.replace) {
      const needle = normaliseTitle(title);
      const candidates = await Vulnerability.find({ 'details.locale': locale }).select(
        'details.title details.locale category cvssv3'
      );
      const clash = candidates.find((entry) =>
        (entry.details ?? []).some(
          (row) => row.locale === locale && normaliseTitle(row.title ?? '') === needle
        )
      );
      if (clash) {
        throw new HttpError(409, 'The library already has an entry with this title.', {
          existing: {
            _id: clash._id,
            title: (clash.details ?? []).find((row) => row.locale === locale)?.title ?? '',
            category: clash.category ?? '',
          },
        });
      }
    }

    let entry;
    if (req.body.replace) {
      entry = await Vulnerability.findById(req.body.replace);
      if (!entry) throw notFound('That library entry no longer exists.');
      // The other locales are somebody else's translation work; only this one is replaced.
      const others = (entry.details ?? []).filter((row) => row.locale !== locale);
      entry.set({ ...shared, details: [...others, detail] });
      await entry.save();
    } else {
      entry = await Vulnerability.create({
        ...shared,
        details: [detail],
        createdBy: req.user._id,
      });
    }

    /*
     * The finding now points at the entry it produced.
     *
     * `finding.vulnerability` already exists for the other direction — a finding inserted
     * *from* the library — and filling it in here means the link is true whichever way the
     * text travelled.
     */
    if (!finding.vulnerability) {
      finding.vulnerability = entry._id;
      await audit.save();
    }

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.FINDING_PROMOTED,
      target: title,
      meta: { replaced: Boolean(req.body.replace), locale },
    });

    res.status(req.body.replace ? 200 : 201).json({
      vulnerability: entry._id,
      title,
      locale,
      replaced: Boolean(req.body.replace),
      /** So the UI can say what was left behind rather than implying a full copy. */
      imagesRemoved: removed,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Duplicating an engagement                                                   */
/* -------------------------------------------------------------------------- */

const duplicateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().max(80).optional().default(''),
  /** Defaults chosen so the copy is a fresh job of the same shape, not a copy of its work. */
  scope: z.boolean().optional().default(true),
  sections: z.boolean().optional().default(true),
  checks: z.boolean().optional().default(true),
  customFields: z.boolean().optional().default(true),
  team: z.boolean().optional().default(true),
  notes: z.boolean().optional().default(false),
  findings: z.boolean().optional().default(false),
});

/**
 * Another engagement of the same shape.
 *
 * What gets copied is the *setup* — client, team, scope, checklist, narrative, template —
 * and what does not is the *work*: no findings unless asked for, and never the record of
 * what happened. Sign-offs, deliveries, hours, bookings, credentials and the activity log
 * all belong to the job that earned them, and a copy that inherited them would be claiming
 * work it had not done.
 */
router.post(
  '/:id/duplicate',
  requireWrite,
  validate(duplicateSchema),
  asyncHandler(async (req, res) => {
    const source = await loadAudit(req, { populate: false });
    const options = req.body;

    const plain = source.toObject();
    let imagesRemoved = 0;

    const copyRich = (html) => {
      const result = stripImages(html ?? '');
      imagesRemoved += result.removed;
      return result.html;
    };

    const duplicate = new Audit({
      name: options.name ?? `${plain.name} (copy)`,
      reference: options.reference ?? '',
      auditType: plain.auditType,
      language: plain.language,
      company: plain.company ?? null,
      client: plain.client ?? null,
      recipients: [...(plain.recipients ?? [])],
      recipientRoles: (plain.recipientRoles ?? []).map(({ client, role }) => ({ client, role })),
      template: plain.template ?? null,
      // A copy always starts at the beginning, whatever state the original reached.
      state: 'EDIT',
      /*
       * But it keeps the marking. A restricted engagement whose copy is ordinary would be the
       * simplest possible way to launder it, and "duplicate, then work in the copy" is a normal
       * thing to do rather than a suspicious one.
       */
      classification: plain.classification ?? 'standard',
      classificationNote: plain.classificationNote ?? '',
      // Dates are the one thing a new job certainly does not share with the old one.
      date: '',
      date_start: '',
      date_end: '',
      creator: req.user._id,
      collaborators: options.team ? [...(plain.collaborators ?? [])] : [],
      // A copy of the team is a copy of its limits; without them a subcontractor's access
      // would quietly become permanent on the new engagement.
      memberUntil: options.team
        ? (plain.memberUntil ?? []).map(({ user, until }) => ({ user, until }))
        : [],
      reviewers: options.team ? [...(plain.reviewers ?? [])] : [],
      sortFindings: plain.sortFindings,
    });

    if (options.scope) duplicate.scope = (plain.scope ?? []).map(({ _id, ...rest }) => rest);

    if (options.sections) {
      duplicate.sections = (plain.sections ?? []).map(({ _id, ...section }) => ({
        ...section,
        text: copyRich(section.text),
      }));
    }

    if (options.customFields) {
      duplicate.customFields = (plain.customFields ?? []).map(({ _id, ...field }) => ({ ...field }));
    }

    if (options.checks) {
      // The checklist, not the ticks: a copied check claiming it was already verified is the
      // one thing worse than no checklist at all.
      duplicate.testChecks = (plain.testChecks ?? []).map(({ _id, ...check }) => ({
        title: check.title,
        description: check.description ?? '',
        category: check.category ?? '',
        createdBy: req.user._id,
        done: false,
        doneBy: null,
        doneAt: null,
        result: '',
      }));
    }

    if (options.notes) {
      duplicate.notes = (plain.notes ?? []).map(({ _id, ...note }) => ({
        ...note,
        content: copyRich(note.content),
        author: req.user._id,
        updatedBy: req.user._id,
      }));
    }

    if (options.findings) {
      duplicate.findings = (plain.findings ?? []).map(({ _id, ...finding }, index) => ({
        ...finding,
        /*
         * Numbered from one, not inherited.
         *
         * Identifiers are permanent *within* an engagement — a report cites VULN-03 — so a
         * copy must allocate its own rather than carry the originals, which would leave gaps
         * wherever a finding was not copied.
         */
        identifier: index + 1,
        description: copyRich(finding.description),
        observation: copyRich(finding.observation),
        remediation: copyRich(finding.remediation),
        poc: copyRich(finding.poc),
        scope: copyRich(finding.scope),
        // Whatever was fixed last time is open until this engagement says otherwise.
        remediationStatus: 'open',
        // Review notes were about the old report.
        comments: [],
        createdBy: req.user._id,
        updatedBy: req.user._id,
        sortIndex: index,
      }));
    }

    await duplicate.save();

    await recordActivity({
      audit: duplicate,
      actor: req.user,
      action: ACTIONS.AUDIT_CREATED,
      meta: { duplicatedFrom: plain.reference || plain.name },
    });
    // And on the original, so its history says it was used as a starting point.
    await recordActivity({
      audit: source,
      actor: req.user,
      action: ACTIONS.AUDIT_DUPLICATED,
      target: duplicate.name,
    });

    await duplicate.populate(POPULATE);
    res.status(201).json({
      audit: duplicate,
      /** Named so the UI can be honest about what did not come across. */
      imagesRemoved,
      copied: {
        scope: duplicate.scope?.length ?? 0,
        sections: duplicate.sections?.length ?? 0,
        checks: duplicate.testChecks?.length ?? 0,
        findings: duplicate.findings?.length ?? 0,
        notes: duplicate.notes?.length ?? 0,
      },
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Signatures — the team's own hand, for the sign-off page                     */
/* -------------------------------------------------------------------------- */

const signatureSchemaBody = z.object({
  /** A PNG data URI drawn in the browser. */
  image: z
    .string()
    .max(MAX_SIGNATURE_BYTES, 'That signature is too large — draw it rather than pasting a photo')
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/, 'A signature must be a drawn PNG'),
  name: z.string().trim().max(160).optional().default(''),
  title: z.string().trim().max(120).optional().default(''),
  role: z.string().trim().max(80).optional().default(''),
  statement: z.string().trim().max(500).optional().default(''),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date').optional(),
});

const signatureSummary = (row) => ({
  _id: row._id,
  user: row.user,
  image: row.image,
  name: row.name,
  title: row.title,
  role: row.role,
  statement: row.statement,
  signedOn: row.signedOn,
  signedAt: row.signedAt,
  updatedAt: row.updatedAt,
});

router.get(
  '/:id/signatures',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await Signature.find({ audit: audit._id })
      .populate({ path: 'user', select: 'username firstname lastname title' })
      .sort({ signedAt: 1 });

    /*
     * The caller's own most recent signature from somewhere else, so they can reuse it.
     *
     * Drawing your name with a mouse once is a novelty; doing it forty times a year is
     * friction. Only ever the caller's own — this is the same rule as signing, and a route that
     * handed back somebody else's drawing would be handing out a forgery kit.
     *
     * Omitted once they have signed here: at that point the useful action is "sign again", and
     * the pane already offers it.
     */
    const alreadySigned = rows.some((row) => String(row.user?._id ?? row.user) === String(req.user._id));
    const previous = alreadySigned
      ? null
      : await Signature.findOne({ user: req.user._id, audit: { $ne: audit._id } })
          .sort({ signedAt: -1 })
          .select('image title role statement signedOn');

    res.json({
      signatures: rows.map(signatureSummary),
      previous: previous
        ? {
            image: previous.image,
            title: previous.title,
            role: previous.role,
            statement: previous.statement,
            signedOn: previous.signedOn,
          }
        : null,
    });
  })
);

/**
 * Signs, or re-signs.
 *
 * Always for `req.user` — there is no route, and no admin override, that draws somebody else's
 * signature. That is the whole property being offered: a mark on a document that nobody but its
 * owner can put there. An upsert rather than a create, because signing again is correcting your
 * own mark, not adding a second one.
 */
router.post(
  '/:id/signatures',
  requireWrite,
  validate(signatureSchemaBody),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });

    /*
     * Deliberately not gated on `assertEditable`.
     *
     * An approved engagement is frozen for edits to the *report*, and signing it is the one
     * thing you would expect to do at exactly that point.
     */
    const today = new Date().toISOString().slice(0, 10);
    const row = await Signature.findOneAndUpdate(
      { audit: audit._id, user: req.user._id },
      {
        $set: {
          image: req.body.image,
          name: req.body.name || displayNameOf(req.user),
          title: req.body.title || req.user.title || '',
          role: req.body.role,
          statement: req.body.statement,
          signedOn: req.body.signedOn || today,
          signedAt: new Date(),
        },
        $setOnInsert: { audit: audit._id, user: req.user._id },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate({ path: 'user', select: 'username firstname lastname title' });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SIGNATURE_ADDED,
      target: row.name,
    });

    res.status(201).json(signatureSummary(row));
  })
);

/**
 * Removes a signature.
 *
 * Your own, always. An admin may remove somebody else's — a signature left behind by whoever
 * has since left the firm has to be removable by *someone* — but nobody can ever add or alter
 * one that is not theirs, which is the property that makes the mark worth anything.
 */
router.delete(
  '/:id/signatures/:signatureId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const row = await Signature.findOne({ _id: req.params.signatureId, audit: audit._id });
    if (!row) throw notFound('That signature was not found');

    const mine = String(row.user) === String(req.user._id);
    if (!mine && req.user.role !== 'admin') {
      throw forbidden('Only the person who signed, or an admin, can remove a signature.');
    }

    await Signature.deleteOne({ _id: row._id });
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SIGNATURE_REMOVED,
      target: row.name,
      meta: { mine },
    });
    res.json({ ok: true, id: req.params.signatureId });
  })
);

/** The name to print when somebody does not give one. */
function displayNameOf(user) {
  return (
    [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || 'Unnamed'
  );
}

/* -------------------------------------------------------------------------- */
/* Scope changes — what was agreed, and by whom                                */
/* -------------------------------------------------------------------------- */

const scopeChangeSchemaBody = z.object({
  kind: z.enum(SCOPE_CHANGE_KINDS).optional().default('added'),
  agreedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date'),
  summary: z.string().trim().min(1, 'Say what changed').max(500),
  targets: z.array(z.string().trim().max(200)).max(200).optional().default([]),
  agreedBy: z
    .object({
      client: z.string().regex(/^[0-9a-fA-F]{24}$/).nullish(),
      name: z.string().trim().max(160).optional().default(''),
    })
    .optional(),
  channel: z.string().trim().max(80).optional().default(''),
  note: z.string().trim().max(1000).optional().default(''),
});

const scopeChangeSummary = (row) => ({
  _id: row._id,
  kind: row.kind,
  agreedOn: row.agreedOn,
  summary: row.summary,
  targets: [...(row.targets ?? [])],
  agreedBy: { client: row.agreedBy?.client ?? null, name: row.agreedBy?.name ?? '' },
  channel: row.channel,
  note: row.note,
  recordedBy: row.recordedBy,
  createdAt: row.createdAt,
});

router.get(
  '/:id/scope-changes',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await ScopeChange.find({ audit: audit._id })
      .populate({ path: 'recordedBy', select: 'username firstname lastname' })
      .sort({ agreedOn: 1, createdAt: 1 });
    res.json({ scopeChanges: rows.map(scopeChangeSummary), kinds: SCOPE_CHANGE_KINDS });
  })
);

/**
 * Records a change to the scope.
 *
 * Not derived from watching the scope array: what matters is who agreed it and when, and a
 * diff cannot know either. The activity log already says that somebody edited the scope.
 */
router.post(
  '/:id/scope-changes',
  requireWrite,
  validate(scopeChangeSchemaBody),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await ScopeChange.create({
      ...req.body,
      audit: audit._id,
      recordedBy: req.user._id,
      updatedBy: req.user._id,
    });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SCOPE_CHANGE_RECORDED,
      target: row.summary,
      meta: { kind: row.kind, agreedOn: row.agreedOn },
    });

    await row.populate({ path: 'recordedBy', select: 'username firstname lastname' });
    res.status(201).json(scopeChangeSummary(row));
  })
);

router.put(
  '/:id/scope-changes/:changeId',
  requireWrite,
  validate(scopeChangeSchemaBody.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await ScopeChange.findOne({ _id: req.params.changeId, audit: audit._id });
    if (!row) throw notFound('That scope change was not found');

    row.set({ ...req.body, updatedBy: req.user._id });
    await row.save();
    await row.populate({ path: 'recordedBy', select: 'username firstname lastname' });
    res.json(scopeChangeSummary(row));
  })
);

router.delete(
  '/:id/scope-changes/:changeId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await ScopeChange.findOneAndDelete({
      _id: req.params.changeId,
      audit: audit._id,
    });
    if (!row) throw notFound('That scope change was not found');

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.SCOPE_CHANGE_REMOVED,
      target: row.summary,
    });
    res.json({ ok: true, id: req.params.changeId });
  })
);

/**
 * What has happened to one finding, in order.
 *
 * A lifecycle rather than an edit log: when it appeared, when its rating changed and why, when
 * its status moved and who moved it, what was said about it, and which delivered versions it was
 * in. Every keystroke is already in the engagement's activity feed and belongs there.
 */
router.get(
  '/:id/findings/:findingId/timeline',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);
    const finding = audit.findings.id(req.params.findingId);
    if (!finding) throw notFound('Finding not found');

    /*
     * Resolved here rather than in the shared populate list: who overrode a severity and who
     * moved a status are wanted by this one route, and every other load of an engagement would
     * pay for them. Without it the timeline prints a date with nobody's name against it.
     */
    await audit.populate([
      { path: 'findings.severityOverrideBy', select: 'username firstname lastname' },
      { path: 'findings.statusHistory.by', select: 'username firstname lastname' },
    ]);

    const deliveries = await Delivery.find({ audit: audit._id })
      .select('version sentAt')
      .sort({ sentAt: 1 });

    res.json(findingTimeline(finding.toObject(), deliveries.map((row) => row.toObject())));
  })
);

/* -------------------------------------------------------------------------- */
/* Hosts — the engagement seen the way it is actually worked                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything that lives outside the audit but belongs to one of its hosts.
 *
 * Read once and handed to the matcher, rather than queried per host: a board of forty assets
 * would otherwise be eighty queries to show four numbers each.
 */
async function hostContext(auditId) {
  const [detections, credentials] = await Promise.all([
    DetectionEvent.find({ audit: auditId }).select('action target occurredAt outcome noise'),
    // The label and URL only. A working view has no business reading the ciphertext.
    Credential.find({ audit: auditId }).select('label username url'),
  ]);
  return { detections, credentials };
}

router.get(
  '/:id/hosts',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    res.json(hostBoard(audit, await hostContext(audit._id)));
  })
);

router.get(
  '/:id/hosts/:key',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const detail = hostDetail(audit, req.params.key, await hostContext(audit._id));
    if (!detail) throw notFound('No asset in the scope has that address');
    res.json(detail);
  })
);

/**
 * Updates one host in place.
 *
 * Deliberately not a scope save. The scope editor replaces the whole array under optimistic
 * concurrency, which is right for editing the list and wrong for the working view: marking a host
 * tested must not depend on nobody else having touched a different group, and must not carry the
 * rest of the scope along with it.
 */
router.put(
  '/:id/hosts/:key',
  requireWrite,
  validate(
    z.object({
      status: z.enum(['pending', 'tested', 'excluded']).optional(),
      statusNote: z.string().trim().max(300).optional(),
      notes: z.string().max(8000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    // Either address resolves, the same way the read does — a link is followed with whichever
    // one the person was looking at, not with whichever one happens to be canonical.
    const wanted = String(req.params.key).trim().toLowerCase();
    let target = null;
    for (const group of audit.scope ?? []) {
      for (const host of group.hosts ?? []) {
        const matches = [host.ip, host.hostname]
          .filter(Boolean)
          .some((alias) => String(alias).trim().toLowerCase() === wanted);
        if (matches) {
          target = host;
          break;
        }
      }
      if (target) break;
    }
    if (!target) throw notFound('No asset in the scope has that address');

    const before = target.status;
    if (req.body.status !== undefined) target.status = req.body.status;
    if (req.body.statusNote !== undefined) target.statusNote = req.body.statusNote;
    if (req.body.notes !== undefined) target.notes = req.body.notes;
    await audit.save();

    // Only the status is worth a line in the log: it is the one that changes what the report
    // says. Working notes are a scratch pad, and logging every keystroke would bury everything.
    if (req.body.status !== undefined && req.body.status !== before) {
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.SCOPE_UPDATED,
        target: target.hostname || target.ip,
        meta: { from: before, to: req.body.status },
      });
    }

    res.json(hostDetail(audit, wanted, await hostContext(audit._id)));
  })
);

/* -------------------------------------------------------------------------- */
/* Archive — finished, and put away                                            */
/* -------------------------------------------------------------------------- */

/**
 * Puts an engagement away, or takes it back out.
 *
 * Visibility rather than permission: nothing is locked, and the engagement stays in every
 * historical view — the delivery register, the client's page, the insights. It only leaves the
 * places that are about work in progress.
 *
 * Allowed at any state. Most archived engagements are signed off, but a job that was cancelled or
 * never went anywhere is exactly the sort of thing somebody wants out of the list, and refusing
 * would mean it sat there for ever instead.
 */
router.post(
  '/:id/archive',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    if (audit.archivedAt) throw badRequest('That engagement is already archived.');

    audit.archivedAt = new Date();
    audit.archivedBy = req.user._id;
    await audit.save();

    await recordActivity({ audit, actor: req.user, action: ACTIONS.ARCHIVED });
    res.json({ archivedAt: audit.archivedAt });
  })
);

router.delete(
  '/:id/archive',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    if (!audit.archivedAt) throw badRequest('That engagement is not archived.');

    audit.archivedAt = null;
    audit.archivedBy = null;
    await audit.save();

    await recordActivity({ audit, actor: req.user, action: ACTIONS.UNARCHIVED });
    res.json({ archivedAt: null });
  })
);

/* -------------------------------------------------------------------------- */
/* Classification — how carefully this one has to be handled                   */
/* -------------------------------------------------------------------------- */

/**
 * Marks an engagement restricted, or takes the marking off.
 *
 * Raising it is an ordinary edit; lowering it is admin-only. The asymmetry is the whole design:
 * marking something sensitive should be frictionless, and the direction that *removes*
 * protection is the one worth a second person.
 */
router.put(
  '/:id/classification',
  requireWrite,
  validate(
    z.object({
      classification: z.enum(CLASSIFICATIONS),
      note: z.string().trim().max(300).optional().default(''),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const next = req.body.classification;
    const current = audit.classification ?? 'standard';
    if (next === current) return res.json({ classification: current });

    if (next === 'standard' && req.user.role !== 'admin') {
      throw forbidden(
        'Only an admin can take the restricted marking off an engagement. Ask one to do it.'
      );
    }

    audit.classification = next;
    audit.classificationNote = next === 'restricted' ? req.body.note : '';
    audit.classifiedBy = next === 'restricted' ? req.user._id : null;
    audit.classifiedAt = next === 'restricted' ? new Date() : null;
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: next === 'restricted' ? ACTIONS.RESTRICTED : ACTIONS.UNRESTRICTED,
      target: audit.classificationNote,
    });

    res.json({
      classification: audit.classification,
      classificationNote: audit.classificationNote,
      classifiedAt: audit.classifiedAt,
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Stop testing — the client rang                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everybody who would otherwise carry on working on it.
 *
 * The collaborators, plus anybody with a booking that has not finished — the second group is the
 * point. Somebody booked onto this from Monday is exactly the person who turns up and starts
 * testing something they were told on Friday to stop testing.
 *
 * Reviewers are left out: they are not doing the work, and a stand-down is not news they can act
 * on. The activity log records it for anybody who looks.
 */
async function peopleToStandDown(audit, actor) {
  const bookings = await Booking.find({
    audit: audit._id,
    end: { $gte: today() },
  }).select('user');

  const ids = [
    ...(audit.collaborators ?? []).map((person) => person?._id ?? person),
    ...bookings.map((booking) => booking.user),
    audit.creator,
  ]
    .filter(Boolean)
    .map(String);

  return [...new Set(ids)].filter(
    (id) =>
      id !== String(actor._id) &&
      // A notification pointing at an engagement they can no longer open is not a warning.
      !membershipExpired(audit, { _id: id, role: 'user' })
  );
}

/**
 * Stops work, loudly.
 *
 * Deliberately does not lock anything. Being told to stand down means stop *testing*; writing up
 * what you already did is usually the next thing asked for, and an app that froze the engagement
 * would push that work into a text file. It is a statement of fact and a warning, not a permission
 * change.
 */
router.post(
  '/:id/hold',
  requireWrite,
  validate(
    z.object({
      reason: z.string().trim().min(1, 'Say why work is stopping').max(500),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    if ((audit.holds ?? []).some((hold) => !hold.endedAt)) {
      throw badRequest('Work on this engagement is already stopped.');
    }

    audit.holds.push({
      reason: req.body.reason,
      startedAt: new Date(),
      startedBy: req.user._id,
    });
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.HELD,
      target: req.body.reason,
    });

    const recipients = await peopleToStandDown(audit, req.user);
    if (recipients.length) {
      await Notification.insertMany(
        recipients.map((id) => ({
          user: id,
          type: 'engagement-held',
          actor: req.user._id,
          audit: audit._id,
          auditName: audit.name ?? '',
          message: `Work on "${audit.name}" has stopped — ${req.body.reason}`,
          href: `/engagements/${audit._id}`,
        })),
        { ordered: false }
      );
    }

    res.json({ onHold: true, holds: audit.holds, notified: recipients.length });
  })
);

/** Starts it again, and says what changed. */
router.delete(
  '/:id/hold',
  requireWrite,
  validate(z.object({ resumeNote: z.string().trim().max(500).optional().default('') })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const open = (audit.holds ?? []).filter((hold) => !hold.endedAt).pop();
    if (!open) throw badRequest('Work on this engagement is not stopped.');

    open.endedAt = new Date();
    open.endedBy = req.user._id;
    open.resumeNote = req.body.resumeNote ?? '';
    await audit.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.RESUMED,
      target: open.resumeNote,
    });

    const recipients = await peopleToStandDown(audit, req.user);
    if (recipients.length) {
      await Notification.insertMany(
        recipients.map((id) => ({
          user: id,
          type: 'engagement-held',
          actor: req.user._id,
          audit: audit._id,
          auditName: audit.name ?? '',
          message: `Work on "${audit.name}" has restarted${
            open.resumeNote ? ` — ${open.resumeNote}` : ''
          }`,
          href: `/engagements/${audit._id}`,
        })),
        { ordered: false }
      );
    }

    res.json({ onHold: false, holds: audit.holds, notified: recipients.length });
  })
);

/* -------------------------------------------------------------------------- */
/* Recurrence — work that comes round again                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sets, changes or clears the schedule.
 *
 * Clearing is `months: null`, which also clears the due date rather than leaving a date nothing
 * will ever act on — a stale `nextDue` on a stopped recurrence is exactly the sort of leftover
 * that turns into a surprise notification a year later.
 */
router.put(
  '/:id/repeat',
  requireWrite,
  validate(
    z.object({
      months: z.number().int().min(1).max(60).nullable(),
      nextDue: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date')
        .optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    if (!req.body.months) {
      audit.repeat = { months: null, nextDue: '', remindedFor: '', createdNext: null };
    } else {
      const nextDue =
        req.body.nextDue ||
        audit.repeat?.nextDue ||
        // From the end of this engagement where there is one, because "a year after we finished"
        // is what an annual retest means — not a year after somebody set this up.
        advanceDue(audit.date_end || audit.date || today(), req.body.months);
      audit.repeat = {
        months: req.body.months,
        nextDue,
        // Re-arms the reminder whenever the date moves, so changing the schedule does not
        // silently inherit a "already told them" marker from the old one.
        remindedFor: audit.repeat?.nextDue === nextDue ? (audit.repeat?.remindedFor ?? '') : '',
        createdNext: audit.repeat?.createdNext ?? null,
      };
    }

    await audit.save();
    res.json({ repeat: audit.repeat });
  })
);

/* -------------------------------------------------------------------------- */
/* Kit — the things this engagement needs, and where they got to               */
/* -------------------------------------------------------------------------- */

const kitSchema = z.object({
  label: z.string().trim().min(1, 'Say what it is').max(160),
  kind: z.enum(KIT_KINDS).optional().default('hardware'),
  assetTag: z.string().trim().max(60).optional().default(''),
  status: z.enum(KIT_STATUSES).optional().default('needed'),
  quantity: z.number().int().min(1).max(999).optional().default(1),
  heldBy: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .nullish(),
  neededBy: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a yyyy-mm-dd date').optional(),
  dueBack: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a yyyy-mm-dd date').optional(),
  note: z.string().trim().max(500).optional().default(''),
});

const kitRow = (row) => ({
  _id: row._id,
  label: row.label,
  kind: row.kind,
  assetTag: row.assetTag,
  status: row.status,
  quantity: row.quantity,
  heldBy: row.heldBy,
  neededBy: row.neededBy,
  dueBack: row.dueBack,
  note: row.note,
  addedBy: row.addedBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const KIT_POPULATE = [
  { path: 'heldBy', select: 'username firstname lastname' },
  { path: 'addedBy', select: 'username firstname lastname' },
];

router.get(
  '/:id/kit',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await KitItem.find({ audit: audit._id })
      .populate(KIT_POPULATE)
      .sort({ createdAt: 1 });

    res.json({
      items: rows.map(kitRow),
      summary: kitSummary(rows, { startsOn: audit.date_start ?? '' }),
      /** Tagged items already out somewhere else — the double-booking worth knowing about. */
      clashes: await tagClashes(audit, req.user),
      kinds: KIT_KINDS,
      statuses: KIT_STATUSES,
      suggestions: KIT_SUGGESTIONS,
    });
  })
);

/**
 * Adds items.
 *
 * Takes a list, because that is how the list gets written — four things at once, or the seven
 * suggestions in one click. Nothing is deduplicated: two loaner laptops are two rows, and a firm
 * that genuinely needs two should not have to argue with the app about it.
 */
router.post(
  '/:id/kit',
  requireWrite,
  validate(z.object({ items: z.array(kitSchema).min(1).max(100) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const created = await KitItem.insertMany(
      req.body.items.map((item) => ({
        ...item,
        heldBy: item.heldBy || null,
        audit: audit._id,
        addedBy: req.user._id,
        updatedBy: req.user._id,
      }))
    );

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.KIT_ADDED,
      target: created.length === 1 ? created[0].label : '',
      meta: { added: created.length },
    });

    const rows = await KitItem.find({ audit: audit._id })
      .populate(KIT_POPULATE)
      .sort({ createdAt: 1 });
    res.status(201).json({
      added: created.length,
      items: rows.map(kitRow),
      summary: kitSummary(rows, { startsOn: audit.date_start ?? '' }),
    });
  })
);

router.put(
  '/:id/kit/:itemId',
  requireWrite,
  validate(kitSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await KitItem.findOne({ _id: req.params.itemId, audit: audit._id });
    if (!row) throw notFound('That item is not on this engagement');

    const before = row.status;
    row.set({ ...req.body, updatedBy: req.user._id });
    if (req.body.heldBy !== undefined) row.heldBy = req.body.heldBy || null;
    await row.save();

    /*
     * Only the two transitions worth a line in the log: something going out, and something not
     * coming back. The rest is somebody tidying a list.
     */
    if (row.status !== before && ['out', 'missing', 'returned'].includes(row.status)) {
      await recordActivity({
        audit,
        actor: req.user,
        action: row.status === 'missing' ? ACTIONS.KIT_MISSING : ACTIONS.KIT_MOVED,
        target: row.label,
        meta: { from: before, to: row.status },
      });
    }

    await row.populate(KIT_POPULATE);
    res.json(kitRow(row));
  })
);

router.delete(
  '/:id/kit/:itemId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await KitItem.findOneAndDelete({ _id: req.params.itemId, audit: audit._id });
    if (!row) throw notFound('That item is not on this engagement');
    res.json({ ok: true, id: req.params.itemId });
  })
);

/**
 * Where a tagged item is, across everything the caller can see.
 *
 * Declared before the parameterised route below or Express reads "where" as an item id.
 */
router.get(
  '/:id/kit-where/:tag',
  asyncHandler(async (req, res) => {
    // Loaded for the access check: asking where a box is should not be a way round it.
    await loadAudit(req, { populate: false });
    res.json({ tag: req.params.tag, seen: await whereIs(req.params.tag, req.user) });
  })
);

/* -------------------------------------------------------------------------- */
/* Phishing — the sending list, and what happened to each person               */
/* -------------------------------------------------------------------------- */

const targetSchema = z.object({
  email: z.string().trim().toLowerCase().email('That is not an email address').max(200),
  name: z.string().trim().max(160).optional().default(''),
  department: z.string().trim().max(120).optional().default(''),
  title: z.string().trim().max(120).optional().default(''),
  wave: z.string().trim().max(80).optional().default(''),
  sent: z.boolean().optional(),
  opened: z.boolean().optional(),
  clicked: z.boolean().optional(),
  phished: z.boolean().optional(),
  reported: z.boolean().optional(),
  note: z.string().trim().max(500).optional().default(''),
});

const targetRow = (row) => ({
  _id: row._id,
  email: row.email,
  name: row.name,
  department: row.department,
  title: row.title,
  wave: row.wave,
  sent: row.sent,
  opened: row.opened,
  clicked: row.clicked,
  phished: row.phished,
  reported: row.reported,
  outcome: outcomeOf(row),
  sentAt: row.sentAt,
  clickedAt: row.clickedAt,
  phishedAt: row.phishedAt,
  reportedAt: row.reportedAt,
  note: row.note,
});

router.get(
  '/:id/phishing',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await PhishingTarget.find({ audit: audit._id }).sort({
      phished: -1,
      email: 1,
    });
    res.json({ targets: rows.map(targetRow), summary: campaignSummary(rows) });
  })
);

/**
 * Adds people to the list.
 *
 * Takes one or many, because both ways of getting a list in are normal: typing a person somebody
 * forgot, and pasting the two hundred the client sent. An address already on the list is updated
 * rather than refused — re-pasting a list with three new people on it should add three people.
 */
router.post(
  '/:id/phishing',
  requireWrite,
  validate(z.object({ targets: z.array(targetSchema).min(1).max(5000) })),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const existing = new Set(
      (await PhishingTarget.find({ audit: audit._id }).select('email')).map((row) => row.email)
    );

    let added = 0;
    let updated = 0;
    for (const target of req.body.targets) {
      /*
       * The address is the filter and belongs only in the insert half.
       *
       * Mongo refuses a field named in both `$set` and `$setOnInsert` — and rightly: the two
       * would be saying different things about the same key on the same write.
       */
      const { email, ...rest } = target;
      await PhishingTarget.updateOne(
        { audit: audit._id, email },
        {
          $set: { ...rest, updatedBy: req.user._id },
          $setOnInsert: { audit: audit._id, email, addedBy: req.user._id },
        },
        { upsert: true }
      );
      if (existing.has(email)) updated += 1;
      else {
        added += 1;
        existing.add(email);
      }
    }

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.PHISHING_TARGETS_ADDED,
      meta: { added, updated },
    });

    const rows = await PhishingTarget.find({ audit: audit._id }).sort({ phished: -1, email: 1 });
    res.status(201).json({
      added,
      updated,
      targets: rows.map(targetRow),
      summary: campaignSummary(rows),
    });
  })
);

/**
 * Reads a results file from whatever sent the campaign.
 *
 * Tolerant on purpose — the file comes from somebody else's tool — and it answers with what it
 * understood: rows read, people matched, people added, rows it could not use and why. An import
 * you cannot check is one you cannot trust the second time.
 */
router.post(
  '/:id/phishing/import',
  requireWrite,
  uploadMemory,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const text = req.file ? req.file.buffer.toString('utf8') : req.body?.json;
    if (!text) throw badRequest('Choose a JSON file of results, or paste the JSON.');

    const report = await importResults(text, audit, req.user);

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.PHISHING_RESULTS_IMPORTED,
      meta: { rows: report.rows, added: report.added, updated: report.updated },
    });

    const rows = await PhishingTarget.find({ audit: audit._id }).sort({ phished: -1, email: 1 });
    res.json({ ...report, targets: rows.map(targetRow), summary: campaignSummary(rows) });
  })
);

router.put(
  '/:id/phishing/:targetId',
  requireWrite,
  validate(targetSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await PhishingTarget.findOne({ _id: req.params.targetId, audit: audit._id });
    if (!row) throw notFound('That recipient is not on the list');

    row.set({ ...req.body, updatedBy: req.user._id });
    await row.save();
    res.json(targetRow(row));
  })
);

router.delete(
  '/:id/phishing/:targetId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await PhishingTarget.findOneAndDelete({
      _id: req.params.targetId,
      audit: audit._id,
    });
    if (!row) throw notFound('That recipient is not on the list');
    res.json({ ok: true, id: req.params.targetId });
  })
);

/**
 * Clears the list.
 *
 * Worth having: a campaign scoped against the wrong mailing list is a thing that happens, and the
 * alternative is deleting two hundred rows one at a time.
 */
router.delete(
  '/:id/phishing',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const result = await PhishingTarget.deleteMany({ audit: audit._id });
    const removed = result.deletedCount ?? 0;
    if (removed) {
      await recordActivity({
        audit,
        actor: req.user,
        action: ACTIONS.PHISHING_LIST_CLEARED,
        meta: { removed },
      });
    }
    res.json({ ok: true, removed });
  })
);

/* -------------------------------------------------------------------------- */
/* Documents — the paperwork the client sent us                                */
/* -------------------------------------------------------------------------- */

const documentMetaSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS).optional().default('other'),
  note: z.string().trim().max(1000).optional().default(''),
  receivedFrom: z.string().trim().max(160).optional().default(''),
  receivedOn: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a yyyy-mm-dd date')
    .optional()
    .default(''),
});

const documentSummary = (row) => ({
  _id: row._id,
  filename: row.filename,
  kind: row.kind,
  note: row.note,
  receivedFrom: row.receivedFrom,
  receivedOn: row.receivedOn,
  bytes: row.bytes,
  declaredType: row.declaredType,
  sha256: row.sha256,
  uploadedBy: row.uploadedBy,
  createdAt: row.createdAt,
  downloads: row.downloads,
  lastDownloadAt: row.lastDownloadAt,
  lastDownloadBy: row.lastDownloadBy,
});

const DOCUMENT_POPULATE = [
  { path: 'uploadedBy', select: 'username firstname lastname' },
  { path: 'lastDownloadBy', select: 'username firstname lastname' },
];

router.get(
  '/:id/documents',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await EngagementDocument.find({ audit: audit._id })
      .populate(DOCUMENT_POPULATE)
      .sort({ createdAt: -1 });

    res.json({
      documents: rows.map(documentSummary),
      kinds: DOCUMENT_KINDS,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
  })
);

/**
 * Files in, metadata alongside.
 *
 * `uploadMemory` already caps the request; the service checks the size again against its own
 * limit, because the two exist for different reasons and the one that matters here is the one
 * this feature chose.
 */
router.post(
  '/:id/documents',
  requireWrite,
  uploadDocument,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    if (!req.file) throw badRequest('Choose a file to upload.');

    const meta = documentMetaSchema.parse({
      kind: req.body.kind,
      note: req.body.note,
      receivedFrom: req.body.receivedFrom,
      receivedOn: req.body.receivedOn,
    });

    const stored = await storeDocument({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      auditId: audit._id,
      uploadedBy: req.user._id,
    });

    const row = await EngagementDocument.create({
      ...meta,
      audit: audit._id,
      filename: stored.filename,
      file: stored.file,
      bytes: stored.bytes,
      sha256: stored.sha256,
      declaredType: req.file.mimetype ?? '',
      uploadedBy: req.user._id,
    });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.DOCUMENT_ADDED,
      target: row.filename,
      meta: { kind: row.kind },
    });

    await row.populate(DOCUMENT_POPULATE);
    res.status(201).json(documentSummary(row));
  })
);

/**
 * Hands the file back — always as an attachment, never as itself.
 *
 * The content type is ours to choose rather than the uploader's: a file a client named
 * `scope.html`, served from this origin with the type they claimed, would be stored cross-site
 * scripting wearing a document's clothes. Anything not on the short serveable list goes out as a
 * binary stream, `nosniff` is set, and the disposition is always `attachment`.
 */
router.get(
  '/:id/documents/:documentId/download',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const row = await EngagementDocument.findOne({
      _id: req.params.documentId,
      audit: audit._id,
    });
    if (!row) throw notFound('Document not found');

    const stream = await openDocument(row.file);

    // Who fetched a client's contract is worth a trail, the same way revealing a credential is.
    row.downloads += 1;
    row.lastDownloadAt = new Date();
    row.lastDownloadBy = req.user._id;
    await row.save();

    res.setHeader('Content-Type', serveableType(row.declaredType));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', row.bytes);
    res.setHeader('Content-Disposition', contentDisposition(safeFilename(row.filename)));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  })
);

router.put(
  '/:id/documents/:documentId',
  requireWrite,
  validate(documentMetaSchema.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await EngagementDocument.findOne({
      _id: req.params.documentId,
      audit: audit._id,
    });
    if (!row) throw notFound('Document not found');

    row.set(req.body);
    await row.save();
    await row.populate(DOCUMENT_POPULATE);
    res.json(documentSummary(row));
  })
);

router.delete(
  '/:id/documents/:documentId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await EngagementDocument.findOne({
      _id: req.params.documentId,
      audit: audit._id,
    });
    if (!row) throw notFound('Document not found');

    // Metadata first: a row pointing at bytes that are gone is worse than an orphaned file, and
    // the sweep for orphans is a smaller problem than a download that 404s halfway through.
    await EngagementDocument.deleteOne({ _id: row._id });
    await deleteDocumentFile(row.file);

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.DOCUMENT_REMOVED,
      target: row.filename,
    });
    res.json({ ok: true, id: req.params.documentId });
  })
);

/* -------------------------------------------------------------------------- */
/* Detection — what we did, and whether their side ever noticed                */
/* -------------------------------------------------------------------------- */

const detectionSchemaBody = z.object({
  action: z.string().trim().min(1, 'Say what you did').max(300),
  target: z.string().trim().max(300).optional().default(''),
  technique: z.string().trim().max(160).optional().default(''),
  /** A full instant, not a day: the whole point of this log is how long it took. */
  occurredAt: z.string().datetime({ offset: true }),
  outcome: z.enum(DETECTION_OUTCOMES).optional().default('unknown'),
  noise: z.enum(DETECTION_NOISE).optional().default('standard'),
  detectedAt: z.string().datetime({ offset: true }).nullish(),
  respondedAt: z.string().datetime({ offset: true }).nullish(),
  source: z.string().trim().max(200).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
  finding: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .nullish(),
});

/** The latencies come back computed, so the tab never subtracts two dates itself. */
const detectionSummaryRow = (row) => {
  const detect = detectionLatency(row);
  const respond = responseLatency(row);
  return {
    _id: row._id,
    action: row.action,
    target: row.target,
    technique: row.technique,
    occurredAt: row.occurredAt,
    outcome: row.outcome,
    noise: row.noise,
    detectedAt: row.detectedAt,
    respondedAt: row.respondedAt,
    detectionLatency: describeLatency(detect),
    detectionLatencyMinutes: detect,
    responseLatency: describeLatency(respond),
    responseLatencyMinutes: respond,
    source: row.source,
    notes: row.notes,
    finding: row.finding,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const DETECTION_POPULATE = { path: 'recordedBy', select: 'username firstname lastname' };

/**
 * Refuses a save whose times contradict each other, with the sentence that says why.
 *
 * The model holds the same line, so a script cannot get round it — but a 422 titled
 * "Validation failed" is a worse answer to a mistyped hour than the sentence itself.
 */
const assertDetectionMakesSense = (row) => {
  const [problem] = detectionProblems(row);
  if (problem) throw badRequest(problem);
};

router.get(
  '/:id/detections',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await DetectionEvent.find({ audit: audit._id })
      .populate(DETECTION_POPULATE)
      .sort({ occurredAt: -1, createdAt: -1 });

    res.json({
      detections: rows.map(detectionSummaryRow),
      /** Computed server-side so the tab and the report can never disagree. */
      summary: detectionSummary(rows),
      /** The vocabularies, so the form is built from the schema rather than a copy of it. */
      outcomes: DETECTION_OUTCOMES.map((value) => ({
        value,
        label: DETECTION_OUTCOME_LABELS[value],
      })),
      noiseLevels: DETECTION_NOISE.map((value) => ({
        value,
        label: DETECTION_NOISE_LABELS[value],
      })),
    });
  })
);

router.post(
  '/:id/detections',
  requireWrite,
  validate(detectionSchemaBody),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);
    assertDetectionMakesSense(req.body);

    // A finding id has to belong to *this* engagement; anything else is a link that
    // would silently point at nothing the moment somebody clicked it.
    if (req.body.finding && !audit.findings.id(req.body.finding)) {
      throw badRequest('That finding is not part of this engagement');
    }

    const row = await DetectionEvent.create({
      ...req.body,
      audit: audit._id,
      recordedBy: req.user._id,
      updatedBy: req.user._id,
    });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.DETECTION_RECORDED,
      target: row.action,
      meta: { outcome: DETECTION_OUTCOME_LABELS[row.outcome], noise: row.noise },
    });

    await row.populate(DETECTION_POPULATE);
    res.status(201).json(detectionSummaryRow(row));
  })
);

router.put(
  '/:id/detections/:eventId',
  requireWrite,
  validate(detectionSchemaBody.partial()),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await DetectionEvent.findOne({ _id: req.params.eventId, audit: audit._id });
    if (!row) throw notFound('That logged action was not found');

    if (req.body.finding && !audit.findings.id(req.body.finding)) {
      throw badRequest('That finding is not part of this engagement');
    }

    row.set({ ...req.body, updatedBy: req.user._id });
    // Checked after the merge, because an edit that only moves `detectedAt` is still an
    // edit whose result has to hold against the `occurredAt` already stored.
    assertDetectionMakesSense(row);
    await row.save();

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.DETECTION_UPDATED,
      target: row.action,
      meta: { outcome: DETECTION_OUTCOME_LABELS[row.outcome] },
    });

    await row.populate(DETECTION_POPULATE);
    res.json(detectionSummaryRow(row));
  })
);

router.delete(
  '/:id/detections/:eventId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    assertEditable(audit, req.user);

    const row = await DetectionEvent.findOneAndDelete({
      _id: req.params.eventId,
      audit: audit._id,
    });
    if (!row) throw notFound('That logged action was not found');

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.DETECTION_REMOVED,
      target: row.action,
    });
    res.json({ ok: true, id: req.params.eventId });
  })
);

/* -------------------------------------------------------------------------- */
/* Delivery record — what was sent, to whom, and which file exactly            */
/* -------------------------------------------------------------------------- */

/**
 * The digest of a file this app just produced, on the response that carries it.
 *
 * Sent as a header so the browser can record a delivery without hashing the download again
 * — and so the value in the record is demonstrably the file that left the server, not one
 * computed from something the user picked out of a downloads folder afterwards.
 */
function attachDigest(res, buffer) {
  const digest = createHash('sha256').update(buffer).digest('hex');
  res.setHeader('X-Report-Sha256', digest);
  res.setHeader('X-Report-Size', String(buffer.length));
  // Two headers plus the filename: everything the delivery form needs to prefill itself.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Report-Sha256, X-Report-Size');
  return digest;
}

/**
 * A recipient on a delivery.
 *
 * `client` is optional because a report sometimes goes to somebody who is not in the
 * contact list — a procurement mailbox, an auditor. The name and address are stored
 * literally either way, so the record still reads correctly after that contact is renamed
 * or deleted.
 */
const deliveryRecipientSchema = z.object({
  client: z.string().regex(/^[0-9a-fA-F]{24}$/).nullish(),
  name: z.string().trim().max(160).optional().default(''),
  email: z.string().trim().toLowerCase().max(200).optional().default(''),
});

const deliverySchemaBody = z.object({
  version: z.string().trim().max(40).optional().default(''),
  /** An instant, not a day: "sent at 17:40 on Friday" is the fact being recorded. */
  sentAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
  channel: z.enum(DELIVERY_CHANNELS).optional().default('email'),
  recipients: z.array(deliveryRecipientSchema).max(50).optional().default([]),
  filename: z.string().trim().max(260).optional().default(''),
  fileHash: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([a-f0-9]{64})?$/, 'A SHA-256 hash is 64 hexadecimal characters')
    .optional()
    .default(''),
  fileSize: z.number().int().min(0).nullish(),
  kind: z.string().trim().max(20).optional().default(''),
  note: z.string().trim().max(1000).optional().default(''),
});

const DELIVERY_POPULATE = [
  { path: 'sentBy', select: 'username firstname lastname' },
  { path: 'createdBy', select: 'username firstname lastname' },
];

const deliverySummary = (row) => ({
  _id: row._id,
  version: row.version,
  sentAt: row.sentAt,
  channel: row.channel,
  recipients: (row.recipients ?? []).map((entry) => ({
    client: entry.client ?? null,
    name: entry.name,
    email: entry.email,
  })),
  filename: row.filename,
  hashAlgorithm: row.hashAlgorithm,
  fileHash: row.fileHash,
  fileSize: row.fileSize,
  kind: row.kind,
  note: row.note,
  contentFingerprint: row.contentFingerprint ?? '',
  sentBy: row.sentBy,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * A date the client sent us, without trusting it to be well formed.
 *
 * `datetime-local` inputs submit "2026-08-06T17:40" with no zone, which `new Date()` reads
 * as local time — which is what the person typing it meant.
 */
const parseSentAt = (value) => {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw badRequest('That is not a date and time.');
  return at;
};

router.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    const rows = await Delivery.find({ audit: audit._id })
      .populate(DELIVERY_POPULATE)
      .sort({ sentAt: -1, createdAt: -1 });

    res.json({
      deliveries: rows.map(deliverySummary),
      channels: DELIVERY_CHANNELS,
      /**
       * The next version, suggested rather than imposed: the minor part of the newest
       * record, bumped. A first delivery gets 1.0.
       */
      suggestedVersion: nextVersion(rows.map((row) => row.version)),
    });
  })
);

/**
 * Guesses the next version from the ones already recorded.
 *
 * Only handles the shape almost everybody uses — `1`, `1.0`, `2.13` — and gives up rather
 * than mangling anything else, because "draft 2 (post-retest)" is a version somebody chose
 * on purpose and an app that renamed it would be wrong twice.
 */
function nextVersion(versions) {
  const numeric = versions
    .map((version) => /^(\d+)(?:\.(\d+))?$/.exec(String(version ?? '').trim()))
    .filter(Boolean)
    .map((match) => [Number(match[1]), Number(match[2] ?? 0)]);
  if (!numeric.length) return versions.length ? '' : '1.0';
  const [major, minor] = numeric.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return `${major}.${minor + 1}`;
}

router.post(
  '/:id/deliveries',
  validate(deliverySchemaBody),
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req, { populate: false });
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const row = await Delivery.create({
      ...req.body,
      sentAt: parseSentAt(req.body.sentAt),
      audit: audit._id,
      // What the report said at this moment, so "changed since" is later answerable exactly
      // rather than inferred from an `updatedAt` that any note moves.
      contentFingerprint: audit.contentFingerprint ?? '',
      sentBy: req.user._id,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    /*
     * In the engagement's log, unlike time entries: a report leaving the building is exactly
     * the kind of occasional, consequential event an activity log exists for.
     */
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.REPORT_DELIVERED,
      target: row.version || row.filename || 'the report',
      meta: { recipients: row.recipients.length, channel: row.channel },
    });

    await row.populate(DELIVERY_POPULATE);
    res.status(201).json(deliverySummary(row));
  })
);

/** Loads a delivery on an engagement the caller can open. */
async function loadDelivery(req) {
  const audit = await loadAudit(req, { populate: false });
  const row = await Delivery.findOne({ _id: req.params.deliveryId, audit: audit._id });
  if (!row) throw notFound('Delivery not found');
  return { audit, row };
}

/**
 * Corrections only.
 *
 * Everything is editable because the common mistake is a typo in a version or the wrong
 * time, and a record nobody can fix is a record people keep beside the app instead. Who
 * recorded it and when are not editable, so the correction is itself attributable.
 */
router.put(
  '/:id/deliveries/:deliveryId',
  validate(deliverySchemaBody.partial()),
  asyncHandler(async (req, res) => {
    const { row } = await loadDelivery(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const patch = { ...req.body, updatedBy: req.user._id };
    if (req.body.sentAt) patch.sentAt = parseSentAt(req.body.sentAt);
    row.set(patch);
    await row.save();

    await row.populate(DELIVERY_POPULATE);
    res.json(deliverySummary(row));
  })
);

/**
 * Removal is for a row entered by mistake, and is the creator's or an admin's call.
 *
 * Anybody on the engagement can *record* a delivery — the person who sent it usually is not
 * the lead — but deleting the evidence that something was sent is a different act, and it
 * goes in the log.
 */
router.delete(
  '/:id/deliveries/:deliveryId',
  asyncHandler(async (req, res) => {
    const { audit, row } = await loadDelivery(req);
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');

    const isCreator = String(audit.creator ?? '') === String(req.user._id);
    if (req.user.role !== 'admin' && !isCreator) {
      throw forbidden('Only the engagement creator or an admin can remove a delivery record.');
    }

    await Delivery.deleteOne({ _id: row._id });
    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.REPORT_DELIVERY_REMOVED,
      target: row.version || row.filename || 'a delivery record',
    });
    res.json({ ok: true, id: req.params.deliveryId });
  })
);

/**
 * The findings as a spreadsheet — the remediation tracker the client would otherwise build
 * by hand from the PDF.
 *
 * No template involved: this is data, not a document, so there is nothing to design and
 * nothing to assign. It uses the same report data the .docx does, so the ids, dates,
 * severities and recurrence notes cannot disagree with the report it arrives beside.
 */
router.get(
  '/:id/findings.xlsx',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);
    const settings = await Settings.getSettings();
    const { buffer, filename } = buildFindingsSheet({
      audit,
      settings,
      user: req.user,
      history: await findingHistoryFor(audit, req.user),
    });

    await recordActivity({
      audit,
      actor: req.user,
      action: ACTIONS.REPORT_GENERATED,
      meta: { template: 'Findings spreadsheet' },
    });

    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', contentDisposition(filename));
    // A tracker gets sent to clients too, so it can be recorded as a delivery like any
    // other file.
    attachDigest(res, buffer);
    res.end(buffer);
  })
);

/**
 * Renders the engagement through an HTML template and returns the page itself.
 *
 * Served as a document rather than JSON so the client can drop it straight into
 * an iframe for preview and printing. `X-Frame-Options: SAMEORIGIN` keeps that
 * possible while stopping anyone else from framing a client's report.
 */
router.get(
  '/:id/report.html',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);

    let template = audit.template;
    if (req.query.template) {
      template = await Template.findById(req.query.template);
      if (!template) throw notFound('Template not found');
    }
    if (!template) {
      throw badRequest('Assign an HTML template to this engagement first.');
    }
    if (template.kind !== 'html') {
      throw badRequest(
        `"${template.name}" is a Word template. Use Generate report for .docx output.`
      );
    }

    const settings = await Settings.getSettings();
    // No DocxAssembler: the html target needs no relationship bookkeeping.
    const data = buildReportData(
      audit,
      settings,
      { parts: null, numbering: null },
      {
        target: 'html',
        user: req.user,
        templateName: template.name,
        history: await findingHistoryFor(audit, req.user),
        effort: await effortFor(audit._id),
        deliveries: await deliveriesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
        scopeChanges: await scopeChangesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
        detection: await detectionFor(audit._id, (value) =>
          formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
        ),
        phishing: await phishingFor(audit._id, (value) =>
          formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
        ),
        signatures: await signaturesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
      }
    );
    /*
     * Shared blocks first, then the tags.
     *
     * In that order because a partial contains tags of its own — a letterhead prints the client's
     * name — and expanding after rendering would leave them as literal braces in the output.
     */
    const { html: withPartials, warnings: partialWarnings } = await expandPartials(
      template.html,
      await partialResolver()
    );
    for (const warning of partialWarnings) {
      log.warn(`${template.name}: ${warning}`);
    }
    let html = renderHtmlReport(withPartials, data, {
      dateFormat: settings.report?.public?.dateFormat,
    });

    // Evidence travels with the document: this response is what gets printed to
    // PDF or saved and sent on, where /api/media links would be dead.
    const media = await loadMediaMap(mediaIdsInAudit(audit));
    html = inlineMediaInHtml(html, media);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.send(html);
  })
);

/** Returns the resolved data object — the fastest way to debug a template. */
router.get(
  '/:id/report-data',
  asyncHandler(async (req, res) => {
    const audit = await loadAudit(req);
    const settings = await Settings.getSettings();
    // No assembler: rich fields resolve without media handling. `target` lets a
    // template author inspect exactly what their kind of template will receive.
    const target = req.query.target === 'html' ? 'html' : 'docx';
    const data = buildReportData(
      audit,
      settings,
      { parts: null, numbering: null },
      {
        target,
        history: await findingHistoryFor(audit, req.user),
        effort: await effortFor(audit._id),
        deliveries: await deliveriesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
        scopeChanges: await scopeChangesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
        detection: await detectionFor(audit._id, (value) =>
          formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
        ),
        phishing: await phishingFor(audit._id, (value) =>
          formatDate(value, `${resolveReportSettings(settings, audit.company).dateFormat} HH:mm`)
        ),
        signatures: await signaturesFor(audit._id, (value) =>
          formatDate(value, resolveReportSettings(settings, audit.company).dateFormat)
        ),
      }
    );
    res.json(data);
  })
);

export default router;
