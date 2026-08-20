import { Router } from 'express';
import { z } from 'zod';

import { Company } from '../models/company.model.js';
import { Client } from '../models/client.model.js';
import { Audit, ENGAGEMENT_KINDS } from '../models/audit.model.js';
// The client timeline is assembled from what these already record, rather than from a log of its own.
import { Proposal } from '../models/proposal.model.js';
import { Delivery } from '../models/delivery.model.js';
import { SalesActivity } from '../models/sales-activity.model.js';
import asyncHandler from '../utils/async-handler.js';
import { notFound } from '../utils/http-error.js';
import {
  visibleAuditFilter,
  visibleClientFilter,
  visibleCompanyFilter,
} from '../utils/audit-scope.js';
import { calculateCvss, findingSeverity } from '../services/cvss.js';
import { recurringIssues } from '../services/finding-history.service.js';
import {
  Language,
  AuditType,
  VulnerabilityType,
  VulnerabilityCategory,
  SectionDefinition,
} from '../models/taxonomy.model.js';
import { CustomField, FIELD_TYPES, FIELD_VIEWS } from '../models/custom-field.model.js';
import { crudRouter } from './crud.factory.js';
import { assertCompanyUnused, assertContactUnused } from '../services/references.service.js';

const router = Router();

/** A required id, for the arrays a blueprint holds. */
const idString = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');

const objectId = idString.nullable().optional();

/** Keys used inside templates must be safe identifiers. */
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Use letters, digits and underscore; must not start with a digit');

/* -------------------------------- companies ------------------------------- */

/**
 * Everything about one client in one place: their contacts, and every engagement
 * you have run for them.
 *
 * A client is rarely one engagement — it is a first assessment, a retest, then next
 * year's — and until now those were only visible as unrelated rows in a flat list
 * with the client's name repeated. Declared before the CRUD router below so this
 * path is matched first.
 */
router.get(
  '/companies/:id/overview',
  asyncHandler(async (req, res) => {
    // Scoped, not just found: the engagement list below was already filtered, but
    // without this the page still confirmed the client exists and showed their
    // address and contacts to somebody with no engagement for them.
    const company = await Company.findOne({
      _id: req.params.id,
      ...(await visibleCompanyFilter(req.user)),
    });
    if (!company) throw notFound('Client not found');

    const [contacts, audits] = await Promise.all([
      Client.find({ company: company._id }).sort({ lastname: 1, firstname: 1 }),
      Audit.find(visibleAuditFilter(req.user, { company: company._id }))
        // Only the finding fields the counts and the recurrence check need. The whole
        // findings array meant every screenshot-laden description crossed the wire to
        // draw a severity bar.
        .select(
          'name reference auditType state date date_start date_end createdAt updatedAt ' +
            'findings._id findings.title findings.cvssv3 findings.remediationStatus findings.vulnerability ' +
            'testChecks.done template creator collaborators'
        )
        .populate([
          { path: 'template', select: 'name kind' },
          { path: 'creator', select: 'username firstname lastname' },
          { path: 'collaborators', select: 'username firstname lastname' },
        ])
        .sort({ updatedAt: -1 }),
    ]);

    const zero = () => ({ critical: 0, high: 0, medium: 0, low: 0, none: 0 });
    const totals = {
      engagements: audits.length,
      findings: 0,
      severityCounts: zero(),
      remediation: { open: 0, retesting: 0, fixed: 0 },
      openSerious: 0,
    };

    const engagements = audits.map((audit) => {
      const severityCounts = zero();
      const remediation = { open: 0, retesting: 0, fixed: 0 };

      for (const finding of audit.findings ?? []) {
        const severity = findingSeverity(finding).severity;
        const key = severity === 'None' ? 'none' : severity.toLowerCase();
        if (key in severityCounts) {
          severityCounts[key] += 1;
          totals.severityCounts[key] += 1;
        }
        const status = ['open', 'retesting', 'fixed'].includes(finding.remediationStatus)
          ? finding.remediationStatus
          : 'open';
        remediation[status] += 1;
        totals.remediation[status] += 1;
        totals.findings += 1;
        if (status !== 'fixed' && (key === 'critical' || key === 'high')) totals.openSerious += 1;
      }

      const checks = audit.testChecks ?? [];
      const object = audit.toObject();
      delete object.findings;
      delete object.testChecks;

      return {
        ...object,
        findingCount: (audit.findings ?? []).length,
        severityCounts,
        remediation,
        checks: { done: checks.filter((c) => c.done).length, total: checks.length },
      };
    });

    // What keeps coming back. Computed over the same engagements already loaded, so
    // the page costs no extra query.
    const recurring = recurringIssues(audits);
    totals.recurring = recurring.length;
    totals.recurringOpen = recurring.filter((issue) => issue.stillOpen).length;

    res.json({ company, contacts, engagements, totals, recurring });
  })
);

/**
 * Everything that has happened with one client, in order.
 *
 * Before a call, what somebody wants is the history of the relationship: when we last spoke, what we
 * quoted, what we lost and why, which report they have and what version it was. That story is
 * currently spread across four pages and two sections of the app, and reconstructing it in the thirty
 * seconds before dialling is how people end up asking a client something the client already told us.
 *
 * Assembled from what is already recorded rather than from a new log: proposals and their status
 * history, engagements, the deliveries that say which version of which report actually went out, the
 * contacts as they were added, and the sales log for the things none of those cover. Nothing here is
 * written by this route — a timeline that needed its own table would be a second version of the truth,
 * and the first thing to fall out of step.
 */
router.get(
  '/companies/:id/timeline',
  asyncHandler(async (req, res) => {
    const company = await Company.findOne({
      _id: req.params.id,
      ...(await visibleCompanyFilter(req.user)),
    }).select('name');
    if (!company) throw notFound('Client not found');

    const audits = await Audit.find(visibleAuditFilter(req.user, { company: company._id }))
      .select('name reference state createdAt')
      .sort({ createdAt: -1 })
      .limit(200);
    const auditIds = audits.map((audit) => audit._id);

    const [proposals, deliveries, contacts, sales] = await Promise.all([
      Proposal.find({ company: company._id })
        .select('reference title status outcome history createdAt owner')
        .populate([
          { path: 'owner', select: 'username firstname lastname' },
          { path: 'history.by', select: 'username firstname lastname' },
          { path: 'outcome.by', select: 'username firstname lastname' },
        ])
        .sort({ createdAt: -1 })
        .limit(100),
      Delivery.find({ audit: { $in: auditIds } })
        .select('audit version sentAt channel recipients note sentBy')
        .populate({ path: 'sentBy', select: 'username firstname lastname' })
        .sort({ sentAt: -1 })
        .limit(200),
      Client.find({ company: company._id }).select('firstname lastname email title createdAt'),
      /*
       * Only the actions the rest of this does not already tell: a proposal's own history is richer
       * than the log entry about it, and printing both would read as everything happening twice.
       */
      SalesActivity.find({
        company: company._id,
        action: { $in: ['client.added', 'client.updated', 'kickoff.recorded', 'estimate.set'] },
      })
        .select('action summary target createdAt actor')
        .populate({ path: 'actor', select: 'username firstname lastname' })
        .sort({ createdAt: -1 })
        .limit(100),
    ]);

    const named = (user) =>
      user
        ? [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username || ''
        : '';
    const auditName = new Map(audits.map((audit) => [String(audit._id), audit.name]));
    const events = [];

    for (const proposal of proposals) {
      events.push({
        at: proposal.createdAt,
        kind: 'proposal',
        title: `Proposal raised — ${proposal.title}`,
        detail: proposal.reference,
        actor: named(proposal.owner),
        link: `/proposals/${proposal._id}`,
      });
      for (const entry of proposal.history ?? []) {
        // The raise itself is already above; a from-nothing entry would repeat it.
        if (!entry.from) continue;
        const closing = entry.to === 'accepted' || entry.to === 'declined';
        events.push({
          at: entry.at,
          kind: closing ? (entry.to === 'declined' ? 'lost' : 'won') : 'proposal',
          title:
            entry.to === 'declined'
              ? `Lost — ${proposal.reference}`
              : entry.to === 'accepted'
                ? `Won — ${proposal.reference}`
                : `${proposal.reference}: ${entry.from} → ${entry.to}`,
          detail: [
            closing ? proposal.outcome?.reason : '',
            closing ? proposal.outcome?.competitor : '',
            entry.note,
          ]
            .filter(Boolean)
            .join(' · '),
          actor: named(entry.by),
          link: `/proposals/${proposal._id}`,
        });
      }
    }

    for (const audit of audits) {
      events.push({
        at: audit.createdAt,
        kind: 'engagement',
        title: `Engagement started — ${audit.name}`,
        detail: audit.reference ?? '',
        actor: '',
        link: `/engagements/${audit._id}`,
      });
    }

    for (const delivery of deliveries) {
      events.push({
        at: delivery.sentAt,
        kind: 'delivery',
        title: `Report ${delivery.version || 'sent'} — ${auditName.get(String(delivery.audit)) ?? 'an engagement'}`,
        detail: [
          (delivery.recipients ?? []).map((person) => person.name || person.email).filter(Boolean).join(', '),
          delivery.channel,
          delivery.note,
        ]
          .filter(Boolean)
          .join(' · '),
        actor: named(delivery.sentBy),
        link: `/engagements/${delivery.audit}?tab=delivery`,
      });
    }

    for (const contact of contacts) {
      events.push({
        at: contact.createdAt,
        kind: 'contact',
        title: `Contact added — ${[contact.firstname, contact.lastname].filter(Boolean).join(' ') || contact.email}`,
        detail: [contact.title, contact.email].filter(Boolean).join(' · '),
        actor: '',
        link: '/data',
      });
    }

    for (const entry of sales) {
      events.push({
        at: entry.createdAt,
        kind: 'note',
        title: entry.summary || entry.action,
        detail: entry.target ?? '',
        actor: named(entry.actor),
        link: '',
      });
    }

    events.sort((a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0));

    res.json({
      company: { id: company._id, name: company.name },
      counts: {
        proposals: proposals.length,
        engagements: audits.length,
        deliveries: deliveries.length,
        contacts: contacts.length,
      },
      /** Capped: a decade of a big client is not something anybody scrolls. */
      events: events.filter((event) => event.at).slice(0, 200),
    });
  })
);

router.use(
  '/companies',
  crudRouter({
    model: Company,
    sort: { name: 1 },
    // A client is only visible to people who work with them. Without this, every
    // account could read the full customer list off the Clients & data page.
    scopeQuery: (req) => visibleCompanyFilter(req.user),
    ownerField: 'createdBy',
    // The same rule the Sales section uses: refuse while anything still points at it, and say
    // what. One definition, two doors — see references.service.js.
    beforeDelete: (company) => assertCompanyUnused(company._id),
    createSchema: z.object({
      name: z.string().trim().min(1, 'Name is required').max(120),
      shortName: z.string().trim().max(60).optional().default(''),
      logo: z.string().max(4_000_000).optional().default(''),
      address: z.string().trim().max(500).optional().default(''),
      website: z.string().trim().max(200).optional().default(''),
      /*
       * Presentation overrides for this client's reports. Empty means "use the instance
       * default", which is why every field is optional and defaults to an empty string
       * rather than to the instance's current value — copying that in would freeze it.
       */
      report: z
        .object({
          dateFormat: z.string().trim().max(40).optional().default(''),
          findingIdPrefix: z.string().trim().max(20).optional().default(''),
          captionStyle: z.string().trim().max(60).optional().default(''),
          /** Their own words for each severity; empty means the standard one. */
          severityLabels: z
            .object({
              critical: z.string().trim().max(40).optional().default(''),
              high: z.string().trim().max(40).optional().default(''),
              medium: z.string().trim().max(40).optional().default(''),
              low: z.string().trim().max(40).optional().default(''),
              none: z.string().trim().max(40).optional().default(''),
            })
            .optional(),
        })
        .optional(),
    }),
  })
);

/* --------------------------------- clients -------------------------------- */
router.use(
  '/clients',
  crudRouter({
    model: Client,
    sort: { lastname: 1, firstname: 1 },
    populate: 'company',
    // Contacts follow their company's visibility — a name and an email address at a
    // client you have nothing to do with is exactly what should not be listed.
    scopeQuery: (req) => visibleClientFilter(req.user),
    ownerField: 'createdBy',
    beforeDelete: (contact) => assertContactUnused(contact._id),
    createSchema: z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid email address'),
      firstname: z.string().trim().max(80).optional().default(''),
      lastname: z.string().trim().max(80).optional().default(''),
      phone: z.string().trim().max(40).optional().default(''),
      cell: z.string().trim().max(40).optional().default(''),
      title: z.string().trim().max(80).optional().default(''),
      company: objectId,
    }),
  })
);

/* -------------------------------- languages ------------------------------- */
router.use(
  '/languages',
  crudRouter({
    model: Language,
    sort: { language: 1 },
    createSchema: z.object({
      language: z.string().trim().min(1).max(60),
      locale: z.string().trim().min(2).max(10),
    }),
  })
);

/* ------------------------------- audit types ------------------------------ */
router.use(
  '/audit-types',
  crudRouter({
    model: AuditType,
    sort: { name: 1 },
    populate: [
      { path: 'templates.template' },
      // Names only: a blueprint listing its checklists must not drag every check.
      { path: 'checklists', select: 'name slug builtin' },
      { path: 'reviewers', select: 'username firstname lastname' },
      { path: 'collaborators', select: 'username firstname lastname' },
    ],
    adminOnly: ['delete'],
    createSchema: z.object({
      name: z.string().trim().min(1).max(120),
      /** What shape of work this type is — see the taxonomy model. */
      kind: z.enum(ENGAGEMENT_KINDS).optional(),
      templates: z
        .array(
          z.object({
            template: z.string().regex(/^[0-9a-fA-F]{24}$/),
            locale: z.string().trim().min(2).max(10).default('en'),
          })
        )
        .optional()
        .default([]),
      sections: z.array(z.string().trim()).optional().default([]),
      hidden: z.array(z.string().trim()).optional().default([]),
      // The rest of the blueprint. All optional — a type with none of it behaves
      // exactly as it did before blueprints existed.
      checklists: z.array(idString).optional().default([]),
      reviewers: z.array(idString).optional().default([]),
      collaborators: z.array(idString).optional().default([]),
      scopeGroups: z.array(z.string().trim().max(200)).optional().default([]),
    }),
  })
);

/* --------------------------- vulnerability types -------------------------- */
router.use(
  '/vulnerability-types',
  crudRouter({
    model: VulnerabilityType,
    sort: { name: 1 },
    createSchema: z.object({
      name: z.string().trim().min(1).max(120),
      locale: z.string().trim().min(2).max(10).default('en'),
    }),
  })
);

/* ------------------------- vulnerability categories ----------------------- */
router.use(
  '/vulnerability-categories',
  crudRouter({
    model: VulnerabilityCategory,
    sort: { name: 1 },
    createSchema: z.object({
      name: z.string().trim().min(1).max(120),
      sortValue: z.string().trim().max(60).optional().default('cvssScore'),
      sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
      sortAuto: z.boolean().optional().default(true),
    }),
  })
);

/* -------------------------------- sections -------------------------------- */
router.use(
  '/sections',
  crudRouter({
    model: SectionDefinition,
    sort: { name: 1 },
    createSchema: z.object({
      field: identifier,
      name: z.string().trim().min(1).max(120),
      icon: z.string().trim().max(60).optional().default(''),
    }),
  })
);

/* ------------------------------ custom fields ----------------------------- */
router.use(
  '/custom-fields',
  crudRouter({
    model: CustomField,
    sort: { display: 1, position: 1 },
    adminOnly: ['create', 'update', 'delete'],
    createSchema: z.object({
      label: z.string().trim().min(1).max(120),
      key: identifier,
      fieldType: z.enum(FIELD_TYPES).default('input'),
      display: z.enum(FIELD_VIEWS).default('general'),
      displaySub: z.string().trim().max(120).optional().default(''),
      size: z.number().int().min(1).max(12).optional().default(12),
      offset: z.number().int().min(0).max(11).optional().default(0),
      required: z.boolean().optional().default(false),
      description: z.string().trim().max(500).optional().default(''),
      text: z.any().optional().default(''),
      options: z
        .array(z.object({ locale: z.string().default('en'), value: z.string() }))
        .optional()
        .default([]),
      position: z.number().int().min(0).optional().default(0),
    }),
  })
);

export default router;
