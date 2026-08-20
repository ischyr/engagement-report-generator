/**
 * The Sales section.
 *
 * Two things live here that live nowhere else: the dashboard, and the client book. Proposals
 * do not — they are on `/proposals`, because the people who evaluate them cannot reach this
 * router and a second copy of those endpoints would be a second set of rules.
 *
 * The client book is here rather than shared with `/data` for the opposite reason: `/data`
 * carries the vulnerability library, taxonomies and everything else an operator maintains, and
 * opening that to a sales account to reach two collections would undo the wall. These are the
 * same two models, reached through a door that only offers those two.
 *
 * Open to `sales` and to admins — see the note in the header of this section's page about why
 * an admin is not shut out of a wall they administer.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Company } from '../models/company.model.js';
import { Client } from '../models/client.model.js';
import { Proposal, PROPOSAL_OPEN_STATUSES } from '../models/proposal.model.js';
import { Settings } from '../models/settings.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireRole, requireWrite } from '../middleware/auth.js';
import { pipelineSummary, PROPOSAL_POPULATE } from '../services/proposal.service.js';
import { priceOf } from '../services/pricing.service.js';
import { SALES_ACTIONS } from '../models/sales-activity.model.js';
import { logSales, salesActivity, actorName } from '../services/sales-activity.service.js';
import { assertCompanyUnused, assertContactUnused } from '../services/references.service.js';

const router = Router();

// Everything here, for both audiences. `requireRole` lets admins through by itself.
router.use(requireRole('sales'));

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the Sales dashboard shows.
 *
 * `ready` is still here and now true: it is what tells the page whether to render the figures
 * or say there is nothing yet, and the answer stopped being "nothing" the moment proposals
 * existed.
 *
 * The counts used to be the whole of it, because there were no prices anywhere in this app. There
 * are now — see the rate card in Settings — so the value of what is live is here too, and it is
 * null rather than zero when no rate card has been filled in: a pipeline worth 0.00 reads as a
 * disaster rather than as an unanswered question.
 */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const [summary, mine, waiting, settings] = await Promise.all([
      pipelineSummary(),
      Proposal.find({ owner: req.user._id, status: { $in: PROPOSAL_OPEN_STATUSES } })
        .populate(PROPOSAL_POPULATE)
        .sort({ updatedAt: -1 })
        .limit(8),
      /*
       * Sitting with somebody else, which is the only part of the pipeline sales cannot move
       * on its own. Worth its own list: "why has this not gone out" is usually this.
       */
      Proposal.find({ status: { $in: ['evaluating', 'documents-review'] } })
        .populate(PROPOSAL_POPULATE)
        .sort({ updatedAt: 1 })
        .limit(8),
      Settings.getSettings(),
    ]);

    /*
     * What the live pipeline is worth.
     *
     * Unweighted: a probability per stage would be a number this app has no basis for, and a
     * forecast built on invented weights is worse than a total somebody can weigh themselves.
     */
    const live = await Proposal.find({ status: { $in: PROPOSAL_OPEN_STATUSES } })
      .populate({ path: 'company', select: 'name billing' })
      .select('estimate pricing company status');
    const prices = live.map((proposal) => priceOf(proposal, proposal.company, settings));
    const anyPriced = prices.some((price) => price.priced);

    const shape = (proposal) => ({
      id: proposal._id.toString(),
      reference: proposal.reference,
      title: proposal.title,
      status: proposal.status,
      company: proposal.company?.name ?? '',
      days: proposal.effortDays(),
      effortAgreed: proposal.effortAgreed(),
      updatedAt: proposal.updatedAt,
    });

    res.json({
      ready: true,
      summary,
      mine: mine.map(shape),
      waitingOnOthers: waiting.map(shape),
      /** The live pipeline in money, and the currency to print it in. Null until there is a rate card. */
      pipelineValue: anyPriced
        ? Math.round(prices.reduce((sum, price) => sum + (price.net ?? 0), 0) * 100) / 100
        : null,
      currency: settings.sales?.currency || 'EUR',
      /** How many of the live ones have no figure at all, which is the honest caveat on the total. */
      unpriced: prices.filter((price) => !price.priced).length,
      /**
       * Whether the firm's own legal details are filled in. Said here so the page can warn
       * *before* somebody generates an NDA with a blank first party rather than after.
       */
      firmReady: Boolean(settings.firm?.legalName),
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Search, over the things this section actually has.
 *
 * A sales account had no search box at all, because `/search` looks through engagements,
 * findings, sections and notes — every one of which answers 403 for them, so the box would have
 * come back empty every time. This is the same idea over clients, contacts and proposals.
 *
 * Deliberately the *same result shape* as `/search`: `{ type, id, title, subtitle, href }`. That
 * lets one component, one keyboard path and one set of recent-search memory serve both, instead
 * of a second palette that behaves almost but not quite the same.
 */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ query: q, total: 0, results: [] });

    // Escaped: a client called "C++ Ltd" is a search term, not a pattern.
    const needle = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [companies, contacts, proposals] = await Promise.all([
      Company.find({ $or: [{ name: needle }, { shortName: needle }] })
        .select('name shortName address updatedAt')
        .limit(10),
      Client.find({
        $or: [{ email: needle }, { firstname: needle }, { lastname: needle }, { title: needle }],
      })
        .select('email firstname lastname title company updatedAt')
        .populate('company', 'name')
        .limit(10),
      Proposal.find({
        $or: [{ title: needle }, { reference: needle }, { summary: needle }],
      })
        .select('title reference status company updatedAt')
        .populate('company', 'name')
        .limit(15),
    ]);

    const results = [
      ...proposals.map((proposal) => ({
        type: 'proposal',
        id: proposal._id,
        title: proposal.title,
        subtitle: [proposal.reference, proposal.company?.name, proposal.status]
          .filter(Boolean)
          .join(' · '),
        href: `/sales/proposals?open=${proposal._id}`,
        updatedAt: proposal.updatedAt,
      })),
      ...companies.map((company) => ({
        type: 'salesClient',
        id: company._id,
        title: company.name,
        subtitle: company.address || company.shortName || 'Client',
        href: '/sales/clients',
        updatedAt: company.updatedAt,
      })),
      ...contacts.map((contact) => ({
        type: 'client',
        id: contact._id,
        title: [contact.firstname, contact.lastname].filter(Boolean).join(' ') || contact.email,
        subtitle: [contact.title, contact.company?.name, contact.email].filter(Boolean).join(' · '),
        href: '/sales/clients',
        updatedAt: contact.updatedAt,
      })),
    ];

    res.json({ query: q, total: results.length, results });
  })
);

/* -------------------------------------------------------------------------- */
/* The log                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Who did what in this section.
 *
 * Administrators only, and that is the difference between this and an engagement's activity
 * tab. That one is written for the people doing the work — "who changed this finding" is a
 * question the person looking at the finding needs answered. This one answers a managerial
 * question instead: whose estimates get revised, who moved a deal, what was deleted. Colleagues
 * should not be reading that about each other, and somebody running the firm needs it when a
 * client asks why their proposal took three weeks.
 *
 * `requireRole('admin')` on the route, not the router's own `requireRole('sales')`: that one
 * lets an admin through *and* every sales account, which is the opposite of what this needs.
 */
router.get(
  '/activity',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json(
      await salesActivity({
        limit: req.query.limit ?? 100,
        skip: req.query.skip ?? 0,
        area: String(req.query.area ?? ''),
        proposal: String(req.query.proposal ?? ''),
      })
    );
  })
);

/* -------------------------------------------------------------------------- */
/* The client book                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Clients and their contacts, in one call.
 *
 * Together because that is how the page reads: a client is a heading with people under it, and
 * two requests to draw one list is two chances for them to disagree.
 */
router.get(
  '/clients',
  asyncHandler(async (_req, res) => {
    const [companies, contacts, counts] = await Promise.all([
      Company.find().sort({ name: 1 }),
      Client.find().sort({ email: 1 }),
      Proposal.aggregate([{ $group: { _id: '$company', count: { $sum: 1 } } }]),
    ]);
    const proposalCounts = new Map(counts.map((row) => [String(row._id), row.count]));

    res.json({
      clients: companies.map((company) => ({
        id: company._id.toString(),
        name: company.name,
        shortName: company.shortName ?? '',
        address: company.address ?? '',
        website: company.website ?? '',
        billing: {
          dayRate: company.billing?.dayRate ?? null,
          vat: company.billing?.vat ?? '',
          poRequired: Boolean(company.billing?.poRequired),
          invoiceEmail: company.billing?.invoiceEmail ?? '',
          invoiceAddress: company.billing?.invoiceAddress ?? '',
          paymentTermsDays: company.billing?.paymentTermsDays ?? null,
        },
        proposals: proposalCounts.get(company._id.toString()) ?? 0,
        contacts: contacts
          .filter((contact) => String(contact.company) === company._id.toString())
          .map((contact) => ({
            id: contact._id.toString(),
            email: contact.email,
            firstname: contact.firstname ?? '',
            lastname: contact.lastname ?? '',
            fullname: [contact.firstname, contact.lastname].filter(Boolean).join(' ') || contact.email,
            phone: contact.phone ?? '',
            cell: contact.cell ?? '',
            title: contact.title ?? '',
          })),
      })),
      /** People recorded before their company was, so they are not invisible. */
      unattached: contacts
        .filter((contact) => !contact.company)
        .map((contact) => ({
          id: contact._id.toString(),
          email: contact.email,
          fullname: [contact.firstname, contact.lastname].filter(Boolean).join(' ') || contact.email,
        })),
    });
  })
);

const companySchema = z.object({
  name: z.string().trim().min(1, 'Name the client').max(200),
  shortName: z.string().trim().max(80).optional(),
  address: z.string().max(500).optional(),
  website: z.string().trim().max(200).optional(),
  /**
   * What they pay and where the invoice goes.
   *
   * On the client rather than on every proposal, because a rate negotiated two years ago should not
   * be retyped onto each one — and `poRequired` is the field that stops an invoice coming back
   * months later for the want of a number somebody could have asked for at the start.
   */
  billing: z
    .object({
      dayRate: z.number().min(0).max(1_000_000).nullable().optional(),
      vat: z.string().trim().max(80).optional(),
      poRequired: z.boolean().optional(),
      invoiceEmail: z.string().trim().max(200).optional(),
      invoiceAddress: z.string().max(500).optional(),
      paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
    })
    .optional(),
});

router.post(
  '/clients',
  requireWrite,
  validate(companySchema),
  asyncHandler(async (req, res) => {
    const clash = await Company.findOne({ name: req.body.name });
    // Named rather than a duplicate-key error, because the answer is usually "it is already
    // there, go and use it" rather than "pick another name".
    if (clash) throw badRequest(`${req.body.name} is already on record.`);

    const company = await Company.create({ ...req.body, createdBy: req.user._id });
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.CLIENT_ADDED,
      summary: `${actorName(req.user)} added the client ${company.name}`,
      company: company._id,
      target: company.name,
    });
    res.status(201).json({ id: company._id.toString(), name: company.name });
  })
);

router.put(
  '/clients/:id',
  requireWrite,
  validate(companySchema.partial()),
  asyncHandler(async (req, res) => {
    const company = await Company.findById(req.params.id);
    if (!company) throw notFound('Client not found');
    /*
     * The fields that actually changed, so the log says something rather than "updated".
     *
     * `billing` is compared by its own keys: stringifying an object gives "[object Object]" on both
     * sides, so a nested block would have read as unchanged every time and the log would have said
     * nothing about a day rate being altered — which is the change here most worth recording.
     */
    const changed = Object.keys(req.body).flatMap((key) => {
      if (key === 'billing' && req.body.billing && typeof req.body.billing === 'object') {
        return Object.keys(req.body.billing)
          .filter(
            (field) =>
              String(req.body.billing[field] ?? '') !== String(company.billing?.[field] ?? '')
          )
          .map((field) => `billing.${field}`);
      }
      return String(req.body[key] ?? '') !== String(company[key] ?? '') ? [key] : [];
    });
    const { billing, ...rest } = req.body;
    Object.assign(company, rest);
    /* Merged, not replaced: a form that sends only the day rate must not clear the VAT number. */
    if (billing) Object.assign(company.billing, billing);
    await company.save();

    if (changed.length) {
      await logSales({
        actor: req.user,
        action: SALES_ACTIONS.CLIENT_UPDATED,
        summary: `${actorName(req.user)} changed ${changed.join(', ')} on ${company.name}`,
        company: company._id,
        target: company.name,
        meta: { fields: changed },
      });
    }
    res.json({ id: company._id.toString(), name: company.name });
  })
);

/**
 * Removes a client.
 *
 * Refused while anything still points at it, naming what — see references.service.js for why
 * this refuses rather than cascades. The same rule guards the Clients & Data page, so the two
 * doors cannot disagree about what is safe to remove.
 */
router.delete(
  '/clients/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const company = await Company.findById(req.params.id);
    if (!company) throw notFound('Client not found');
    await assertCompanyUnused(company._id);

    const name = company.name;
    await company.deleteOne();
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.CLIENT_DELETED,
      summary: `${actorName(req.user)} deleted the client ${name}`,
      target: name,
    });
    res.json({ ok: true, id: req.params.id });
  })
);

const contactSchema = z.object({
  email: z.string().trim().toLowerCase().email('That is not an email address').max(200),
  firstname: z.string().trim().max(80).optional(),
  lastname: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(60).optional(),
  cell: z.string().trim().max(60).optional(),
  title: z.string().trim().max(120).optional(),
  company: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
});

router.post(
  '/contacts',
  requireWrite,
  validate(contactSchema),
  asyncHandler(async (req, res) => {
    const clash = await Client.findOne({ email: req.body.email });
    if (clash) throw badRequest(`${req.body.email} is already a contact.`);

    const contact = await Client.create({ ...req.body, createdBy: req.user._id });
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.CONTACT_ADDED,
      summary: `${actorName(req.user)} added the contact ${contact.email}`,
      company: contact.company ?? null,
      target: contact.email,
    });
    res.status(201).json({ id: contact._id.toString(), email: contact.email });
  })
);

router.put(
  '/contacts/:id',
  requireWrite,
  validate(contactSchema.partial()),
  asyncHandler(async (req, res) => {
    const contact = await Client.findById(req.params.id);
    if (!contact) throw notFound('Contact not found');
    const changed = Object.keys(req.body).filter(
      (key) => String(req.body[key] ?? '') !== String(contact[key] ?? '')
    );
    Object.assign(contact, req.body);
    await contact.save();

    if (changed.length) {
      await logSales({
        actor: req.user,
        action: SALES_ACTIONS.CONTACT_UPDATED,
        summary: `${actorName(req.user)} changed ${changed.join(', ')} on ${contact.email}`,
        company: contact.company ?? null,
        target: contact.email,
        meta: { fields: changed },
      });
    }
    res.json({ id: contact._id.toString(), email: contact.email });
  })
);

/**
 * Removes a contact.
 *
 * Refused while a proposal is addressed to them: a contract that names somebody the app can no
 * longer identify is worse than a contact list with one too many people in it.
 */
router.delete(
  '/contacts/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const contact = await Client.findById(req.params.id);
    if (!contact) throw notFound('Contact not found');
    /*
     * Was a count of proposals only. Now the shared check, which also knows about engagements,
     * distribution lists and recorded deliveries — a contact who received a report last year
     * must keep being nameable on that delivery.
     */
    await assertContactUnused(contact._id);

    const email = contact.email;
    const company = contact.company ?? null;
    await contact.deleteOne();
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.CONTACT_DELETED,
      summary: `${actorName(req.user)} deleted the contact ${email}`,
      company,
      target: email,
    });
    res.json({ ok: true, id: req.params.id });
  })
);

export default router;
