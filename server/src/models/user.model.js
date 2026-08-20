import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * What an account is for. An account can hold more than one.
 *
 * `manager` is the reason this became a list. Somebody who signs off a client's paperwork is
 * usually a consultant as well — they test, and they also carry the authority to say a contract
 * may leave the building. With one role per account that person had to be either a consultant
 * who cannot sign or a manager who is not on any engagements, and neither is the truth.
 *
 * `sales` is the odd one out, and deliberately: the others are degrees of access to the same
 * work, while sales is a different job. It reaches the Sales section and nothing else — not a
 * narrower view of engagements but none of them — enforced at the API gate rather than by hiding
 * links. See `confineSales` in middleware/auth.js.
 */
export const ROLES = ['admin', 'manager', 'user', 'readonly', 'sales'];

export const ROLE_LABELS = {
  admin: 'Administrator',
  manager: 'Manager',
  user: 'Consultant',
  readonly: 'Read only',
  sales: 'Sales',
};

/**
 * Roles that can be given work on an engagement.
 *
 * Also the definition the API gate reads backwards: anything *not* in this list is confined to
 * its own section. Sales is not in it; a manager is, because a manager who cannot open an
 * engagement cannot sign anything off about it.
 */
export const WORKING_ROLES = ['admin', 'manager', 'user', 'readonly'];

/** Signing a client's paperwork off. Admins pass everything, as everywhere else. */
export const SIGNING_ROLES = ['admin', 'manager'];

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 40,
    },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true, select: false },
    firstname: { type: String, trim: true, default: '' },
    lastname: { type: String, trim: true, default: '' },
    /**
     * Every role this account holds, the first one primary.
     *
     * A list rather than a field, because the two facts are independent: whether somebody does
     * the testing and whether they may sign a contract. `role` below is a virtual over the first
     * entry, which keeps every existing read — and every `role: 'admin'` passed to `create` —
     * working, while there is only one place the truth actually lives.
     */
    roles: {
      type: [{ type: String, enum: ROLES }],
      /*
       * No schema default, and filled in by the hook below instead.
       *
       * A default of `['user']` is applied *before* the fields passed to `create`, so
       * `create({ role: 'admin' })` came out as `['admin', 'user']` — the setter merged the
       * primary into a list that already had the default in it, and an account somebody made as
       * an administrator quietly also became a consultant.
       */
      validate: {
        // An account with no roles could sign in and do nothing, which is a support ticket
        // rather than a state anybody meant to create.
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'An account needs at least one role',
      },
    },
    phone: { type: String, trim: true, default: '' },
    title: { type: String, trim: true, default: '' },
    enabled: { type: Boolean, default: true },

    /**
     * When an administrator let this account in, and who did.
     *
     * Separate from `enabled` on purpose, because the two answer different questions.
     * `enabled: false` is an account that used to work and was switched off — a
     * revocation, and something an admin already decided. `approvedAt: null` is an
     * account that has never worked at all, and is somebody *waiting* for a decision.
     * Collapsing them into one flag would put a queue an admin has to act on in the
     * same list as accounts they have already dealt with, and the honest reading of a
     * self-registered account is not "disabled" — nobody disabled it.
     *
     * Null on a self-registered account and set the moment somebody with the authority
     * says so. An account an admin created themselves is approved at birth: making the
     * same person press a second button to allow what they just typed is ceremony, not
     * a check.
     */
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Bumping this invalidates every refresh token previously issued to the user.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },

    /**
     * Engagements this person keeps at the top of the list.
     *
     * On the user, not on the engagement: a pin is one person's idea of what they are
     * working on this week, and putting it on the shared document would let a colleague's
     * housekeeping rearrange your list. Ids of engagements since deleted are ignored on
     * read rather than cascaded on delete — there is nothing to repair, and the alternative
     * is a hook on every trash and purge path.
     */
    pinnedAudits: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Audit' }],

    /**
     * Recent rejected sign-in attempts on this account, newest first, capped at ten.
     *
     * The rate limiter already stops brute force; this answers the different question
     * of whether somebody has been *trying*, which is only useful if the owner can
     * see it. Recorded only when the username matched a real account — a failure
     * against a name that does not exist has no owner to tell, and storing it would
     * be a list of guessed usernames.
     */
    failedLogins: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
        /** 'password' or 'code' — a wrong password or a wrong second factor. */
        reason: { type: String, default: 'password' },
      },
    ],

    /* --------------------------- skills and experience --------------------- */
    /**
     * What this person can do, so assigning work is not tribal knowledge.
     *
     * On the user rather than in a collection of its own: it is a handful of fields that
     * only ever belong to one person, read together and written together. Kept out of
     * `toPublic()` deliberately — every picker, mention list and presence panel in the app
     * calls that, and none of them needs somebody's certifications.
     */
    profile: {
      /** One line: "Lead tester — web, cloud, mobile". */
      headline: { type: String, default: '', maxlength: 160 },
      bio: { type: String, default: '', maxlength: 1500 },
      /** Years in the trade. A number, because "since 2014" ages badly in a database. */
      yearsExperience: { type: Number, default: null, min: 0, max: 60 },
      /** Spoken languages, which decides who can run a workshop with a client. */
      languages: [{ type: String, trim: true, maxlength: 40 }],

      skills: [
        {
          _id: false,
          name: { type: String, required: true, trim: true, maxlength: 60 },
          /**
           * Four steps, not five stars. A scale with a middle invites everybody to sit in
           * it; these say something a lead can act on.
           */
          level: {
            type: String,
            enum: ['learning', 'working', 'strong', 'expert'],
            default: 'working',
          },
        },
      ],

      certifications: [
        {
          _id: false,
          name: { type: String, required: true, trim: true, maxlength: 80 },
          issuer: { type: String, default: '', trim: true, maxlength: 80 },
          /**
           * `yyyy-mm-dd`, like every other date somebody typed in this app. An expiry is a
           * day, and stored as an instant it moves for readers in another timezone.
           */
          obtainedAt: { type: String, default: '' },
          expiresAt: { type: String, default: '' },
        },
      ],
    },

    /* ------------------------------ two-factor ----------------------------- */
    /** Base32 TOTP secret. Never leaves the server. */
    totpSecret: { type: String, default: null, select: false },
    /** Only true once a code from the app has actually been verified. */
    totpEnabled: { type: Boolean, default: false },
    /**
     * Set at registration and cleared once enrolment completes.
     *
     * This is what makes enrolment mandatory *for new accounts* without trapping
     * existing ones: starting an optional setup from your profile leaves a secret
     * behind, and without this flag abandoning that halfway would demand
     * enrolment on your next sign-in. Existing accounts default to false.
     */
    totpEnrolmentRequired: { type: Boolean, default: false },
    /**
     * Last accepted time step. A TOTP code stays valid for its whole 30-second
     * window, so without this an observed code could be replayed inside it.
     */
    totpLastStep: { type: Number, default: null, select: false },
    /** Consecutive bad codes, and the lockout they earn. */
    totpFailures: { type: Number, default: 0, select: false },
    totpLockedUntil: { type: Date, default: null, select: false },

    /* -------------------------------- presence ----------------------------- */
    lastSeenAt: { type: Date, default: null },
    /** Free text such as "editing Acme Portal", shown next to the avatar. */
    activity: { type: String, default: '', maxlength: 120 },
    /**
     * Which record they have open, as an opaque key like `finding:<audit>:<finding>`.
     *
     * Separate from `activity` because the two are read by different things: `activity` is prose
     * for a human reading the sidebar, this is compared for equality so a screen can say "somebody
     * else is in here too". Opaque on purpose — the server never needs to parse it, and a new kind
     * of record does not need a migration to become lockable.
     */
    location: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);

// Presence queries filter on recency, and the sidebar polls them.
userSchema.index({ lastSeenAt: -1 });

userSchema.virtual('fullname').get(function fullname() {
  return [this.firstname, this.lastname].filter(Boolean).join(' ') || this.username;
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  return next();
});

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.password);
};

/** Shape sent to clients — never includes the hash. */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    username: this.username,
    email: this.email,
    firstname: this.firstname,
    lastname: this.lastname,
    fullname: this.fullname,
    role: this.role,
    /** All of them, for a page that shows more than the primary. */
    roles: this.roles ?? [],
    phone: this.phone,
    title: this.title,
    enabled: this.enabled,
    /*
     * Published so that every list, picker and badge can tell a person who is waiting
     * from a person who was turned off, without a second request to find out.
     */
    approvedAt: this.approvedAt ?? null,
    awaitingApproval: !this.approvedAt,
    lastLoginAt: this.lastLoginAt,
    lastSeenAt: this.lastSeenAt,
    activity: this.activity,
    // Whether 2FA is on is safe to publish; the secret is `select: false`.
    totpEnabled: Boolean(this.totpEnabled),
    createdAt: this.createdAt,
  };
};

/**
 * The primary role, and a setter so `{ role: 'admin' }` still means what it always did.
 *
 * Declared as a virtual rather than kept as a second stored field: two columns holding the same
 * fact is how they end up disagreeing. Everything that only *reads* a role — the JWT payload,
 * the presence panel, every `user.role === 'readonly'` — carries on unchanged, and the queries
 * that used to match `role` now match `roles`, which Mongo does by array membership.
 */
userSchema.virtual('role').get(function primaryRole() {
  return this.roles?.[0] ?? 'user';
});
userSchema.virtual('role').set(function setPrimaryRole(value) {
  if (!value) return;
  // Keeps any extra roles: assigning the primary should not silently drop `manager`.
  const rest = (this.roles ?? []).filter((name) => name !== value);
  this.roles = [value, ...rest];
});

/**
 * A consultant unless told otherwise.
 *
 * Here rather than as a schema default, because a default is applied before the values handed to
 * `create` — see the note on the field. This runs after everything has been set, so it only ever
 * fills in an account nobody gave a role to.
 */
userSchema.pre('validate', function defaultRole(next) {
  if (!this.roles?.length) this.roles = ['user'];
  return next();
});

/** Whether this account holds a role at all. Admins are treated as holding every one. */
userSchema.methods.hasRole = function hasRole(...names) {
  const held = this.roles ?? [];
  if (held.includes('admin')) return true;
  return names.some((name) => held.includes(name));
};

/**
 * Why this account cannot be signed in to, or null if it can.
 *
 * One definition because the question is asked in five places — the login route, the
 * second factor, the refresh, the request middleware and the media middleware — and a
 * rule spelled out five times is a rule that will eventually disagree with itself.
 */
userSchema.methods.signInBlock = function signInBlock() {
  if (this.enabled === false) return 'disabled';
  if (!this.approvedAt) return 'unapproved';
  return null;
};

/** What to say about it. Kept beside the rule so the two cannot drift apart. */
export const SIGN_IN_BLOCK_MESSAGES = {
  disabled: 'This account has been disabled',
  unapproved: 'This account is waiting for an administrator to approve it',
};

/** True while the account is serving a lockout after repeated bad codes. */
userSchema.methods.isTotpLocked = function isTotpLocked() {
  return Boolean(this.totpLockedUntil && this.totpLockedUntil.getTime() > Date.now());
};

export const User = mongoose.model('User', userSchema);
export default User;
