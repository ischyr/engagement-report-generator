import mongoose from 'mongoose';

/**
 * A link that lets a client see their own findings without an account.
 *
 * The app has always ended at the moment the report is sent. What happens next — the client fixing
 * things, and telling somebody they have — happens in email, and comes back as a spreadsheet
 * attached to a message three months later, if it comes back at all. This is the other end of that:
 * a URL the client can open, showing what is still outstanding and letting them say what they have
 * done, so the retest has a starting list that somebody did not have to assemble by hand.
 *
 * It is the only thing in this app that shows client data to somebody with no account, so the
 * rules it is built on are worth stating plainly:
 *
 *   - **The token is a bearer credential.** 32 random bytes, stored only as a SHA-256 hash — the
 *     same treatment an invitation link gets. A copy of this collection tells you that links exist
 *     and nothing about how to use one.
 *   - **It expires, and it can be revoked.** Both are checked on every request; neither is a TTL
 *     index, because the row is also the record that the link was made, and that outlives the link.
 *   - **It is scoped to one engagement**, and to a deliberately small part of one. What it may show
 *     is decided in `share.service.js`, not here, and the list of what it must never show is
 *     written out beside it.
 *   - **Every use is on the engagement's activity log.** A client marking something fixed is a
 *     change to the record, and a change nobody can attribute is worse than no change.
 */
const shareLinkSchema = new mongoose.Schema(
  {
    /**
     * The engagement this is about — for every kind but `client`.
     *
     * No longer `required`, which is the one thing in this model worth being nervous about: a
     * scope that is empty is a scope that is everything, and the check that stops that is a
     * validator rather than a schema flag now. See below.
     */
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null, index: true },

    /**
     * Or the client, for the one kind that spans their engagements rather than naming one.
     *
     * Exactly one of these two is set, and which is decided by `kind`. A row with both, or with
     * neither, is refused below rather than being allowed to mean something nobody intended.
     */
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    /** SHA-256 of the token that went out. Never the token itself. */
    tokenHash: { type: String, required: true, unique: true, index: true },

    /** Who it was made for, in the sender's words — "Dana at Northwind". Shown to the team only. */
    label: { type: String, default: '', trim: true, maxlength: 160 },

    /**
     * Which of the two things this link is for.
     *
     * `findings` is the original and the one the rules above were written for: it is made *after*
     * the report goes, and it shows the client what was found and lets them say what they have
     * fixed.
     *
     * `status` is deliberately the opposite end of the job. The question a client asks on day
     * three is "how is it going", and the answer went by email because nothing here could be shown
     * to them mid-test. It carries no finding text at all — counts, coverage, and the assets they
     * need to do something about — so the rule that a link never shows an undelivered finding
     * stands exactly as written. Two kinds rather than a flag, because what may be seen is decided
     * per kind in `share.service.js` and a boolean would invite a third meaning later.
     */
    kind: { type: String, enum: ['findings', 'status', 'client'], default: 'findings', index: true },

    /**
     * Whether the client may change anything, or only read.
     *
     * Off is a real use: a link sent to somebody's auditor, or to a stakeholder who should see the
     * position and has no business changing it.
     */
    allowUpdates: { type: Boolean, default: true },

    /**
     * Whether the client may attach a screenshot to a claim.
     *
     * Off by default, unlike `allowUpdates`, and the asymmetry is deliberate. A status flag is a
     * value from a set of two that this server chose; a file is bytes from a stranger, arriving
     * over a credential that may have been forwarded to somebody nobody intended. Everything about
     * the upload is defended anyway — images only, sniffed by content, small, few, rate limited,
     * refused on a restricted engagement — and it still needs somebody to decide it is wanted for
     * this client before it is possible.
     */
    allowEvidence: { type: Boolean, default: false },

    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * How often it has been opened, and when last.
     *
     * Deliberately not who or from where. The address a client reads their report from is their
     * information, not ours, and a log of it would be a thing we would then have to protect.
     */
    views: { type: Number, default: 0 },

    /**
     * Whether to chase, and how often.
     *
     * Off unless somebody asks for it, per link, at the moment it is made — which is the same
     * shape as every other permission here and for a stronger reason: this is the only thing in
     * the application that sends unprompted mail to somebody outside the firm. A default of "on"
     * would make an instance start mailing clients because it was upgraded.
     *
     * It stops on its own, and every one of these is a stop rather than a pause:
     *
     *   - nothing is outstanding — everything has been claimed fixed
     *   - the link has expired or been withdrawn
     *   - the report has been signed off, so there is nothing the client could do anyway
     *   - `REMINDER_LIMIT` have been sent
     *
     * The last one is the one that needs a number rather than a principle. A fortnightly chase on
     * a six-month link is thirteen emails, which is not a reminder, it is a campaign — and the
     * client who ignores the fifth was never going to answer the ninth. After the cap the team
     * has to do what the app cannot: pick up the telephone.
     */
    reminder: {
      /** Days between chases. Zero is off, and is the default. */
      everyDays: { type: Number, default: 0, min: 0, max: 90 },
      /** When the last one went, which is what makes the sweep idempotent. */
      lastAt: { type: Date, default: null },
      /** How many have gone, against the cap. */
      sent: { type: Number, default: 0 },
    },

    /**
     * Who this link was sent to, and when.
     *
     * Recorded because "did they get it" was previously answerable only by asking the person who
     * pasted it into their own mail — and because a reminder has to know where to go. `client`
     * is set when the address came from the contact list and left null when somebody typed one,
     * so the record is honest about which it was rather than inventing a relationship.
     *
     * The token is *not* here and cannot be. Only its hash is kept, and it is returned exactly
     * once at creation — so a link can be sent at the moment it is made and never afterwards.
     * Resending means issuing a new one, which is the same answer this model has always given to
     * somebody who lost their link, and a better one than a token this app could hand out twice.
     */
    sentTo: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, default: '', trim: true, maxlength: 160 },
            email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
            client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
            at: { type: Date, default: Date.now },
            by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    lastViewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * Exactly one scope, and the right one for the kind.
 *
 * A validator rather than `required` on each field, because the rule is about the pair: a
 * `client` link names a company and no engagement, everything else names an engagement and no
 * company. Both set would be a link whose reach depends on which code path reads it first, and
 * neither set would be a token scoped to nothing — which, for something that decides what an
 * outsider may see, is the same as scoped to everything.
 */
shareLinkSchema.pre('validate', function assertOneScope(next) {
  const wantsCompany = this.kind === 'client';
  if (wantsCompany && (!this.company || this.audit)) {
    return next(new Error('A client link belongs to a company and to no single engagement'));
  }
  if (!wantsCompany && (!this.audit || this.company)) {
    return next(new Error('This link belongs to one engagement'));
  }
  return next();
});

export const ShareLink = mongoose.model('ShareLink', shareLinkSchema);
export default ShareLink;
