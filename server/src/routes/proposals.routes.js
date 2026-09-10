/**
 * Proposals: one router, two audiences.
 *
 * Sales and the people who would do the work reach this from different pages, and for a while
 * that looked like two routers. It is not: they read the same record and the difference between
 * them is *which moves they may make*, which the transition table already knows. Two routers
 * would mean two definitions of who can do what, and they would disagree within a month.
 *
 * So every route here is open to both, and the per-action rules live in proposal.service.js.
 * The one exception is deleting, which only ever belongs to the person whose deal it is.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Proposal, PROPOSAL_SOURCES, PROPOSAL_STATUSES } from '../models/proposal.model.js';
import { Delivery } from '../models/delivery.model.js';
import { TimeEntry, HOURS_PER_DAY } from '../models/time-entry.model.js';
import { Company } from '../models/company.model.js';
import { Client } from '../models/client.model.js';
import { Template } from '../models/template.model.js';
import { AuditType } from '../models/taxonomy.model.js';
import { Audit } from '../models/audit.model.js';
import { Settings } from '../models/settings.model.js';
import { SalesTarget, quarterOf, quarterRange } from '../models/sales-target.model.js';
import { User } from '../models/user.model.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireRole, requireWrite } from '../middleware/auth.js';
import { uploadDocument } from '../middleware/upload.js';
import {
  MAX_DOCUMENT_BYTES,
  deleteDocumentFile,
  openDocument,
  safeFilename,
  serveableType,
  storeDocument,
} from '../services/documents.service.js';
import {
  PROPOSAL_POPULATE,
  audienceOf,
  availableTransitions,
  canSignOff,
  generateProposalDocument,
  moveProposal,
  nextReference,
  pipelineSummary,
  workQueue,
} from '../services/proposal.service.js';
import contentDisposition from '../utils/content-disposition.js';
import { SALES_ACTIONS } from '../models/sales-activity.model.js';
import { logSales, actorName } from '../services/sales-activity.service.js';
import { priceOf, formatMoney } from '../services/pricing.service.js';

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, 'Use a yyyy-mm-dd date').or(z.literal(''));

/**
 * When the next engagement in a retainer is due: the first one's start plus the interval.
 *
 * Falls back to counting from today when the proposal never carried a start date, because a retainer
 * with no schedule at all would nudge nobody — and the whole delivery half of this feature is that
 * nudge. Day-of-month is preserved, which is what "quarterly" means to a client.
 */
function nextDueAfter(start, months) {
  const from = start ? new Date(`${start}T00:00:00Z`) : new Date();
  if (Number.isNaN(from.getTime())) return '';
  from.setUTCMonth(from.getUTCMonth() + Number(months || 0));
  return from.toISOString().slice(0, 10);
}
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not an id');

/**
 * What a page gets back. `can` is what *this* reader may do, so buttons match the server.
 *
 * `settings` is a parameter rather than a lookup because a list of four hundred proposals would
 * otherwise fetch the rate card four hundred times. `presentOne` below is the wrapper every route
 * that answers with one proposal uses, so no call site has to remember that.
 */
function present(proposal, user, settings) {
  const raw = proposal.toObject({ virtuals: true });
  const audience = audienceOf(user);
  /*
   * The price, computed rather than stored — see pricing.service.js. Sent on every proposal, priced
   * or not: a page needs to be able to say "no rate card" as clearly as it says a figure.
   */
  const price = priceOf(proposal, proposal.company, settings);
  return {
    ...raw,
    effortDays: proposal.effortDays(),
    effortAgreed: proposal.effortAgreed(),
    /*
     * Comments, with the two things the page would otherwise work out wrongly: whose it is, and
     * whether this reader may remove it. The rule lives in the route; repeating it in the client as
     * `author === me` would drift the day an admin gained the power to tidy somebody else's up —
     * which they have, here.
     */
    comments: (raw.comments ?? []).map((comment) => ({
      ...comment,
      author: comment.author
        ? {
            id: String(comment.author._id ?? comment.author),
            name:
              [comment.author.firstname, comment.author.lastname].filter(Boolean).join(' ') ||
              comment.author.username ||
              'Somebody',
            username: comment.author.username ?? '',
          }
        : null,
      mine: String(comment.author?._id ?? comment.author ?? '') === String(user?._id ?? ''),
      canDelete:
        String(comment.author?._id ?? comment.author ?? '') === String(user?._id ?? '') ||
        user?.role === 'admin',
    })),
    price,
    transitions: availableTransitions(proposal, user, price),
    can: {
      /** Sales owns the record's own fields; the work side owns the estimate and the sign-off. */
      edit: audience === 'sales' || audience === 'both',
      estimate: audience === 'work' || audience === 'both',
      evaluate: audience === 'work' || audience === 'both',
      /*
       * Signing a client's paperwork off takes a manager, which is narrower than "does the
       * work". The page reads this rather than working it out again, so the button is offered to
       * exactly the people the server will accept it from.
       */
      approveDocuments: canSignOff(user),
      generate: audience === 'sales' || audience === 'both',
      /** Creating the job is the work side's, so the button is not offered to sales at all. */
      convert: audience === 'work' || audience === 'both',
      /** The kickoff is the one thing either side records — whoever was on the call. */
      kickoff: true,
      /** Both audiences, which is the point: the argument about a number needs both sides in it. */
      comment: true,
      /** Cloning is raising a proposal, so it belongs to whoever raises them. */
      clone: audience === 'sales' || audience === 'both',
      /** Quoting is sales'; signing a price off is a manager's, like the paperwork. */
      price: audience === 'sales' || audience === 'both',
      approvePrice: canSignOff(user),
      /*
       * A purchase order can be recorded by either side and after acceptance, unlike every other
       * field on the record. The number arrives late, from whoever the client sent it to.
       */
      billing: true,
    },
  };
}

/**
 * A proposal as a *row*, rather than as a record.
 *
 * `present()` returns everything: the full text of the summary and the constraints, every document
 * with its hashes, every comment, the whole status history, the evaluation, the kickoff. That is
 * right for the one being read and wasteful four hundred times over — and it grew every time this
 * section gained a feature, which is the part that would not have stopped on its own.
 *
 * What a list needs is what the two tables draw plus what they filter on. Anything opening the
 * detail fetches `/proposals/:id`, which still answers in full.
 */
function summarise(proposal, user, settings) {
  const price = priceOf(proposal, proposal.company, settings);
  return {
    _id: proposal._id,
    reference: proposal.reference,
    title: proposal.title,
    status: proposal.status,
    auditType: proposal.auditType ?? '',
    kind: proposal.kind ?? 'standard',
    company: proposal.company
      ? { _id: proposal.company._id, name: proposal.company.name ?? '' }
      : null,
    owner: proposal.owner
      ? {
          _id: proposal.owner._id,
          username: proposal.owner.username,
          firstname: proposal.owner.firstname ?? '',
          lastname: proposal.owner.lastname ?? '',
        }
      : null,
    /* Both figures: the tables show what sales quoted *and* whether anybody has checked it. */
    estimate: { salesDays: proposal.estimate?.salesDays ?? null, days: proposal.estimate?.days ?? null },
    effortDays: proposal.effortDays(),
    effortAgreed: proposal.effortAgreed(),
    requestedOn: proposal.requestedOn ?? '',
    expectedStart: proposal.expectedStart ?? '',
    expectedEnd: proposal.expectedEnd ?? '',
    validUntil: proposal.validUntil ?? '',
    /*
     * `deletedAt` as well as the name: the list disables its delete button while a *live* engagement
     * depends on the proposal, and an engagement in the trash no longer does. Leaving it out of the
     * row made every converted proposal undeletable forever, which is the bug that rule was written
     * to fix in the first place.
     */
    audit: proposal.audit
      ? {
          _id: proposal.audit._id,
          name: proposal.audit.name ?? '',
          reference: proposal.audit.reference ?? '',
          deletedAt: proposal.audit.deletedAt ?? null,
        }
      : null,
    retainer: {
      engagements: proposal.retainer?.engagements ?? 0,
      everyMonths: proposal.retainer?.everyMonths ?? null,
    },
    outcome: { reason: proposal.outcome?.reason ?? '' },
    source: { kind: proposal.source?.kind ?? '' },
    /** Enough of the price for a column; the breakdown belongs to the detail. */
    price: { priced: price.priced, currency: price.currency, net: price.net },
    /* Counts rather than contents: a row shows that there are three documents, not what they are. */
    counts: {
      documents: (proposal.documents ?? []).length,
      comments: (proposal.comments ?? []).length,
    },
    updatedAt: proposal.updatedAt,
    createdAt: proposal.createdAt,
  };
}

/** A list of rows, with the rate card fetched once. */
const summariseMany = async (proposals, user) => {
  const settings = await Settings.getSettings();
  return proposals.map((proposal) => summarise(proposal, user, settings));
};

/** One proposal, with the rate card fetched for it. */
const presentOne = async (proposal, user) => present(proposal, user, await Settings.getSettings());

const load = async (id) => {
  const proposal = await Proposal.findById(id).populate(PROPOSAL_POPULATE);
  if (!proposal) throw notFound('Proposal not found');
  return proposal;
};

/* -------------------------------------------------------------------------- */
/* Lists                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The pipeline.
 *
 * `?status=` narrows it, `?open=1` means everything still live. No per-record visibility rule:
 * a proposal is the firm's, not one salesperson's, and an evaluation queue that hid the ones
 * belonging to somebody on holiday would be worse than useless.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status) {
      const wanted = String(req.query.status).split(',').filter(Boolean);
      const unknown = wanted.filter((status) => !PROPOSAL_STATUSES.includes(status));
      if (unknown.length) throw badRequest(`Unknown status: ${unknown.join(', ')}`);
      filter.status = { $in: wanted };
    }
    if (req.query.company) filter.company = req.query.company;

    const proposals = await Proposal.find(filter)
      .populate(PROPOSAL_POPULATE)
      .sort({ updatedAt: -1 })
      .limit(400);

    res.json({
      proposals: await summariseMany(proposals, req.user),
      summary: await pipelineSummary(),
    });
  })
);

/** The two things the work side is being asked for. Declared before `/:id`. */
router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const { evaluating, reviewing } = await workQueue();
    res.json({
      evaluating: await summariseMany(evaluating, req.user),
      reviewing: await summariseMany(reviewing, req.user),
    });
  })
);

/**
 * Proposal templates, so a page can offer "generate the NDA" without knowing what exists.
 *
 * Here rather than on `/templates`: that router is behind the wall a sales account cannot pass,
 * and this returns names and document types only — nothing about the file.
 */
router.get(
  '/templates',
  asyncHandler(async (_req, res) => {
    const templates = await Template.find({ purpose: 'proposal', kind: 'docx' }).sort({ name: 1 });
    res.json(
      templates.map((template) => ({
        id: template._id.toString(),
        name: template.name,
        docType: template.docType || 'other',
        description: template.description ?? '',
      }))
    );
  })
);

/** Everything a create form needs, in one call rather than four. */
router.get(
  '/form-data',
  asyncHandler(async (_req, res) => {
    const [companies, contacts, types, settings] = await Promise.all([
      Company.find().select('name shortName').sort({ name: 1 }),
      Client.find().select('firstname lastname email company title').sort({ email: 1 }),
      AuditType.find().sort({ name: 1 }),
      Settings.getSettings(),
    ]);
    res.json({
      companies: companies.map((c) => ({ id: c._id.toString(), name: c.name, shortName: c.shortName })),
      contacts: contacts.map((c) => ({
        id: c._id.toString(),
        email: c.email,
        fullname: [c.firstname, c.lastname].filter(Boolean).join(' ') || c.email,
        title: c.title ?? '',
        company: c.company ? c.company.toString() : null,
      })),
      types: types.map((t) => ({ name: t.name, kind: t.kind ?? 'standard' })),
      /** So a page can warn that the paperwork will come out with a blank first party. */
      firmReady: Boolean(settings.firm?.legalName),
    });
  })
);

/**
 * Why we win and why we lose, counted.
 *
 * The whole point of asking for a reason at the moment of the move: this page. Counts by reason, the
 * win rate, how long a decision takes, and who keeps beating us — over whatever window the caller
 * asks for, defaulting to the last year because a quarter is too few decisions to read anything
 * into and everything is a trend if you squint.
 *
 * Scoped like every other read here, so a salesperson sees their own firm's picture and nobody sees
 * an instance they have no business in.
 */
/**
 * The ones worth ringing again.
 *
 * A proposal lost on timing or on budget was never a "no" — it was a "not now", and the not-now
 * expires. Six months later that is the warmest list a sales section has, and until the reason was
 * recorded it was unobtainable: "everything we lost" is a graveyard, "everything we lost because the
 * money was in next year's budget" is a morning's phone calls.
 *
 * Clients who have come back on their own are left out. If there is a newer proposal for the same
 * company, they are already in the pipeline and appearing here would be noise at best and an awkward
 * phone call at worst.
 */
router.get(
  '/resurrect',
  asyncHandler(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 36);
    const before = new Date();
    before.setMonth(before.getMonth() - months);

    const lost = await Proposal.find({
      status: 'declined',
      'outcome.reason': { $in: ['timing', 'budget', 'no-response'] },
      'outcome.at': { $lte: before },
    })
      .select('reference title company contacts outcome updatedAt owner auditType')
      .populate([
        { path: 'company', select: 'name' },
        { path: 'contacts', select: 'firstname lastname email' },
        { path: 'owner', select: 'username firstname lastname' },
      ])
      .sort({ 'outcome.at': 1 })
      .limit(100);

    /* Anybody with something newer is already being talked to. */
    const companies = [...new Set(lost.map((proposal) => String(proposal.company?._id ?? proposal.company)))];
    const newer = await Proposal.find({
      company: { $in: companies },
      updatedAt: { $gt: before },
      status: { $ne: 'declined' },
    }).select('company');
    const talking = new Set(newer.map((row) => String(row.company)));

    res.json({
      months,
      proposals: lost
        .filter((proposal) => !talking.has(String(proposal.company?._id ?? proposal.company)))
        .map((proposal) => ({
          id: proposal._id,
          reference: proposal.reference,
          title: proposal.title,
          auditType: proposal.auditType ?? '',
          company: proposal.company?.name ?? '',
          companyId: proposal.company?._id ?? null,
          contact: proposal.contacts?.[0]
            ? {
                name: [proposal.contacts[0].firstname, proposal.contacts[0].lastname]
                  .filter(Boolean)
                  .join(' '),
                email: proposal.contacts[0].email,
              }
            : null,
          reason: proposal.outcome?.reason ?? '',
          note: proposal.outcome?.note ?? '',
          lostAt: proposal.outcome?.at ?? proposal.updatedAt,
          owner: proposal.owner
            ? [proposal.owner.firstname, proposal.owner.lastname].filter(Boolean).join(' ') ||
              proposal.owner.username
            : '',
        })),
    });
  })
);

router.get(
  '/outcomes',
  asyncHandler(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    /*
     * No per-record filter, for the same reason the pipeline list has none: a proposal belongs to
     * the firm rather than to the salesperson who raised it, and a win-rate that changed depending
     * on who was looking would be worse than no win-rate. Who may reach this section at all is
     * settled where the router is mounted.
     */
    const closed = await Proposal.find({
      status: { $in: ['accepted', 'declined', 'converted'] },
      updatedAt: { $gte: since },
    })
      .select('reference title status company outcome history createdAt updatedAt value')
      .populate('company', 'name')
      .sort({ updatedAt: -1 });

    const won = closed.filter((p) => p.status !== 'declined');
    const lost = closed.filter((p) => p.status === 'declined');

    /** Counts keyed by reason, with the ones nobody gave grouped honestly rather than dropped. */
    const tally = (list) => {
      const counts = new Map();
      for (const proposal of list) {
        const key = proposal.outcome?.reason || 'not recorded';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
    };

    /**
     * How long a decision took, in days, measured from the offer going out.
     *
     * From `sent` rather than from when the proposal was raised: the wait that matters to a
     * salesperson is the one after the ball left their hands.
     */
    const decisionDays = (proposal) => {
      const sent = (proposal.history ?? []).find((entry) => entry.to === 'sent')?.at;
      if (!sent) return null;
      const closedAt = (proposal.history ?? [])
        .filter((entry) => entry.to === 'accepted' || entry.to === 'declined')
        .at(-1)?.at;
      if (!closedAt) return null;
      return Math.max(0, Math.round((new Date(closedAt) - new Date(sent)) / 86_400_000));
    };
    const waits = closed.map(decisionDays).filter((days) => days !== null).sort((a, b) => a - b);
    const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;

    const competitors = new Map();
    for (const proposal of lost) {
      const name = (proposal.outcome?.competitor ?? '').trim();
      if (name) competitors.set(name, (competitors.get(name) ?? 0) + 1);
    }

    res.json({
      months,
      totals: {
        closed: closed.length,
        won: won.length,
        lost: lost.length,
        /** Null rather than zero when nothing has closed: a 0% win rate on no decisions is a lie. */
        winRate: closed.length ? Math.round((won.length / closed.length) * 100) : null,
        medianDecisionDays: median,
      },
      wins: tally(won),
      losses: tally(lost),
      competitors: [...competitors.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      /** The recent decisions themselves, because a number nobody can drill into is not evidence. */
      recent: closed.slice(0, 20).map((proposal) => ({
        id: proposal._id,
        reference: proposal.reference,
        title: proposal.title,
        company: proposal.company?.name ?? '',
        status: proposal.status,
        reason: proposal.outcome?.reason ?? '',
        competitor: proposal.outcome?.competitor ?? '',
        note: proposal.outcome?.note ?? '',
        at: proposal.outcome?.at ?? proposal.updatedAt,
      })),
    });
  })
);

/* -------------------------------------------------------------------------- */
/* The price                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What we are charging, as a rate and a discount.
 *
 * Never a total: the total is the rate times the days the work side agreed, and storing it too
 * would be two numbers that can disagree — which is the bug where the record says 40,000 and the
 * contract says 45,000. `pricing.service.js` is the only place either is turned into money.
 *
 * Frozen once the offer has gone out, like every other commercial field: the client is holding a
 * piece of paper with a figure on it, and a record that quietly disagrees with it is worse than no
 * record. The purchase order is the one exception, below, because it always arrives afterwards.
 */
router.put(
  '/:id/pricing',
  requireWrite,
  validate(
    z.object({
      /** Null means "whatever the client's rate is, or the rate card's". */
      dayRate: z.number().min(0).max(1_000_000).nullable().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      note: z.string().trim().max(2000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'work') {
      throw forbidden('The price is the sales side’s. You agree the effort instead.');
    }
    if (['sent', 'accepted', 'converted'].includes(proposal.status)) {
      throw badRequest('This price is already with the client. It cannot be changed now.');
    }

    if (req.body.dayRate !== undefined) proposal.pricing.dayRate = req.body.dayRate;
    if (req.body.discountPercent !== undefined) {
      proposal.pricing.discountPercent = req.body.discountPercent;
    }
    if (req.body.note !== undefined) proposal.pricing.note = req.body.note;

    /*
     * The approval follows the price rather than the other way round.
     *
     * A price that no longer needs signing off should not sit there marked "pending" forever, and
     * one that has just crossed the floor should not keep a signature given for a different figure.
     * `priceOf` works both out — including the stale case — so this reads its verdict rather than
     * re-deriving the rules here.
     */
    const settings = await Settings.getSettings();
    const price = priceOf(proposal, proposal.company, settings);
    if (!price.needsApproval) {
      proposal.pricing.approval = { state: 'not-needed', by: null, at: null, note: '', forRate: null, forDiscount: null };
    } else if (price.approvalStale || proposal.pricing.approval?.state !== 'approved') {
      proposal.pricing.approval.state = 'pending';
      proposal.pricing.approval.by = null;
      proposal.pricing.approval.at = null;
      proposal.pricing.approval.forRate = null;
      proposal.pricing.approval.forDiscount = null;
    }
    await proposal.save();

    const after = await load(proposal._id);
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PRICE_SET,
      summary: `${actorName(req.user)} priced ${proposal.reference} at ${
        price.priced ? formatMoney(price.net, price.currency) : 'no figure yet'
      }${price.discountPercent ? ` after ${price.discountPercent}%` : ''}`,
      proposal: after,
      meta: {
        dayRate: price.dayRate,
        discountPercent: price.discountPercent,
        net: price.net,
        needsApproval: price.needsApproval,
      },
    });
    res.json(present(after, req.user, settings));
  })
);

/**
 * A manager signing a price off, or refusing it.
 *
 * The same authority that signs the paperwork off, for the same reason: it is a decision rather
 * than a skill. What is recorded is the *figures* it was given for, so typing a bigger discount
 * afterwards costs the signature — see the note on `pricing.approval` in the model.
 */
router.post(
  '/:id/pricing/review',
  requireWrite,
  validate(
    z.object({
      approved: z.boolean(),
      note: z.string().trim().max(1000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (!canSignOff(req.user)) throw forbidden('Signing a price off is a manager’s decision.');

    const settings = await Settings.getSettings();
    const price = priceOf(proposal, proposal.company, settings);
    if (!price.needsApproval) {
      throw badRequest('This price is inside what a salesperson may give. There is nothing to sign off.');
    }

    proposal.pricing.approval = {
      state: req.body.approved ? 'approved' : 'rejected',
      by: req.user._id,
      at: new Date(),
      note: req.body.note ?? '',
      /* What was actually seen. A later change to either makes this approval stale. */
      forRate: req.body.approved ? price.dayRate : null,
      forDiscount: req.body.approved ? price.discountPercent : null,
    };
    await proposal.save();

    const after = await load(proposal._id);
    await logSales({
      actor: req.user,
      action: req.body.approved ? SALES_ACTIONS.PRICE_APPROVED : SALES_ACTIONS.PRICE_REJECTED,
      summary: `${actorName(req.user)} ${req.body.approved ? 'approved' : 'rejected'} the price on ${
        proposal.reference
      } (${formatMoney(price.net, price.currency)}, ${price.discountPercent}% off)${
        req.body.note ? ` — ${req.body.note}` : ''
      }`,
      proposal: after,
      meta: { dayRate: price.dayRate, discountPercent: price.discountPercent, net: price.net },
    });
    res.json(present(after, req.user, settings));
  })
);

/**
 * The purchase order, and whether it has been invoiced.
 *
 * Editable after acceptance, which nothing else here is. The PO number nearly always arrives *after*
 * the client says yes — often weeks after, from somebody in their finance team who was not on any of
 * the calls — and a record that refuses it is a record somebody keeps in a spreadsheet instead.
 */
router.put(
  '/:id/billing',
  requireWrite,
  validate(
    z.object({
      poNumber: z.string().trim().max(60).optional(),
      invoiceRef: z.string().trim().max(60).optional(),
      /** ISO date, or null to un-invoice something marked by mistake. */
      invoicedAt: z.string().datetime().nullable().optional(),
      note: z.string().trim().max(1000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    const was = { po: proposal.billing?.poNumber ?? '', invoiced: proposal.billing?.invoicedAt ?? null };

    if (req.body.poNumber !== undefined) proposal.billing.poNumber = req.body.poNumber;
    if (req.body.invoiceRef !== undefined) proposal.billing.invoiceRef = req.body.invoiceRef;
    if (req.body.note !== undefined) proposal.billing.note = req.body.note;
    if (req.body.invoicedAt !== undefined) {
      proposal.billing.invoicedAt = req.body.invoicedAt ? new Date(req.body.invoicedAt) : null;
      proposal.billing.invoicedBy = req.body.invoicedAt ? req.user._id : null;
    }
    await proposal.save();

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.BILLING_UPDATED,
      summary: `${actorName(req.user)} updated the billing on ${proposal.reference}${
        proposal.billing.poNumber && proposal.billing.poNumber !== was.po
          ? ` — PO ${proposal.billing.poNumber}`
          : ''
      }${!was.invoiced && proposal.billing.invoicedAt ? ' — invoiced' : ''}`,
      proposal,
      meta: {
        poNumber: proposal.billing.poNumber,
        invoiceRef: proposal.billing.invoiceRef,
        invoiced: Boolean(proposal.billing.invoicedAt),
      },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Here rather than under /sales, for the reason the header of this file gives.
 *
 * The Sales router requires the `sales` role, and a manager who delivers the work does not hold it —
 * so the person who sets the targets could not reach them there, which was the first thing the suite
 * said. This router is the one both audiences already read, `/proposals/outcomes` beside it is the
 * other half of the same dashboard, and the per-action rule lives on the route where it belongs.
 */

/**
 * When a proposal was actually won.
 *
 * Not `updatedAt`: a proposal accepted in March and converted into an engagement in April would
 * count towards the wrong quarter, and the quarter a target is measured over is the one the client
 * said yes in. The status history holds the moment, and `outcome.at` holds it too when a reason was
 * recorded — either is better than the modification date, which moves every time somebody attaches
 * a file.
 */
function wonAt(proposal) {
  const accepted = (proposal.history ?? []).find((entry) => entry.to === 'accepted')?.at;
  return accepted ?? proposal.outcome?.at ?? proposal.updatedAt;
}

/** Wins per owner inside one quarter, as a map keyed by user id. */
async function winsByOwner(from, to) {
  /*
   * `updatedAt >= from` is a cheap prefilter that cannot exclude a real match, since a proposal is
   * always touched at or after the moment it was won. The quarter itself is then applied to the date
   * above, which the database cannot express without storing it as a field.
   */
  const candidates = await Proposal.find({
    status: { $in: ['accepted', 'converted'] },
    updatedAt: { $gte: from },
  })
    .populate({ path: 'company', select: 'name billing' })
    .select('reference title status company owner outcome history updatedAt estimate pricing');

  /* The rate card once for the whole quarter, not once per win. */
  const settings = await Settings.getSettings();

  const wins = new Map();
  for (const proposal of candidates) {
    const at = new Date(wonAt(proposal));
    if (at < from || at >= to) continue;
    const key = String(proposal.owner ?? '');
    if (!wins.has(key)) wins.set(key, []);
    const price = priceOf(proposal, proposal.company, settings);
    wins.get(key).push({
      id: proposal._id.toString(),
      reference: proposal.reference,
      at,
      /** Null on an unpriced win, which is not the same as a win worth nothing. */
      value: price.priced ? price.net : null,
    });
  }
  return wins;
}

/**
 * The quarter asked for, defaulting to the one we are in.
 *
 * Both parts validated rather than trusted, because they index a unique key: `?quarter=13` would
 * otherwise write a row nothing can ever read back.
 */
function askedQuarter(query) {
  const nowQ = quarterOf();
  const year = Number(query.year) || nowQ.year;
  const quarter = Number(query.quarter) || nowQ.quarter;
  if (year < 2000 || year > 2200) throw badRequest('That year is not a year');
  if (![1, 2, 3, 4].includes(quarter)) throw badRequest('A quarter is 1, 2, 3 or 4');
  return { year, quarter, ...quarterRange(year, quarter) };
}

/**
 * Progress against the quarter's target — mine always, everybody's for a manager.
 *
 * Counted in wins rather than in money, and the reason is worth stating where somebody will look
 * for the missing currency: there is no rate card in this app, so a proposal carries days and no
 * price. A target in euros would be a number the app could not compute progress against, which is
 * worse than a target it can. `SalesTarget.value` exists for the day that changes.
 *
 * A person with no target set is still returned, with `target: null`. Their wins are real work and
 * hiding them until an administrator has filled a form in would make the page look like nothing
 * happened. It also makes "who has no target this quarter" answerable, which is the question a
 * manager has at the start of a quarter.
 */
router.get(
  '/targets',
  asyncHandler(async (req, res) => {
    const { year, quarter, from, to } = askedQuarter(req.query);
    /* A manager sees the team; a salesperson sees themselves. Same endpoint, one less list. */
    const team = req.user.hasRole('admin', 'manager');

    const [targets, wins, people] = await Promise.all([
      SalesTarget.find(team ? { year, quarter } : { user: req.user._id, year, quarter })
        .populate('setBy', 'username firstname lastname')
        .lean(),
      winsByOwner(from, to),
      team
        ? User.find({ roles: 'sales', enabled: { $ne: false } })
            .select('username firstname lastname roles')
            .sort({ username: 1 })
        : [],
    ]);

    const byUser = new Map(targets.map((row) => [String(row.user), row]));

    const line = (user) => {
      const key = String(user._id ?? user.id ?? user);
      const target = byUser.get(key) ?? null;
      const won = wins.get(key) ?? [];
      return {
        user: {
          id: key,
          username: user.username,
          name:
            [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username || 'Somebody',
        },
        /** Null when nobody has set one, which is not the same as a target of zero. */
        target: target ? target.wins : null,
        /** The goal in money, once a rate card makes one meaningful. */
        targetValue: target?.value ?? null,
        note: target?.note ?? '',
        setBy: target?.setBy
          ? [target.setBy.firstname, target.setBy.lastname].filter(Boolean).join(' ') ||
            target.setBy.username
          : '',
        wins: won.length,
        /**
         * What those wins were worth, and how that sits against a value target.
         *
         * Null rather than zero when nothing is priced: a rate card that has not been filled in
         * should read as "no figure" on this card, not as a quarter in which nobody sold anything.
         */
        value: won.some((row) => row.value !== null)
          ? Math.round(won.reduce((sum, row) => sum + (row.value ?? 0), 0) * 100) / 100
          : null,
        valuePercent:
          target?.value && won.some((row) => row.value !== null)
            ? Math.round(
                (won.reduce((sum, row) => sum + (row.value ?? 0), 0) / target.value) * 100
              )
            : null,
        /** Only meaningful against a target; null keeps a progress bar from inventing one. */
        percent: target?.wins ? Math.round((won.length / target.wins) * 100) : null,
        remaining: target?.wins ? Math.max(0, target.wins - won.length) : null,
        recent: won
          .sort((a, b) => new Date(b.at) - new Date(a.at))
          .slice(0, 5)
          .map((row) => ({ ...row, at: row.at })),
      };
    };

    /*
     * Everybody who either has a target or has won something. A manager's list is the sales
     * accounts, plus anybody outside that list who closed a proposal this quarter — which is how an
     * admin covering for somebody on holiday shows up instead of vanishing from the totals.
     */
    const ids = new Set([...people.map((user) => String(user._id))]);
    const extras = team
      ? await User.find({
          _id: {
            $in: [...new Set([...wins.keys(), ...targets.map((row) => String(row.user))])]
              .filter((id) => id && !ids.has(id))
              .filter((id) => /^[a-f\d]{24}$/i.test(id)),
          },
        }).select('username firstname lastname roles')
      : [];

    const rows = team ? [...people, ...extras].map(line) : [line(req.user)];

    res.json({
      year,
      quarter,
      from,
      to,
      /** Whether this response carries the whole team or only the caller's own line. */
      team,
      mine: rows.find((row) => row.user.id === String(req.user._id)) ?? line(req.user),
      rows: rows.sort((a, b) => b.wins - a.wins || a.user.name.localeCompare(b.user.name)),
      currency: (await Settings.getSettings()).sales?.currency || 'EUR',
      totals: {
        target: rows.reduce((sum, row) => sum + (row.target ?? 0), 0),
        wins: rows.reduce((sum, row) => sum + row.wins, 0),
        /** The money halves, both null until there is a rate card and a target in money. */
        targetValue: rows.some((row) => row.targetValue !== null)
          ? Math.round(rows.reduce((sum, row) => sum + (row.targetValue ?? 0), 0) * 100) / 100
          : null,
        value: rows.some((row) => row.value !== null)
          ? Math.round(rows.reduce((sum, row) => sum + (row.value ?? 0), 0) * 100) / 100
          : null,
      },
    });
  })
);

/**
 * Sets somebody's target for a quarter.
 *
 * Managers and admins only: a target somebody sets for themselves is a note, not a target. An
 * upsert on the unique key rather than create-or-patch, because "set the Q3 target to 6" is one
 * intention whether or not a row exists, and asking the caller to know which is a race.
 */
router.put(
  '/targets',
  requireWrite,
  requireRole('admin', 'manager'),
  validate(
    z.object({
      user: z.string().regex(/^[a-f\d]{24}$/i, 'Pick somebody'),
      year: z.number().int().min(2000).max(2200).optional(),
      quarter: z.number().int().min(1).max(4).optional(),
      wins: z.number().int().min(0).max(999),
      /** Accepted now so a rate card does not need a new endpoint later. */
      value: z.number().min(0).nullable().optional(),
      note: z.string().trim().max(300).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const nowQ = quarterOf();
    const year = req.body.year ?? nowQ.year;
    const quarter = req.body.quarter ?? nowQ.quarter;

    const person = await User.findById(req.body.user).select('username firstname lastname roles');
    if (!person) throw notFound('No such person');

    const target = await SalesTarget.findOneAndUpdate(
      { user: person._id, year, quarter },
      {
        $set: {
          wins: req.body.wins,
          value: req.body.value ?? null,
          note: req.body.note ?? '',
          setBy: req.user._id,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.TARGET_SET,
      summary: `${actorName(req.user)} set ${
        String(person._id) === String(req.user._id) ? 'their own' : `${actorName(person)}'s`
      } Q${quarter} ${year} target to ${req.body.wins} win${req.body.wins === 1 ? '' : 's'}`,
      meta: { user: String(person._id), year, quarter, wins: req.body.wins },
    });

    res.json({
      user: String(person._id),
      year: target.year,
      quarter: target.quarter,
      wins: target.wins,
      value: target.value,
      note: target.note,
    });
  })
);

/**
 * Won, delivered, and not yet invoiced.
 *
 * The handoff to whoever raises the invoices, which until now was a conversation. Everything here is
 * already on the record: what was sold, at what price, whether a report has actually gone out, and
 * whether the client will refuse an invoice without a purchase order — that last one being the
 * commonest reason an invoice comes back, and knowable months in advance.
 *
 * `?format=csv` for the people who will want it in a spreadsheet, which is all of them. Deliberately
 * not an integration with an accounts package: this app does not know what one you use, and a
 * column of numbers you can paste is worth more than a connector you cannot configure.
 */
router.get(
  '/invoicing',
  asyncHandler(async (req, res) => {
    const state = String(req.query.state ?? 'outstanding');
    const settings = await Settings.getSettings();

    const won = await Proposal.find({ status: { $in: ['accepted', 'converted'] } })
      .populate([
        { path: 'company', select: 'name billing' },
        { path: 'owner', select: 'username firstname lastname' },
        { path: 'audit', select: 'name reference deletedAt' },
      ])
      .sort({ updatedAt: -1 })
      .limit(500);

    /*
     * "Delivered" means a report has gone out, which is the moment most firms are willing to bill.
     * Read from the deliveries rather than from the engagement's status: a job can be marked
     * finished internally without the client having anything in their hands.
     */
    const auditIds = won.map((proposal) => proposal.audit?._id).filter(Boolean);
    const deliveries = auditIds.length
      ? await Delivery.find({ audit: { $in: auditIds } }).select('audit sentAt').sort({ sentAt: 1 })
      : [];
    const deliveredAt = new Map();
    for (const row of deliveries) {
      const key = String(row.audit);
      if (!deliveredAt.has(key)) deliveredAt.set(key, row.sentAt);
    }

    const rows = won.map((proposal) => {
      const price = priceOf(proposal, proposal.company, settings);
      const delivered = proposal.audit ? (deliveredAt.get(String(proposal.audit._id)) ?? null) : null;
      const poRequired = Boolean(proposal.company?.billing?.poRequired);
      return {
        id: proposal._id,
        reference: proposal.reference,
        title: proposal.title,
        company: proposal.company?.name ?? '',
        companyId: proposal.company?._id ?? null,
        owner: proposal.owner
          ? [proposal.owner.firstname, proposal.owner.lastname].filter(Boolean).join(' ') ||
            proposal.owner.username
          : '',
        wonAt: (proposal.history ?? []).find((entry) => entry.to === 'accepted')?.at ?? null,
        engagement: proposal.audit?.name ?? '',
        days: price.days,
        currency: price.currency,
        net: price.net,
        tax: price.tax,
        total: price.total,
        priced: price.priced,
        deliveredAt: delivered,
        invoicedAt: proposal.billing?.invoicedAt ?? null,
        invoiceRef: proposal.billing?.invoiceRef ?? '',
        poNumber: proposal.billing?.poNumber ?? '',
        poRequired,
        /** The one thing that will stop the invoice being paid, said before it is sent. */
        blocked: poRequired && !proposal.billing?.poNumber ? 'No purchase order' : '',
        invoiceEmail: proposal.company?.billing?.invoiceEmail ?? '',
        paymentTermsDays: price.paymentTermsDays,
      };
    });

    const wanted =
      state === 'all'
        ? rows
        : state === 'invoiced'
          ? rows.filter((row) => row.invoicedAt)
          : /* outstanding: delivered and not invoiced is what somebody can act on today. */
            rows.filter((row) => !row.invoicedAt);

    if (String(req.query.format) === 'csv') {
      const header = [
        'Reference', 'Client', 'Title', 'Won', 'Engagement', 'Delivered', 'Days',
        'Currency', 'Net', 'Tax', 'Total', 'PO', 'PO required', 'Invoice ref', 'Invoiced',
        'Invoice email', 'Terms (days)', 'Owner',
      ];
      const cell = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');
      const lines = [header.join(',')];
      for (const row of wanted) {
        lines.push(
          [
            row.reference, row.company, row.title, day(row.wonAt), row.engagement,
            day(row.deliveredAt), row.days, row.currency, row.net, row.tax, row.total,
            row.poNumber, row.poRequired ? 'yes' : '', row.invoiceRef, day(row.invoicedAt),
            row.invoiceEmail, row.paymentTermsDays, row.owner,
          ]
            .map(cell)
            .join(',')
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        contentDisposition(`invoicing-${new Date().toISOString().slice(0, 10)}.csv`)
      );
      /* A BOM, because the spreadsheet this lands in is Excel and it will otherwise mangle accents. */
      return res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
    }

    res.json({
      state,
      /** Null when nothing is priced, rather than zero: a total of 0 reads as "we sold nothing". */
      totals: {
        rows: wanted.length,
        net: wanted.some((row) => row.priced)
          ? Math.round(wanted.reduce((sum, row) => sum + (row.net ?? 0), 0) * 100) / 100
          : null,
        currency: settings.sales?.currency || 'EUR',
        blocked: wanted.filter((row) => row.blocked).length,
        delivered: wanted.filter((row) => row.deliveredAt).length,
      },
      rows: wanted,
    });
  })
);

/**
 * Where the work came from, counted.
 *
 * The channel is recorded when the proposal is raised — see `PROPOSAL_SOURCES` — and this is the
 * only reason to ask for it. A 70% win rate on referrals against 8% on cold outreach is the
 * difference between a marketing budget and a guess, and it is not reconstructable later.
 */
router.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    const settings = await Settings.getSettings();

    const proposals = await Proposal.find({ createdAt: { $gte: since } })
      .populate({ path: 'company', select: 'name billing' })
      .select('reference status source estimate pricing company createdAt history');

    const buckets = new Map();
    for (const proposal of proposals) {
      /* Everything unlabelled in one honest bucket rather than dropped. */
      const key = proposal.source?.kind || 'not recorded';
      if (!buckets.has(key)) {
        buckets.set(key, { source: key, proposals: 0, won: 0, lost: 0, open: 0, wonValue: 0, priced: false });
      }
      const bucket = buckets.get(key);
      bucket.proposals += 1;
      if (proposal.status === 'declined') bucket.lost += 1;
      else if (proposal.status === 'accepted' || proposal.status === 'converted') {
        bucket.won += 1;
        const price = priceOf(proposal, proposal.company, settings);
        if (price.priced) {
          bucket.priced = true;
          bucket.wonValue += price.net;
        }
      } else bucket.open += 1;
    }

    const rows = [...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        wonValue: bucket.priced ? Math.round(bucket.wonValue * 100) / 100 : null,
        /** Of the decisions, not of everything: open proposals have not lost yet. */
        winRate: bucket.won + bucket.lost ? Math.round((bucket.won / (bucket.won + bucket.lost)) * 100) : null,
      }))
      .sort((a, b) => b.proposals - a.proposals);

    res.json({ months, currency: settings.sales?.currency || 'EUR', rows });
  })
);

/**
 * What jobs like this one actually took.
 *
 * Sales types five days; the last three of these took seven. Both figures are already on the
 * record — `daysSold` on the engagement and the time entries against it — and nobody has ever been
 * shown them side by side at the moment the guess is made.
 *
 * Read from time entries rather than from the engagement's own dates: a job that ran over a fortnight
 * because the client went quiet took the days it took, not the fortnight. Engagements with no time
 * logged are left out entirely rather than counted as zero.
 */
router.get(
  '/comparables',
  asyncHandler(async (req, res) => {
    const auditType = String(req.query.auditType ?? '').trim();
    if (!auditType) throw badRequest('Say which type of work to compare against');

    const audits = await Audit.find({
      auditType,
      deletedAt: null,
    })
      .select('daysSold date_start date_end auditType')
      .sort({ createdAt: -1 })
      .limit(60);

    if (!audits.length) return res.json({ auditType, samples: 0, rows: [] });

    const entries = await TimeEntry.aggregate([
      { $match: { audit: { $in: audits.map((audit) => audit._id) } } },
      { $group: { _id: '$audit', hours: { $sum: '$hours' } } },
    ]);
    const hoursBy = new Map(entries.map((row) => [String(row._id), row.hours]));

    const rows = audits
      .map((audit) => {
        const hours = hoursBy.get(String(audit._id)) ?? 0;
        return {
          /* No client names: the numbers are the useful part, and this is readable by sales. */
          days: hours ? Math.round((hours / HOURS_PER_DAY) * 10) / 10 : null,
          soldDays: audit.daysSold ?? null,
          endedOn: audit.date_end ?? '',
        };
      })
      .filter((row) => row.days !== null)
      .slice(0, 12);

    const median = (numbers) => {
      if (!numbers.length) return null;
      const sorted = [...numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
    };

    const actual = rows.map((row) => row.days);
    const sold = rows.map((row) => row.soldDays).filter((value) => value !== null);
    /* Only where both exist, or the gap would be measured against nothing. */
    const gaps = rows
      .filter((row) => row.soldDays !== null)
      .map((row) => Math.round((row.days - row.soldDays) * 10) / 10);

    res.json({
      auditType,
      samples: rows.length,
      actual: { median: median(actual), min: Math.min(...actual), max: Math.max(...actual) },
      sold: { median: median(sold) },
      /** Positive means the work took longer than it was sold for, which is the usual direction. */
      gap: { median: median(gaps), over: gaps.filter((value) => value > 0).length },
      rows,
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => res.json(await presentOne(await load(req.params.id), req.user)))
);

/* -------------------------------------------------------------------------- */
/* Creating and editing                                                       */
/* -------------------------------------------------------------------------- */

const proposalSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(200),
  company: objectId,
  contacts: z.array(objectId).max(20).optional(),
  auditType: z.string().trim().max(120).optional(),
  summary: z.string().max(20_000).optional(),
  constraints: z.string().max(20_000).optional(),
  requestedOn: day.optional(),
  expectedStart: day.optional(),
  expectedEnd: day.optional(),
  validUntil: day.optional(),
  /** What sales thinks it is. The work side sets the agreed figure on its own route. */
  salesDays: z.number().min(0).max(400).nullable().optional(),
  /**
   * Which channel it arrived through, and the detail that makes the channel useful.
   *
   * Validated against the list rather than free text: "referral", "Referral" and "ref" are three
   * rows in a count that should have one, and this is a field whose only purpose is being counted.
   */
  source: z
    .object({
      kind: z
        .enum(PROPOSAL_SOURCES)
        .or(z.literal(''))
        .optional(),
      detail: z.string().trim().max(200).optional(),
    })
    .optional(),
  /**
   * Several engagements sold as one agreement.
   *
   * Both halves optional and both meaningless alone, which the model's comment explains: one
   * engagement every three months is a one-off with a stray number attached, and four engagements
   * with no interval is a wish. Everything downstream tests for the pair.
   */
  retainer: z
    .object({
      engagements: z.number().int().min(0).max(24).optional(),
      everyMonths: z.number().int().min(1).max(24).nullable().optional(),
    })
    .optional(),
  owner: objectId.nullable().optional(),
});

router.post(
  '/',
  requireWrite,
  validate(proposalSchema),
  asyncHandler(async (req, res) => {
    if (audienceOf(req.user) === 'work') {
      throw forbidden('Proposals are raised by the sales side.');
    }
    const company = await Company.findById(req.body.company);
    if (!company) throw badRequest('That client is not on record yet.');

    const { salesDays, ...rest } = req.body;
    // The same trick the engagement blueprint uses, so a phishing campaign stays a phishing
    // campaign all the way from the enquiry to the report.
    const type = rest.auditType ? await AuditType.findOne({ name: rest.auditType }) : null;

    const proposal = await Proposal.create({
      ...rest,
      kind: type?.kind ?? 'standard',
      reference: await nextReference(),
      owner: rest.owner ?? req.user._id,
      estimate: { salesDays: salesDays ?? null },
      requestedOn: rest.requestedOn || new Date().toISOString().slice(0, 10),
      history: [{ from: '', to: 'draft', by: req.user._id, at: new Date(), note: 'Raised' }],
    });

    const full = await load(proposal._id);
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_RAISED,
      summary: `${actorName(req.user)} raised ${full.reference} for ${full.company?.name ?? 'a client'}`,
      proposal: full,
      meta: { salesDays: salesDays ?? null },
    });
    res.status(201).json(await presentOne(full, req.user));
  })
);

router.put(
  '/:id',
  requireWrite,
  validate(proposalSchema.partial()),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'work') {
      throw forbidden('The sales side owns these fields. You can change the estimate instead.');
    }
    /*
     * Frozen once it is with the client. Editing the title or the dates under a proposal that
     * has been sent would mean the paperwork on their desk and the record here disagree, and
     * nobody would know which one the client accepted.
     */
    if (['sent', 'accepted', 'converted'].includes(proposal.status)) {
      throw badRequest('This proposal is already with the client. Its details are fixed now.');
    }

    const { salesDays, ...rest } = req.body;
    Object.assign(proposal, rest);
    if (salesDays !== undefined) proposal.estimate.salesDays = salesDays;
    if (rest.auditType) {
      const type = await AuditType.findOne({ name: rest.auditType });
      proposal.kind = type?.kind ?? 'standard';
    }
    await proposal.save();

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_UPDATED,
      summary: `${actorName(req.user)} edited ${proposal.reference}`,
      proposal,
      meta: { fields: Object.keys(req.body) },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

router.delete(
  '/:id',
  requireWrite,
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'work') throw forbidden('Only the sales side removes a proposal.');
    /*
     * Blocked only while a *live* engagement exists.
     *
     * It used to be blocked whenever the field was set, which was a dead end: deleting the
     * engagement puts it in the trash rather than destroying it, so the field stayed pointing at
     * something and the refusal kept telling somebody to do the thing they had just done. Worse,
     * once the engagement was finally purged the field still held its id — nothing cleared it —
     * so the proposal could never be deleted at all. The purge unlinks it now, and this reads
     * what is actually there.
     */
    if (proposal.audit && !proposal.audit.deletedAt) {
      throw badRequest(
        `"${proposal.audit.name}" was created from this proposal. Delete that engagement first — ` +
          'it goes to the trash, and this can be deleted as soon as it does.'
      );
    }

    // The bytes as well as the record: an orphaned file in GridFS is a client's contract
    // nobody can see and nobody will ever clean up.
    const files = (proposal.documents ?? []).length;
    for (const doc of proposal.documents ?? []) await deleteDocumentFile(doc.file);

    const { reference, title, status } = proposal;
    const company = proposal.company?._id ?? proposal.company ?? null;
    await proposal.deleteOne();
    /*
     * Logged with the reference and title as text rather than only as a link — this is the one
     * entry whose subject no longer exists, and "deleted a proposal" naming nothing would be
     * the least useful row in the log.
     */
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_DELETED,
      summary: `${actorName(req.user)} deleted ${reference} (${title}), which was ${status}`,
      // Explicitly, because the proposal is gone by now and there is nothing left to read it
      // from. Without this the one entry whose subject no longer exists named nothing.
      proposalRef: reference,
      company,
      target: title,
      meta: { reference, status, documents: files },
    });
    res.json({ ok: true, id: req.params.id });
  })
);

/* -------------------------------------------------------------------------- */
/* The estimate, and the evaluation                                           */
/* -------------------------------------------------------------------------- */

/**
 * What it will actually take.
 *
 * The work side only, at any status — that is the explicit ask: sales may have put more or
 * fewer days than the job needs, and the number can be corrected after the fact. Correcting it
 * on a proposal already sent does not rewrite what the client was told; it records what we now
 * believe, which is what the inquiries page and capacity planning need.
 */
router.put(
  '/:id/estimate',
  requireWrite,
  validate(
    z.object({
      days: z.number().min(0).max(400).nullable(),
      note: z.string().max(2000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'sales') {
      throw forbidden(
        'The agreed effort is set by whoever would do the work. Your own figure is the one on the proposal.'
      );
    }

    const was = proposal.estimate.days ?? null;
    proposal.estimate.days = req.body.days;
    if (req.body.note !== undefined) proposal.estimate.note = req.body.note;
    proposal.estimate.by = req.user._id;
    proposal.estimate.at = new Date();
    await proposal.save();

    /*
     * Both figures in the summary, because this is the entry an admin actually came for:
     * "sales said five, this was made nine" is the sentence, not "the estimate changed".
     */
    const quoted = proposal.estimate.salesDays;
    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.ESTIMATE_SET,
      summary:
        `${actorName(req.user)} set ${proposal.reference} to ${req.body.days ?? '—'} days` +
        (quoted === null || quoted === undefined ? '' : ` (sales quoted ${quoted})`) +
        (was === null ? '' : `, was ${was}`),
      proposal,
      meta: { days: req.body.days, previous: was, salesDays: quoted ?? null },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

/**
 * The kickoff call, and what came out of it.
 *
 * Either side may write it, unlike the estimate and the evaluation. The call is sales' to
 * arrange and the technical people ask the questions on it, so restricting this to one of them
 * would mean whoever actually attended could not record what was said.
 *
 * Editable after the offer has gone out, unlike the proposal's other details: a kickoff often
 * happens *after* the paperwork is signed, and the permission to attack is regenerated from it.
 */
router.put(
  '/:id/kickoff',
  requireWrite,
  validate(
    z.object({
      heldOn: day.optional(),
      attendeesOurs: z.string().max(2000).optional(),
      attendeesTheirs: z.string().max(2000).optional(),
      emergencyContact: z.string().max(300).optional(),
      notes: z.string().max(20_000).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    const first = !proposal.kickoff?.heldOn;

    for (const [key, value] of Object.entries(req.body)) {
      if (value !== undefined) proposal.kickoff[key] = value;
    }
    proposal.kickoff.by = req.user._id;
    proposal.kickoff.at = new Date();
    await proposal.save();

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.KICKOFF_RECORDED,
      summary: `${actorName(req.user)} ${first ? 'recorded' : 'updated'} the kickoff for ${
        proposal.reference
      }${proposal.kickoff.heldOn ? ` (held ${proposal.kickoff.heldOn})` : ''}`,
      proposal,
      meta: { heldOn: proposal.kickoff.heldOn },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

/** The technical read. Recording it is what `evaluating → evaluated` is waiting for. */
router.put(
  '/:id/evaluation',
  requireWrite,
  validate(
    z.object({
      notes: z.string().max(20_000).optional(),
      verdict: z.enum(['feasible', 'needs-more-info', 'not-for-us', '']).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'sales') throw forbidden('The evaluation is not yours to write.');

    if (req.body.notes !== undefined) proposal.evaluation.notes = req.body.notes;
    if (req.body.verdict !== undefined) proposal.evaluation.verdict = req.body.verdict;
    proposal.evaluation.by = req.user._id;
    proposal.evaluation.at = new Date();
    await proposal.save();

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.EVALUATION_WRITTEN,
      summary: `${actorName(req.user)} evaluated ${proposal.reference}${
        proposal.evaluation.verdict ? ` — ${proposal.evaluation.verdict}` : ''
      }`,
      proposal,
      meta: { verdict: proposal.evaluation.verdict },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

router.post(
  '/:id/status',
  requireWrite,
  validate(
    z.object({
      status: z.enum(PROPOSAL_STATUSES),
      note: z.string().max(2000).optional(),
      /*
       * Why it closed. Required by `moveProposal` for a loss, optional for a win — the asymmetry is
       * deliberate: a loss with no reason is the entry that makes the report useless, and a win we
       * cannot explain is merely a shame.
       */
      reason: z.string().trim().max(40).optional(),
      competitor: z.string().trim().max(120).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    const from = proposal.status;
    await moveProposal(proposal, req.body.status, req.user, req.body.note ?? '', {
      reason: req.body.reason ?? '',
      competitor: req.body.competitor ?? '',
    });

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_MOVED,
      summary: `${actorName(req.user)} moved ${proposal.reference} from ${from} to ${
        proposal.status
      }${proposal.outcome?.reason ? ` (${proposal.outcome.reason})` : ''}${
        req.body.note ? ` — ${req.body.note}` : ''
      }`,
      proposal,
      meta: {
        from,
        to: proposal.status,
        note: req.body.note ?? '',
        reason: proposal.outcome?.reason ?? '',
        competitor: proposal.outcome?.competitor ?? '',
      },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

/**
 * Turns an accepted proposal into the engagement it was always going to become.
 *
 * The work side, not sales: this creates a job with a team and a template, which is theirs to
 * run. Everything that can be carried across is — the client, the contact, the type, the
 * window, the agreed days — because retyping it is how the engagement ends up saying something
 * different from the contract.
 */
/**
 * Next year's, from last year's.
 *
 * A repeat client's annual test is the same proposal with the dates moved: the same scope, the same
 * constraints, the same contacts, a new reference. Retyping it is half an hour and an opportunity to
 * leave something out — and the thing most often left out is a constraint the client cared about.
 *
 * What is *not* copied matters more than what is. The estimate belongs to whoever agreed it and is
 * about the job as it was scoped then, so a clone starts unevaluated and goes round the loop again.
 * The paperwork is not copied either: an NDA is signed, a permission to attack names dates, and a
 * generated document carried across would be a contract about last year with this year's reference on
 * it. Only the request survives, which is the part sales wrote.
 */
router.post(
  '/:id/clone',
  requireWrite,
  validate(
    z.object({
      title: z.string().trim().max(200).optional(),
      expectedStart: day.optional(),
      expectedEnd: day.optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const source = await load(req.params.id);

    /** A year on, unless the caller said otherwise — which is what "annual" means. */
    const shift = (value) => {
      if (!value) return '';
      const at = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(at.getTime())) return '';
      at.setUTCFullYear(at.getUTCFullYear() + 1);
      return at.toISOString().slice(0, 10);
    };

    const clone = await Proposal.create({
      reference: await nextReference(),
      title: req.body.title || source.title,
      company: source.company?._id ?? source.company,
      contacts: (source.contacts ?? []).map((contact) => contact?._id ?? contact),
      auditType: source.auditType ?? '',
      kind: source.kind ?? 'standard',
      summary: source.summary ?? '',
      constraints: source.constraints ?? '',
      expectedStart: req.body.expectedStart ?? shift(source.expectedStart),
      expectedEnd: req.body.expectedEnd ?? shift(source.expectedEnd),
      /* Sales' own figure carries; the figure the work side agreed does not. */
      estimate: { salesDays: source.estimate?.salesDays ?? null },
      retainer: {
        engagements: source.retainer?.engagements ?? 0,
        everyMonths: source.retainer?.everyMonths ?? null,
      },
      owner: req.user._id,
      status: 'draft',
      /*
       * Raised today, and it says so.
       *
       * Both of these are what `POST /` sets on any new proposal, and leaving them out left the
       * clone with a blank "requested on" and an empty "how it got here" — a record that looks like
       * it appeared out of nowhere. The ask is new even though the scope is last year's.
       */
      requestedOn: new Date().toISOString().slice(0, 10),
      history: [
        {
          from: '',
          to: 'draft',
          by: req.user._id,
          at: new Date(),
          note: `Raised again from ${source.reference}`,
        },
      ],
      createdBy: req.user._id,
    });

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_RAISED,
      summary: `${actorName(req.user)} raised ${clone.reference} from ${source.reference}`,
      proposal: clone,
      meta: { clonedFrom: source.reference },
    });

    res.status(201).json(await presentOne(await load(clone._id), req.user));
  })
);

/* -------------------------------------------------------------------------- */
/* The argument about the estimate                                            */
/* -------------------------------------------------------------------------- */

/**
 * Comments, readable and writable by both audiences.
 *
 * The point is that sales and the people who would do the work can argue about a number in the place
 * the number lives. Not logged to the sales activity feed: that feed is admin-only and about the flow,
 * and a comment is already visible to everybody who can see the proposal.
 */
router.post(
  '/:id/comments',
  requireWrite,
  validate(z.object({ body: z.string().trim().min(1, 'Say something').max(4000) })),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    proposal.comments.push({ author: req.user._id, body: req.body.body });
    await proposal.save();
    res.status(201).json(await presentOne(await load(proposal._id), req.user));
  })
);

router.delete(
  '/:id/comments/:commentId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    const comment = proposal.comments.id(req.params.commentId);
    if (!comment) throw notFound('Comment not found');
    /*
     * The author, or an admin. Somebody else editing what you said is not a comment thread.
     *
     * `author?._id ?? author` because `load` populates it: comparing the populated document to an id
     * refused everybody their own comment, which is how the suite found this. Written so it holds
     * whether the path is populated or not, rather than depending on which loader got here.
     */
    const wroteIt = String(comment.author?._id ?? comment.author ?? '') === String(req.user._id);
    if (!wroteIt && req.user.role !== 'admin') {
      throw forbidden('Only whoever wrote a comment can remove it');
    }
    comment.deleteOne();
    await proposal.save();
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

router.post(
  '/:id/convert',
  requireWrite,
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'sales') {
      throw forbidden('An engagement is created by whoever will run it.');
    }
    if (proposal.status !== 'accepted') {
      throw badRequest('Only an accepted proposal becomes an engagement.');
    }
    if (proposal.audit) throw badRequest('An engagement has already been created from this.');

    const audit = await Audit.create({
      name: proposal.title,
      company: proposal.company?._id ?? proposal.company,
      client: proposal.contacts?.[0]?._id ?? null,
      auditType: proposal.auditType ?? '',
      kind: proposal.kind ?? 'standard',
      date_start: proposal.expectedStart || '',
      date_end: proposal.expectedEnd || '',
      createdBy: req.user._id,
      collaborators: [req.user._id],
      /** Where it came from, so the engagement can point back at what was sold. */
      proposal: proposal._id,
      /** Days sold, which is the number the job is measured against. */
      daysSold: proposal.effortDays() ?? null,
      /*
       * A retainer sets the engagement up to nudge when the next one is due, rather than creating
       * them all now. Four half-built engagements with nobody booked onto them is a surprise; a
       * reminder on the date with a button that builds the next one from this is the same agreement
       * without the app making commitments on the team's behalf. See `repeat` on the audit.
       */
      ...(proposal.retainer?.engagements > 1 && proposal.retainer?.everyMonths
        ? {
            repeat: {
              months: proposal.retainer.everyMonths,
              nextDue: nextDueAfter(proposal.expectedStart, proposal.retainer.everyMonths),
            },
          }
        : {}),
    });

    proposal.audit = audit._id;
    await moveProposal(proposal, 'converted', req.user, `Engagement ${audit.name} created`);

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.PROPOSAL_CONVERTED,
      summary: `${actorName(req.user)} turned ${proposal.reference} into the engagement ${audit.name}`,
      proposal,
      meta: {
        audit: audit._id.toString(),
        daysSold: audit.daysSold ?? null,
        ...(proposal.retainer?.engagements > 1
          ? { retainer: `1 of ${proposal.retainer.engagements}` }
          : {}),
      },
    });

    res.status(201).json({
      proposal: await presentOne(await load(proposal._id), req.user),
      audit: { id: audit._id.toString(), name: audit.name },
    });
  })
);

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

/** Generates one piece of paperwork from a proposal template. */
router.post(
  '/:id/documents/generate',
  requireWrite,
  validate(z.object({ template: objectId })),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'work' && req.user.role !== 'admin') {
      throw forbidden('The paperwork is drawn up by the sales side.');
    }
    if (['sent', 'accepted', 'converted'].includes(proposal.status)) {
      throw badRequest('This proposal has already gone out. Regenerating would not change it.');
    }

    const template = await Template.findById(req.body.template);
    if (!template) throw notFound('Template not found');

    const { replaced } = await generateProposalDocument({ proposal, template, user: req.user });
    // After the save, so a failed render never loses the file that was there before.
    for (const fileId of replaced) await deleteDocumentFile(fileId);

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.DOCUMENT_GENERATED,
      summary: `${actorName(req.user)} generated the ${template.docType || 'document'} for ${
        proposal.reference
      }${replaced.length ? ' (replacing the previous one)' : ''}`,
      proposal,
      meta: { docType: template.docType, template: template.name, replaced: replaced.length },
    });
    res.status(201).json(await presentOne(await load(proposal._id), req.user));
  })
);

/** What the client sent us — the request, a signed copy, their own template. */
router.post(
  '/:id/documents',
  requireWrite,
  uploadDocument,
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (!req.file) throw badRequest('No file was uploaded');
    if (req.file.size > MAX_DOCUMENT_BYTES) {
      throw badRequest(`Files are limited to ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`);
    }

    const stored = await storeDocument({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      proposalId: proposal._id,
      uploadedBy: req.user._id,
    });

    proposal.documents.push({
      docType: req.body.docType || 'request',
      label: req.body.label || '',
      filename: stored.filename,
      file: stored.file,
      bytes: stored.bytes,
      sha256: stored.sha256,
      contentType: req.file.mimetype ?? '',
      // Not generated, so it is not waiting on anybody's approval.
      generated: false,
      addedBy: req.user._id,
      addedAt: new Date(),
    });
    await proposal.save();

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.DOCUMENT_UPLOADED,
      summary: `${actorName(req.user)} attached ${stored.filename} to ${proposal.reference}`,
      proposal,
      meta: { filename: stored.filename, bytes: stored.bytes },
    });
    res.status(201).json(await presentOne(await load(proposal._id), req.user));
  })
);

/**
 * Sign-off, or send it back with a reason.
 *
 * Only generated documents: there is no sense in approving a PDF the client emailed us, and
 * offering the button would suggest the approval means something about their paperwork.
 */
router.post(
  '/:id/documents/:documentId/review',
  requireWrite,
  validate(z.object({ approved: z.boolean(), reason: z.string().max(2000).optional() })),
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    if (audienceOf(req.user) === 'sales') {
      throw forbidden('Somebody other than the author signs the paperwork off.');
    }

    if (!canSignOff(req.user)) {
      throw forbidden(
        'Signing a client’s paperwork off takes a manager. Ask somebody who holds that role.'
      );
    }

    const doc = proposal.documents.id(req.params.documentId);
    if (!doc) throw notFound('Document not found');
    if (!doc.generated) throw badRequest('That one came from the client. There is nothing to sign off.');

    if (req.body.approved) {
      doc.approvedBy = req.user._id;
      doc.approvedAt = new Date();
      doc.rejectedBy = null;
      doc.rejectedAt = null;
      doc.rejectedReason = '';
    } else {
      if (!req.body.reason) throw badRequest('Say what is wrong with it, or it cannot be fixed.');
      doc.rejectedBy = req.user._id;
      doc.rejectedAt = new Date();
      doc.rejectedReason = req.body.reason;
      doc.approvedBy = null;
      doc.approvedAt = null;
    }
    await proposal.save();

    await logSales({
      actor: req.user,
      action: req.body.approved ? SALES_ACTIONS.DOCUMENT_APPROVED : SALES_ACTIONS.DOCUMENT_REJECTED,
      summary: req.body.approved
        ? `${actorName(req.user)} signed off the ${doc.docType} for ${proposal.reference}`
        : `${actorName(req.user)} sent back the ${doc.docType} for ${proposal.reference} — ${req.body.reason}`,
      proposal,
      meta: { docType: doc.docType, reason: req.body.reason ?? '' },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

router.get(
  '/:id/documents/:documentId/download',
  asyncHandler(async (req, res) => {
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) throw notFound('Proposal not found');
    const doc = proposal.documents.id(req.params.documentId);
    if (!doc) throw notFound('Document not found');

    const stream = await openDocument(doc.file);
    // The same rules as a client's engagement documents: our content type, never inline, no
    // sniffing. A proposal attachment is bytes somebody emailed us, exactly like those.
    res.setHeader('Content-Type', serveableType(doc.contentType));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', doc.bytes);
    res.setHeader('Content-Disposition', contentDisposition(safeFilename(doc.filename)));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  })
);

router.delete(
  '/:id/documents/:documentId',
  requireWrite,
  asyncHandler(async (req, res) => {
    const proposal = await load(req.params.id);
    const doc = proposal.documents.id(req.params.documentId);
    if (!doc) throw notFound('Document not found');

    const fileId = doc.file;
    const { docType, filename } = doc;
    doc.deleteOne();
    await proposal.save();
    await deleteDocumentFile(fileId);

    await logSales({
      actor: req.user,
      action: SALES_ACTIONS.DOCUMENT_REMOVED,
      summary: `${actorName(req.user)} removed ${filename} from ${proposal.reference}`,
      proposal,
      meta: { docType, filename },
    });
    res.json(await presentOne(await load(proposal._id), req.user));
  })
);

export default router;
