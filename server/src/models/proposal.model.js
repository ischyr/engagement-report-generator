import mongoose from 'mongoose';

/**
 * Work that has been asked for but not yet sold.
 *
 * Its own collection rather than an engagement in an early state, and that is the important
 * decision here. An engagement is work in progress: it has a scope, findings, a team booked
 * onto it and a report at the end. A proposal has none of that and never will — most of the
 * fields would sit empty, `visibleAuditFilter` would have to learn about a state where
 * nobody is a collaborator yet, and every count of "engagements" in the app would silently
 * start including work that may never happen. The two become one record at the moment
 * somebody says yes, and not before.
 *
 * It is also the only record in this app that two audiences own different halves of. Sales
 * owns the client, the request and the dates; the people who would do the work own the
 * estimate and whether the paperwork is fit to send. The status is what hands it between
 * them, which is why the transitions are a table rather than a free-text field.
 */

/**
 * Where a proposal has got to.
 *
 * Each one is a fact somebody outside the app would recognise, not a step in a wizard:
 *
 *   draft             sales is still writing it
 *   evaluating        with the technical side, waiting for an estimate
 *   evaluated         the effort is agreed; the paperwork can be drawn up
 *   documents-review  documents generated, waiting to be checked before they leave
 *   sent              the proposal is with the client
 *   accepted          they said yes — an inquired engagement
 *   declined          they said no, or we withdrew
 *   converted         an engagement has been created from it
 *
 * `declined` exists because a pipeline with no way to lose is a list that only grows, and
 * `converted` because "accepted" and "already turned into a job" are different questions —
 * without it the inquiries page cannot tell which ones still need doing.
 */
export const PROPOSAL_STATUSES = [
  'draft',
  'evaluating',
  'evaluated',
  'documents-review',
  'sent',
  'accepted',
  'declined',
  'converted',
];

export const PROPOSAL_STATUS_LABELS = {
  draft: 'Draft',
  evaluating: 'Being evaluated',
  evaluated: 'Effort agreed',
  'documents-review': 'Documents in review',
  sent: 'Offer sent',
  accepted: 'Offer accepted',
  declined: 'Declined',
  converted: 'Engagement created',
};

/** Still live: worth chasing, and counted in the pipeline. */
export const PROPOSAL_OPEN_STATUSES = [
  'draft',
  'evaluating',
  'evaluated',
  'documents-review',
  'sent',
];

/**
 * Who may make each move, and where it can go.
 *
 * A table rather than a scatter of `if`s in the route, because the flow *is* this table:
 * reading it should tell somebody what the process is. `sales` and `work` name the two
 * audiences — an admin passes either.
 *
 *   `work` is the people who would do the job: they say what it will take, and whether the
 *   paperwork is fit to send. Sales cannot mark its own estimate agreed, which is the whole
 *   reason the evaluation step exists.
 */
export const PROPOSAL_TRANSITIONS = {
  draft: [{ to: 'evaluating', by: 'sales' }],
  evaluating: [
    { to: 'evaluated', by: 'work' },
    // Back to sales, because "we cannot price this without knowing X" is a real answer and
    // the alternative is an estimate somebody invented.
    { to: 'draft', by: 'work' },
  ],
  evaluated: [
    { to: 'documents-review', by: 'sales' },
    { to: 'evaluating', by: 'work' },
  ],
  'documents-review': [
    { to: 'sent', by: 'sales' },
    // Rejected: something in the generated paperwork is wrong.
    { to: 'evaluated', by: 'work' },
  ],
  sent: [
    { to: 'accepted', by: 'sales' },
    { to: 'declined', by: 'sales' },
  ],
  accepted: [
    { to: 'converted', by: 'work' },
    // A client can still pull out after accepting, and pretending otherwise means editing
    // the database when they do.
    { to: 'declined', by: 'sales' },
  ],
  declined: [{ to: 'draft', by: 'sales' }],
  converted: [],
};

/**
 * Why a proposal closed the way it did.
 *
 * A pipeline that records only *that* something was lost is a list of dates. Six months of "why"
 * is the most useful report a sales section produces — it is the difference between "we lose a lot"
 * and "we lose on lead time, in September, to the same two competitors" — and it costs one field
 * plus the discipline of asking for it at the moment somebody already has the answer in their head.
 *
 * Two vocabularies, because winning and losing are not the same question with opposite answers.
 * "We were cheapest" and "we were too expensive" are both about price and mean different things to
 * whoever sets the rates.
 */
export const LOSS_REASONS = [
  'price',
  'timing',
  'budget',
  'competitor',
  'in-house',
  'scope',
  'no-response',
  'other',
];

export const LOSS_REASON_LABELS = {
  price: 'Too expensive',
  timing: 'Could not do it when they needed it',
  budget: 'No budget this cycle',
  competitor: 'Went to a competitor',
  'in-house': 'Doing it themselves',
  scope: 'Wanted something we do not do',
  'no-response': 'Went quiet',
  other: 'Something else',
};

export const WIN_REASONS = [
  'relationship',
  'price',
  'availability',
  'specialism',
  'referral',
  'incumbent',
  'other',
];

export const WIN_REASON_LABELS = {
  relationship: 'They know us',
  price: 'Price',
  availability: 'We could start when they needed',
  specialism: 'The specific expertise',
  referral: 'Referred to us',
  incumbent: 'We did the last one',
  other: 'Something else',
};

/**
 * Where the work came from.
 *
 * Win and loss reasons say *why* we won; this says *which channel it arrived through*, and the two
 * answer different questions. Knowing the win rate on referrals is 70% and on cold outbound 8% is
 * the difference between a marketing budget and a guess — and it cannot be reconstructed later,
 * because six months on nobody remembers who introduced whom.
 */
export const PROPOSAL_SOURCES = [
  'referral',
  'existing-client',
  'inbound',
  'outbound',
  'partner',
  'event',
  'tender',
  'other',
];

export const PROPOSAL_SOURCE_LABELS = {
  referral: 'Referral',
  'existing-client': 'Existing client',
  inbound: 'Came to us',
  outbound: 'We approached them',
  partner: 'Through a partner',
  event: 'Event or talk',
  tender: 'Tender',
  other: 'Something else',
};

/** How a price gets past the floor: somebody with the authority says so. */
export const PRICE_APPROVAL_STATES = ['not-needed', 'pending', 'approved', 'rejected'];

/**
 * Something somebody said about this proposal.
 *
 * Sales asks why an estimate is five days and not three; the person who wrote it answers. Today that
 * exchange happens in email, which means the next person to pick the proposal up cannot see it —
 * and the evaluation note is one person's verdict rather than a conversation. Findings have had
 * comments for exactly this reason; a proposal is the other document a firm argues about.
 */
const proposalCommentSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    body: { type: String, required: true, maxlength: 4000 },
  },
  { timestamps: true }
);

/** One generated or uploaded file. */
const fileSchema = new mongoose.Schema(
  {
    /**
     * What this file is.
     *
     * The generated kinds are in PROPOSAL_DOC_TYPES. `pre-engagement` is the document sales
     * writes up from the request and uploads here — the thing the NDA, the permission and the
     * offer are all drawn from. `request` is the older name for the same slot and still reads.
     */
    docType: { type: String, default: 'other' },
    label: { type: String, default: '' },
    filename: { type: String, required: true },
    /** GridFS id in the shared documents bucket. */
    file: { type: mongoose.Schema.Types.ObjectId, required: true },
    bytes: { type: Number, default: 0 },
    sha256: { type: String, default: '' },
    contentType: { type: String, default: '' },

    /**
     * Whether we made it or the client sent it.
     *
     * Only a generated document needs approving — there is no sense in an operator signing
     * off a PDF the client emailed us.
     */
    generated: { type: Boolean, default: false },
    /** Which template produced it, so "regenerate after fixing the template" is possible. */
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedAt: { type: Date, default: Date.now },

    /** Signed off as fit to send, and by whom. Null means nobody has looked. */
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    /** Sent back with a reason, which is more use to whoever fixes it than a rejection alone. */
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectedReason: { type: String, default: '' },
  },
  { timestamps: false }
);

const proposalSchema = new mongoose.Schema(
  {
    /** PRO-2026-014, for the paperwork to refer to itself by. */
    reference: { type: String, default: '', trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },

    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Everyone at the client this proposal is addressed to, the first one primary. */
    contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],

    /** What kind of work: the same taxonomy an engagement uses, so it carries across. */
    auditType: { type: String, default: '', trim: true },
    /** 'standard' or 'phishing', copied from the type the way the engagement blueprint does. */
    kind: { type: String, default: 'standard' },

    /**
     * Several engagements sold as one agreement — four quarterly tests, two half-yearly retests.
     *
     * Deliberately not a new kind of proposal. It is the same offer with a schedule attached, and the
     * delivery half already exists: an engagement's `repeat` block nudges when the next one is due, so
     * converting a retainer sets that up rather than creating four engagements nobody asked for yet.
     * The commercial half — that the client has bought all of them — is what this records.
     *
     * `engagements: 0` or absent means an ordinary one-off, which is nearly every proposal.
     */
    retainer: {
      /** How many engagements the agreement covers, including the first. */
      engagements: { type: Number, default: 0, min: 0, max: 24 },
      /** Months between one and the next. */
      everyMonths: { type: Number, default: null, min: 1, max: 24 },
    },

    /** What they asked for, in the words it arrived in. */
    summary: { type: String, default: '' },
    /** Anything that shapes the price: environments, out of hours, retest included. */
    constraints: { type: String, default: '' },

    /** `yyyy-mm-dd`, like every other day in this app. */
    requestedOn: { type: String, default: '' },
    expectedStart: { type: String, default: '' },
    expectedEnd: { type: String, default: '' },
    /** When the offer lapses, which is the only date on here that creates urgency. */
    validUntil: { type: String, default: '' },

    /** The salesperson whose deal this is. */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    status: { type: String, enum: PROPOSAL_STATUSES, default: 'draft', index: true },

    /**
     * How much work it is, in days.
     *
     * Two numbers on purpose, and this is the point of the whole evaluation step: `salesDays`
     * is what the salesperson thought when they took the call, `days` is what the people who
     * would do it say. Keeping both means an override is visible as an override — one field
     * overwritten in place would quietly erase the fact that anybody disagreed, and "sales
     * keeps promising five days for a fortnight's work" is exactly the thing worth seeing.
     */
    estimate: {
      salesDays: { type: Number, default: null, min: 0, max: 400 },
      days: { type: Number, default: null, min: 0, max: 400 },
      note: { type: String, default: '' },
      /** Who last set the agreed figure, and when. */
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
    },

    /**
     * The kickoff call, and what came out of it.
     *
     * Its own block because the paperwork needs it and nothing else in the app records it. A
     * permission to attack is only worth signing if it names who agreed to what and when, and an
     * emergency contact is the field somebody actually reaches for at two in the morning when a
     * test has taken something down — neither belongs in a free-text summary where a template
     * cannot find it.
     *
     * Recorded by either side. The call is sales' to arrange and the technical people are the
     * ones who ask the questions, so making it one side's to write down would mean whoever was
     * on the call could not.
     */
    kickoff: {
      heldOn: { type: String, default: '' },
      /** Who was there, in words: a kickoff has people on it who have no account here. */
      attendeesOurs: { type: String, default: '' },
      attendeesTheirs: { type: String, default: '' },
      /**
       * Who to ring during testing, and on what number.
       *
       * A permission to attack without one is a document that tells somebody they may break
       * things and not who to tell when they do.
       */
      emergencyContact: { type: String, default: '' },
      /** What was agreed — the notes the NDA and the permission are written from. */
      notes: { type: String, default: '' },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
    },

    /** The technical read on whether this is doable, and on what terms. */
    evaluation: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      notes: { type: String, default: '' },
      /** 'feasible' | 'needs-more-info' | 'not-for-us' */
      verdict: { type: String, default: '' },
    },

    /** Generated paperwork and whatever the client sent in. */
    documents: [fileSchema],

    /**
     * Every status change, oldest first.
     *
     * On the proposal rather than in the activity log, because the activity log is keyed to an
     * engagement and this is not one. Short and bounded — a proposal has a handful of moves in
     * its life, unlike an engagement's history.
     */
    history: [
      {
        _id: false,
        from: { type: String, default: '' },
        to: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
      },
    ],

    /** Set when it becomes real work, so the inquiry can link to the job it turned into. */
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
    declineReason: { type: String, default: '' },

    /** The argument about the estimate, kept where the estimate is. */
    comments: [proposalCommentSchema],

    /**
     * The price, as the two figures it is actually negotiated in.
     *
     * A day rate and a discount rather than a total: the total is arithmetic over the days the work
     * side agreed, and storing it as well would mean two numbers that can disagree — which is the
     * bug where a proposal says 40,000 and the paperwork says 45,000. Both fields fall back, so an
     * ordinary proposal carries neither: the rate comes from the client, and the client's comes from
     * the rate card. See `priceOf` in pricing.service.js, which is the only place this is turned
     * into money.
     */
    pricing: {
      /** What was quoted, when it is not the client's rate. Null means "whatever the rate card says". */
      dayRate: { type: Number, default: null, min: 0, max: 1_000_000 },
      discountPercent: { type: Number, default: 0, min: 0, max: 100 },
      /** Why the price is what it is — the sentence a manager reads before signing it off. */
      note: { type: String, default: '', maxlength: 2000 },
      /**
       * Sign-off, when the price is below the floor or the discount above the cap.
       *
       * `forRate` and `forDiscount` are the figures the approval was actually given for. Without
       * them, getting 20% approved and then quietly typing 45% would keep the approval — the
       * signature has to be *for* something, or it is a tick box.
       */
      approval: {
        state: { type: String, enum: PRICE_APPROVAL_STATES, default: 'not-needed' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        at: { type: Date, default: null },
        note: { type: String, default: '', maxlength: 1000 },
        forRate: { type: Number, default: null },
        forDiscount: { type: Number, default: null },
      },
    },

    /**
     * The paperwork after the sale: the purchase order, and whether it has been invoiced.
     *
     * On the proposal rather than on the engagement, because what gets invoiced is what was sold.
     * A PO number can be edited after acceptance — unlike every other field, which freezes when the
     * offer goes out — because the number nearly always arrives *after* the client says yes, and a
     * record that cannot accept it is a record somebody keeps in a spreadsheet instead.
     */
    billing: {
      poNumber: { type: String, default: '', trim: true, maxlength: 60 },
      invoicedAt: { type: Date, default: null },
      invoiceRef: { type: String, default: '', trim: true, maxlength: 60 },
      invoicedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      note: { type: String, default: '', maxlength: 1000 },
    },

    /** Which channel this arrived through. See PROPOSAL_SOURCES. */
    source: {
      kind: { type: String, default: '' },
      /** Who referred them, which event, which partner — the part that makes the channel useful. */
      detail: { type: String, default: '', trim: true, maxlength: 200 },
    },

    /**
     * How this one ended, in a shape that can be counted.
     *
     * `declineReason` above is the older free-text field and is kept in step, because the proposal
     * page prints it and a stored sentence is not worth migrating away from. This is what the
     * reporting reads: a reason from a fixed list, optionally who else was in the running, and the
     * sentence somebody wanted to add anyway.
     */
    outcome: {
      /** From LOSS_REASONS or WIN_REASONS depending on where it landed. */
      reason: { type: String, default: '' },
      /** Only meaningful for `competitor`, and only ever a name. */
      competitor: { type: String, default: '', maxlength: 120 },
      note: { type: String, default: '', maxlength: 2000 },
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
  },
  { timestamps: true }
);

// The two lists anybody opens: the pipeline, and one client's history with us.
proposalSchema.index({ status: 1, updatedAt: -1 });
proposalSchema.index({ company: 1, createdAt: -1 });

/** Days as agreed, falling back to what sales thought if nobody has looked yet. */
proposalSchema.methods.effortDays = function effortDays() {
  return this.estimate?.days ?? this.estimate?.salesDays ?? null;
};

/** True once the estimate has been through somebody who would do the work. */
proposalSchema.methods.effortAgreed = function effortAgreed() {
  return this.estimate?.days !== null && this.estimate?.days !== undefined;
};

/**
 * Whether the kickoff has been recorded.
 *
 * The date is the test rather than "any field filled in": notes typed before the call happened
 * are somebody's preparation, and a document that claims a kickoff took place on the strength of
 * them would be saying something untrue.
 */
proposalSchema.methods.kickoffHeld = function kickoffHeld() {
  return Boolean(this.kickoff?.heldOn);
};

export const Proposal = mongoose.model('Proposal', proposalSchema);
export default Proposal;
