import mongoose from 'mongoose';

import { reportFingerprint } from '../utils/report-fingerprint.js';
import { countImages } from '../utils/evidence.js';

export const AUDIT_STATES = ['EDIT', 'REVIEW', 'APPROVED'];

/**
 * What a recipient is to the report.
 *
 * `technical` is the default because it is the common case and the safe one to assume: it
 * describes somebody who was always going to receive the whole document.
 */
export const RECIPIENT_ROLES = ['technical', 'management', 'signatory', 'cc'];

export const RECIPIENT_ROLE_LABELS = {
  technical: 'Technical contact',
  management: 'Management',
  signatory: 'Signs off',
  cc: 'Copied in',
};

/**
 * What shape of work an engagement is.
 *
 * `standard` is everything the app was built for: a scope of assets, findings against them, a
 * report. `phishing` is a campaign — a mailing list and what happened to each person — which needs
 * different tabs rather than the same ones used differently.
 */
export const ENGAGEMENT_KINDS = ['standard', 'phishing'];

/** Where a finding stands in the remediation cycle, for retest reports. */
export const REMEDIATION_STATUSES = ['open', 'retesting', 'fixed'];

/**
 * A comment on a finding. Internal to the team — comments are never part of the
 * generated report, so reviewers can be blunt.
 */
const commentSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 4000 },
    /** Which part of the finding it is about, e.g. 'remediation'. Empty = general. */
    field: { type: String, default: '' },
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * A working note kept alongside an engagement — command output, credentials to
 * try, half-formed leads. Deliberately *not* exposed to report templates: notes
 * are the tester's scratchpad, and leaking them into a client deliverable would
 * be the obvious accident to avoid.
 */
/**
 * One tester's end-of-session handover.
 *
 * A job with two people across a week runs on somebody remembering to say what they did, and the
 * place that lands today is either a chat message that scrolls away or the notes tab, which is
 * freeform and becomes a wall nobody reads to the bottom of. This is the structured version: four
 * short fields, attributed, timestamped, newest first, and never part of a report.
 *
 * Separate from `notes` because they answer different questions. A note is about the target — what
 * this endpoint does, which payload worked. A handover is about the *work* — where I stopped and
 * what the next person should pick up. Mixing them means the second one is never found in a hurry,
 * which is the only time it is read.
 */
const handoverSchema = new mongoose.Schema(
  {
    /** What was done this session. The only required field: an entry with nothing in it is noise. */
    did: { type: String, default: '', maxlength: 4000 },
    /** What the next person should start on. */
    next: { type: String, default: '', maxlength: 4000 },
    /** What is in the way — a credential that expired, an environment that is down. */
    blockers: { type: String, default: '', maxlength: 4000 },
    /**
     * Which accounts were used, by name.
     *
     * Names, never secrets: the credentials tab is where a password belongs, and a handover is read
     * by more people and copied into more chat windows than anything else on an engagement.
     */
    credentials: { type: String, default: '', maxlength: 1000 },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const noteSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'Untitled note', maxlength: 200 },
    /** Editor HTML, same as findings, so screenshots and code blocks work. */
    content: { type: String, default: '' },
    icon: { type: String, default: '' },
    pinned: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * The finding this note was written up as, if it was.
     *
     * The note is kept rather than consumed: it is the raw log of what was tried, and "capture
     * first, write up later" only works if capturing is safe. The link is what stops the same
     * lead being written up twice by two people reading the same scratchpad.
     */
    promotedTo: { type: mongoose.Schema.Types.ObjectId, default: null },
    promotedAt: { type: Date, default: null },
    promotedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/**
 * A test that someone on the team said should be carried out, and a record of
 * whether it was.
 *
 * Unlike notes and comments, these *are* available to report templates: "here is
 * what we tested" is a section clients ask for, and it is the honest counterpart
 * to the findings list — it shows the ground covered, not just what was found.
 */
const testCheckSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    /** What "verified" means for this one, if the title is not self-evident. */
    description: { type: String, default: '', maxlength: 2000 },
    /** Free-text grouping, e.g. "Authentication". Empty falls under Ungrouped. */
    category: { type: String, default: '', trim: true, maxlength: 120 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Who is going to do this one.
     *
     * `createdBy` says who wrote the check and `doneBy` says who ticked it; neither answers
     * "whose is it" — so splitting a 120-item list between two testers happened in chat, and
     * items got done twice or not at all.
     *
     * Kept after it is ticked rather than cleared: "assigned to Ana, done by Bram" is itself
     * worth seeing, because it is usually how you find out somebody was overloaded.
     */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    done: { type: Boolean, default: false },

    /**
     * Not done, and not going to be — for now.
     *
     * Deliberately a separate field rather than a third value of `done`. A check either was
     * carried out or it was not, and that is what the report prints and the counts count;
     * "blocked" is a different question laid over the same answer. Folding them into one enum
     * would have meant every existing reader of `done` learning about a state it has no opinion
     * on, and a template printing `Verified` for something nobody could reach.
     *
     * Only meaningful while `done` is false, and ticking a check clears it: you did it, so it
     * was not blocked.
     */
    blocked: { type: Boolean, default: false },
    /** Why it cannot be done. Required by the route — "blocked" with no reason is a shrug. */
    blockedReason: { type: String, default: '', trim: true, maxlength: 300 },
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    blockedAt: { type: Date, default: null },
    /** Who ticked it, so a checklist is accountable rather than anonymous. */
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    doneAt: { type: Date, default: null },
    /** Optional note left when ticking, e.g. "no injectable parameters found". */
    result: { type: String, default: '', maxlength: 2000 },

    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** A single finding as it exists inside one engagement. */
const findingSchema = new mongoose.Schema(
  {
    identifier: { type: Number },
    title: { type: String, required: true },
    vulnType: { type: String, default: '' },
    description: { type: String, default: '' },
    observation: { type: String, default: '' },
    remediation: { type: String, default: '' },
    remediationComplexity: { type: Number, min: 1, max: 3, default: null },
    priority: { type: Number, min: 1, max: 4, default: null },
    references: [{ type: String }],
    cvssv3: { type: String, default: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N' },
    /** Affected hosts/URLs/endpoints, free text so it can hold anything. */
    scope: { type: String, default: '' },
    poc: { type: String, default: '' },
    status: { type: Number, default: 0 },
    remediationStatus: { type: String, enum: REMEDIATION_STATUSES, default: 'open' },

    /**
     * Who has taken this finding for editing, if anybody.
     *
     * A deliberate hard lock, distinct from the presence banner that says who else has it open.
     * That one is advisory and easy to ignore; this one is enforced on the server, so a colleague
     * who has taken a finding cannot have their write-up overwritten by somebody who did not read
     * the warning — the report is one document and an hour of somebody's writing is not recoverable
     * from a conflict dialog they clicked through.
     *
     * On the finding rather than in a collection of locks, because a lock has no life of its own:
     * it is a property of the thing locked, it dies with it, and asking "is this locked" must not
     * be a second query on the path of every save.
     */
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lockedAt: { type: Date, default: null },
    /** Optional: what they are doing, so "locked" is not a mystery to everybody else. */
    lockNote: { type: String, default: '', maxlength: 200 },

    /**
     * Every time the remediation status moved, and who moved it.
     *
     * The status was a single value, so a finding could say it was fixed and nothing could say
     * when, by whom, or that it had been marked fixed once before and come back. That is exactly
     * the history a retest argument turns on, and it was being reconstructed from memory.
     *
     * Appended, never rewritten: a corrected status is another entry rather than an edit, because
     * "we thought it was fixed on the 3rd and found it open again on the 14th" is two facts.
     */
    statusHistory: [
      {
        _id: false,
        status: { type: String, enum: REMEDIATION_STATUSES },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      },
    ],

    /**
     * A severity the team is standing behind, when it differs from the vector's.
     *
     * Not a replacement for scoring: the vector is still recorded, still printed, and still what
     * the override is measured against. This is the sentence a reviewer would otherwise write
     * into the description by hand — "rated Medium rather than High because the interface is
     * reachable only from the management VLAN" — recorded where the counts can see it.
     *
     * Empty means "whatever the vector says", which is the right default and the common case.
     */
    severityOverride: {
      type: String,
      enum: ['', 'Critical', 'High', 'Medium', 'Low', 'None'],
      default: '',
    },
    /** Why. Required by the route when the override actually changes anything. */
    severityOverrideReason: { type: String, default: '', maxlength: 500 },
    severityOverrideBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    severityOverrideAt: { type: Date, default: null },
    category: { type: String, default: '' },
    /** Set when the finding came out of the shared library. */
    vulnerability: { type: mongoose.Schema.Types.ObjectId, ref: 'Vulnerability', default: null },

    /**
     * Who wrote this one up, and who touched it last.
     *
     * The activity log has the same information, but on a shared engagement the
     * question "whose finding is this?" comes up while reading the list, not while
     * auditing history — so it is answered where it is asked.
     */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customFields: [
      {
        _id: false,
        key: String,
        label: String,
        fieldType: String,
        value: mongoose.Schema.Types.Mixed,
      },
    ],
    sortIndex: { type: Number, default: 0 },

    /**
     * How many images this finding carries, kept in step by the parent's save hook.
     *
     * Denormalised on purpose. "Which findings have no evidence" is asked by the engagement
     * list and the cross-engagement Findings page, and answering it from the rich text means
     * reading every description, observation and proof of concept — megabytes of HTML, with
     * base64 screenshots in it — to produce a number. Stored, both pages project one integer.
     */
    evidenceCount: { type: Number, default: 0 },
    comments: [commentSchema],
  },
  { timestamps: true }
);

/** A narrative block (executive summary, methodology, …). */
const sectionSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    name: { type: String, required: true },
    text: { type: String, default: '' },
    customFields: [
      {
        _id: false,
        key: String,
        label: String,
        fieldType: String,
        value: mongoose.Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true }
);

const scopeSchema = new mongoose.Schema(
  {
    _id: false,
    name: { type: String, default: '' },
    hosts: [
      {
        _id: false,
        hostname: String,
        ip: String,
        os: String,
        services: [{ _id: false, port: Number, protocol: String, name: String, product: String }],

        /**
         * Whether this asset was actually reached.
         *
         * Scope recorded what was *in* scope and nothing about what happened to it, so "we tested
         * 40 of 47, seven were unreachable" was a sentence somebody typed by hand and no report
         * could check. Three states, because two would force "unreachable" and "not got to yet"
         * to mean the same thing, and at closeout they are the difference between an explanation
         * and an admission.
         */
        status: {
          type: String,
          enum: ['pending', 'tested', 'excluded'],
          default: 'pending',
        },
        /** Why it was excluded, or anything worth saying about the test. */
        statusNote: { type: String, default: '', maxlength: 300 },

        /**
         * The operator's own working notes about this asset.
         *
         * Distinct from `statusNote`, which is a sentence for the *client* explaining why an
         * asset was excluded or what happened to it. This is the other thing entirely: what you
         * tried, which credentials worked, what to come back to. It never reaches a report.
         *
         * On the host rather than in a collection keyed by an id, because hosts have no id —
         * `_id: false` — and giving them one would mean a migration and a scope editor that
         * preserves it. Living on the row means it moves with the row and cannot be orphaned.
         */
        notes: { type: String, default: '', maxlength: 8000 },
      },
    ],
  },
  { _id: false }
);

/**
 * One reviewer's sign-off.
 *
 * Was a bare user id, which could answer "who approved" and nothing else — not
 * when, and not what they were looking at. A signature that cannot be tied to a
 * version of the report is decoration.
 */
const approvalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Null on approvals recorded before this was kept. */
    at: { type: Date, default: null },
    /** The report content this covers. Empty on migrated rows: unknown, not stale. */
    fingerprint: { type: String, default: '' },
  },
  { _id: false }
);

const auditSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    auditType: { type: String, default: '' },
    language: { type: String, default: 'en' },
    /** Short client-visible reference, e.g. PT-2026-014. */
    reference: { type: String, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },

    /**
     * The primary contact — the "prepared for" line on the cover page.
     *
     * Kept as its own field rather than folded into `recipients` because every
     * template already reads `{{ .client.fullname }}`, and a report addressed to
     * nobody in particular reads worse than one addressed to a person.
     */
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },

    /**
     * Everyone the report goes to, primary first.
     *
     * A report rarely has one reader — usually the technical contact who
     * commissioned it plus whoever signs off. The primary is always the first entry,
     * so `client` and `recipients[0]` can never disagree.
     */
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],

    /**
     * What each recipient is to this report.
     *
     * The person who signs the engagement off, the one who wants the technical detail and the
     * one who is merely copied in are three different people, and a flat distribution list
     * cannot say which is which — so the cover page names whoever happens to be first and a
     * template has no way to address the signatory.
     *
     * Kept beside `recipients` rather than replacing it: every existing read treats that field
     * as a list of ids, and `normaliseRecipients()` already exists to keep two views of the
     * same fact consistent. It prunes anything here that is no longer a recipient, so this
     * cannot drift into describing somebody who left the list.
     */
    recipientRoles: [
      {
        _id: false,
        client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
        role: { type: String, enum: RECIPIENT_ROLES, default: 'technical' },
      },
    ],
    collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    reviewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    /**
     * The proposal this job was sold as, when there was one.
     *
     * Null on an engagement somebody raised directly, which stays the normal way to start
     * work — plenty of jobs arrive from an existing client without a fresh proposal, and
     * requiring one would put a sales step in front of a retest.
     */
    proposal: { type: mongoose.Schema.Types.ObjectId, ref: 'Proposal', default: null },

    /**
     * Days sold: the effort the client agreed to pay for.
     *
     * Separate from anything the app measures. Time logged says what the job *took*, the
     * booking says what was *planned*, and this says what was *sold* — three different
     * numbers, and the interesting questions are all differences between them. Carried over
     * from the proposal's agreed estimate when an engagement is created from one, and
     * editable after, because a scope change changes what was sold.
     */
    daysSold: { type: Number, default: null, min: 0, max: 400 },

    /**
     * When somebody's access to this engagement ends.
     *
     * For subcontractors, mainly. Membership was permanent, so a freelancer brought in for one
     * job stayed on it — and in every picker — for ever, and the only alternative was removing
     * them, which loses the fact that they did the work. An entry here ends the *access* on a
     * day while their name, their findings and their ticked checks all stay exactly where they
     * are.
     *
     * Only people with a limit appear; anybody absent is a permanent member. The creator is
     * never here: an engagement whose owner cannot open it is not a state worth allowing.
     *
     * Days, not timestamps, like every other day in this app — access ending "on the 14th"
     * must mean the 14th wherever it is read from.
     */
    memberUntil: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        until: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      },
    ],
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    date: { type: String, default: '' },
    date_start: { type: String, default: '' },
    date_end: { type: String, default: '' },

    /**
     * Work that comes round again: an annual retest, a quarterly scan.
     *
     * The same engagement in the same shape every year, created by hand, and remembered by one
     * person — who eventually leaves, or is on holiday in the week it was due.
     *
     * It nudges rather than creates. An engagement appearing in the list on its own, part-filled,
     * with a team booked onto it, is a surprise nobody asked for; a notification saying "this is
     * due on the 12th" with one button that builds it from last time is the same saved effort
     * without the app making commitments on somebody's behalf.
     */
    repeat: {
      /** Months between one and the next. Null or 0 means this does not repeat. */
      months: { type: Number, default: null, min: 1, max: 60 },
      /** `yyyy-mm-dd`, like every day in this app. When the next one is due to start. */
      nextDue: { type: String, default: '', match: /^(\d{4}-\d{2}-\d{2})?$/ },
      /** Set when the reminder for the current `nextDue` has gone out, so it goes out once. */
      remindedFor: { type: String, default: '' },
      /** The engagement created from this one, so the chain can be followed. */
      createdNext: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
    },
    scope: [scopeSchema],
    findings: [findingSchema],
    sections: [sectionSchema],
    notes: [noteSchema],
    handovers: [handoverSchema],
    testChecks: [testCheckSchema],
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    state: { type: String, enum: AUDIT_STATES, default: 'EDIT' },

    /**
     * How carefully this one has to be handled.
     *
     * Two levels, not four. A scale with a middle invites everybody to sit in it, and the point
     * here is not a label — it is that `restricted` carries consequences the app *enforces*
     * rather than asks people to remember: two-factor to open it, credentials that must expire,
     * write-ups that cannot be promoted into the shared library, a copy that inherits the
     * marking, and a shorter window before the trash empties.
     *
     * Raising it is an ordinary edit; lowering it is admin-only. The asymmetry is deliberate —
     * marking something sensitive should be frictionless, and un-marking it is the direction
     * that loses protection.
     */
    /**
     * What shape of work this is.
     *
     * Distinct from `auditType`, which is a free taxonomy entry the firm maintains for the report
     * — "External Network Penetration Test". This is structural: it decides which parts of the app
     * an engagement even has. A phishing campaign has a mailing list and results rather than a
     * scope of hosts and findings per host, and showing every engagement a tab it will never use
     * is how a thirteen-tab bar becomes fifteen.
     *
     * An enum rather than a boolean because the next two — physical, wireless — are the same kind
     * of question, and the app already names all three in its vulnerability types.
     */
    kind: { type: String, enum: ENGAGEMENT_KINDS, default: 'standard', index: true },

    /**
     * Finished, and put away.
     *
     * A third thing again, alongside `state` and `deletedAt`. The state says where the report got
     * to; the trash says somebody deleted it and it can come back for a fortnight. Archiving says
     * neither — the work is over and it should stop appearing in the list of things being worked
     * on, while remaining entirely readable for ever.
     *
     * Visibility, not permission: an archived engagement is not locked, and it still counts in
     * every historical view — the delivery register, the client's page, the insights. It only
     * leaves the places that are about *current* work.
     */
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Free labels — "red team", "PCI", "Q3", "subcontracted".
     *
     * Every filter in the app is by client, state or engagement type, so the cross-cutting
     * questions a firm actually asks had no answer: everything PCI this year, everything a
     * partner ran, everything that was a retest. Free text rather than a managed vocabulary
     * because a tag list somebody has to curate is a tag list nobody uses; they are normalised
     * to lower case on the way in so "PCI" and "pci" are one tag.
     */
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],

    classification: {
      type: String,
      enum: ['standard', 'restricted'],
      default: 'standard',
      index: true,
    },
    /** Why it is restricted, for whoever finds it locked and wonders. */
    classificationNote: { type: String, default: '', trim: true, maxlength: 300 },
    classifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    classifiedAt: { type: Date, default: null },

    /**
     * Testing stopped, and why.
     *
     * Deliberately *not* a fourth `state`. The state says where the report is in its life — being
     * written, being reviewed, signed off — and being told to stand down is a different axis
     * entirely: an engagement in review can be paused, and so can one nobody has started. Folding
     * the two together would mean resuming had to guess which stage to go back to.
     *
     * A list rather than a flag, because "who stopped it and why" is asked weeks later, and
     * because an engagement stopped twice is two separate facts. The open hold is the last entry
     * with no `endedAt`; `onHold` below is that same fact denormalised so a list can filter on it.
     */
    holds: [
      {
        _id: false,
        reason: { type: String, required: true, trim: true, maxlength: 500 },
        startedAt: { type: Date, default: Date.now },
        startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        endedAt: { type: Date, default: null },
        endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        /** What changed, recorded when work starts again. */
        resumeNote: { type: String, default: '', trim: true, maxlength: 500 },
      },
    ],
    /**
     * Whether it is stopped right now.
     *
     * Derived from `holds` and kept in step by the save hook, the same arrangement the content
     * fingerprint and the evidence count already use — so no route can set one without the other
     * and the engagement list can filter on an indexed field rather than walking an array.
     */
    onHold: { type: Boolean, default: false, index: true },
    /** Whether findings are ordered by CVSS automatically or by hand. */
    sortFindings: { type: Boolean, default: true },
    customFields: [
      {
        _id: false,
        key: String,
        label: String,
        fieldType: String,
        value: mongoose.Schema.Types.Mixed,
      },
    ],
    approvals: [approvalSchema],

    /**
     * Hash of the report-visible content, maintained on every save.
     *
     * Kept on the document so "is this signature still valid" is one string
     * comparison anywhere — a list, the inbox, a badge — instead of loading whole
     * engagements to recompute it.
     */
    contentFingerprint: { type: String, default: '' },

    /**
     * Soft delete. An engagement is weeks of work, so "delete" moves it to a
     * trash it can be restored from, and it is purged for real only after the
     * retention window in Settings has passed.
     */
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * When the engagement's own fields (name, dates, team, scope…) last changed.
     *
     * Separate from `updatedAt`, which moves whenever anything nested changes — a
     * colleague ticking a check would otherwise make the details form report a
     * conflict that has nothing to do with the fields being edited.
     */
    detailsUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * Every write goes through a full document and `save()`, so one hook keeps the
 * fingerprint honest for all of them rather than each route remembering to.
 *
 * Recomputed unconditionally: the projection excludes comments, notes and checks, so
 * a save that only touched those produces the same hash and invalidates nothing.
 * Skipped when the document was loaded with a projection that omits the content —
 * hashing what such a document *does* hold would fake a change.
 */
auditSchema.pre('save', function stampFingerprint(next) {
  const paths = ['name', 'findings', 'sections', 'scope', 'customFields'];
  if (paths.every((path) => this.isSelected(path))) {
    this.contentFingerprint = reportFingerprint(this);
  }

  /*
   * The evidence count, from the same hook and for the same reason: every write goes through
   * a full document and `save()`, so doing it here means no route can forget to.
   */
  if (this.isSelected('findings')) {
    for (const finding of this.findings ?? []) {
      const counted = countImages(finding);
      if (finding.evidenceCount !== counted) finding.evidenceCount = counted;
    }
  }

  /*
   * And whether work is stopped, from the same hook and for the same reason. An `onHold` that
   * disagreed with the holds it is supposed to summarise would be the worst kind of wrong: a
   * list saying an engagement is running while the engagement itself says it was stood down.
   */
  if (this.isSelected('holds')) {
    this.onHold = (this.holds ?? []).some((hold) => !hold.endedAt);
  }

  next();
});

// Every list query filters on this.
auditSchema.index({ deletedAt: 1, updatedAt: -1 });

auditSchema.index({ name: 'text', reference: 'text' });

export const Audit = mongoose.model('Audit', auditSchema);
export default Audit;
