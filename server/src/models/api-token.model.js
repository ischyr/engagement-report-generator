import crypto from 'node:crypto';

import mongoose from 'mongoose';

/**
 * A long-lived credential a script can hold, for the versioned API under `/api/v1`.
 *
 * Everything else in this application authenticates as a *person at a keyboard*: a short access
 * token in memory, a refresh cookie scoped to `/api/auth`, a media cookie scoped to `/api/media`,
 * a collaboration cookie scoped to `/api/collab`. That arrangement is deliberate and it is the
 * reason none of it suits automation — a thirty-minute token behind a refresh cookie is exactly
 * what a cron job cannot hold, and handing a CI runner somebody's password so it can log in is
 * the outcome this row exists to prevent.
 *
 * So a token is a different kind of credential, and the difference is enforced rather than
 * described. It reaches `/api/v1` and nothing else; the app's own routes refuse it, and this
 * refuses the app's own session. `middleware/api-auth.js` has the argument for that.
 *
 * Three things bound what a token can do, and a request must satisfy all three:
 *
 *   - **scopes** — the verbs, from `SCOPES` below.
 *   - **audits** — which engagements, by id. Empty means "whatever its owner can reach", which is
 *     a real need for an instance-wide integration and a thing the UI warns about.
 *   - **its owner's own access, live at the time of the request** — a token cannot outgrow the
 *     person who made it. Take them off an engagement and their tokens leave with them.
 *
 * The admin short-circuit in `loadAudit` is deliberately *not* applied to tokens. An admin can
 * open every engagement in the instance, and a bearer string sitting in a pipeline configuration
 * should not inherit that: an admin's token has to name the engagements it is for. See
 * `assertTokenMayOpen`.
 *
 * Only a hash of the secret is stored, exactly as `account-token.model.js` does for password
 * links. SHA-256 rather than bcrypt, and that is not a lapse: bcrypt's cost exists to slow down
 * guessing at low-entropy strings a human chose, whereas this is 30 bytes from `randomBytes`.
 * There is nothing to guess, and a per-request bcrypt comparison on a machine-driven endpoint
 * would be a denial-of-service surface rather than a defence.
 */

/**
 * What a token can be allowed to do.
 *
 * Coarse and few. A scope list that mirrors the route table one-for-one reads as thorough and is
 * unusable: nobody can tell which fourteen boxes to tick, so they tick all fourteen. These are
 * the four sentences somebody automating this actually needs, and they are readable in a list.
 *
 * Read and write are separate for the same reason they are separate everywhere else — the common
 * case for a script is reading, and a read-only credential that leaks is an embarrassment rather
 * than an incident.
 */
export const SCOPES = {
  'engagements:read': {
    label: 'Read engagements',
    description: 'List engagements and read their details, dates, scope and team.',
  },
  'findings:read': {
    label: 'Read findings',
    description: 'Read findings, their severities and their write-ups.',
  },
  'findings:write': {
    label: 'Create and update findings',
    description: 'Add findings and change existing ones. Cannot delete.',
  },
  'enumeration:read': {
    label: 'Read enumeration',
    description: 'Read the enumeration tree and the output of each step.',
  },
  'enumeration:write': {
    label: 'Add enumeration steps',
    description: 'Record a tool run, its command and its output.',
  },
};

export const SCOPE_NAMES = Object.keys(SCOPES);

/** The write scopes, so a read-only account can be refused them in one check. */
export const WRITE_SCOPES = SCOPE_NAMES.filter((scope) => scope.endsWith(':write'));

/**
 * How long a token may live.
 *
 * A credential with no expiry is a credential nobody ever removes, and the honest answer to "how
 * long do you need this for" is almost never "forever". A year is the ceiling rather than the
 * default, because a year is what an annual retainer's pipeline genuinely needs.
 */
export const MAX_TOKEN_DAYS = 365;
export const DEFAULT_TOKEN_DAYS = 90;

/**
 * The visible marker on every token this instance issues.
 *
 * A fixed, searchable prefix so the string is recognisable as a secret by the tools that look for
 * secrets — a pre-commit hook, a repository scanner, a person reading a diff. A credential that
 * looks like random base64 is one that gets committed.
 */
export const TOKEN_PREFIX = 'engy_';

/** SHA-256 of a presented token, hex. The only form of it this application stores. */
export const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');

const apiTokenSchema = new mongoose.Schema(
  {
    /** What it is for, in words. Shown in the list and in the activity log when it writes. */
    label: { type: String, required: true, trim: true, maxlength: 120 },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the secret that went out. Never the secret. */
    tokenHash: { type: String, required: true, unique: true },

    /**
     * The first few characters, kept so the list can name a token without holding it.
     *
     * Somebody with four tokens and a failing pipeline needs to tell which row is the string in
     * that pipeline's configuration, and the label alone does not always answer it.
     */
    preview: { type: String, required: true },

    scopes: {
      type: [{ type: String, enum: SCOPE_NAMES }],
      default: [],
      validate: {
        validator: (scopes) => Array.isArray(scopes) && scopes.length > 0,
        message: 'A token needs at least one scope.',
      },
    },

    /**
     * The engagements it may reach. Empty means every engagement its owner can reach.
     *
     * Not a `required` field, because instance-wide is a legitimate configuration — a nightly job
     * that files findings from a scanner does not know next month's engagement ids. It is,
     * however, the wider of the two choices, so the interface asks for engagements first and says
     * plainly what leaving it empty means.
     */
    audits: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Audit' }],

    /**
     * When it stops working.
     *
     * Deliberately *not* a TTL index, which is the difference between this and an invitation link.
     * An expired token should stay in the list: the question its owner asks is "why did my script
     * stop working on Tuesday", and a row that has silently removed itself cannot answer that.
     */
    expiresAt: { type: Date, required: true },

    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /** Where it was made, for the same reason an issued reset link records it. */
    issuedIp: { type: String, default: '' },

    /**
     * Whether it has ever been used, and when last.
     *
     * The only reliable way to answer "can I delete this one" is to know whether anything still
     * holds it. Written at most once a minute per token — see `touchApiToken` — because a
     * pipeline making forty calls should not make forty writes to say so.
     */
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: '' },
    useCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Live means: not revoked, not expired. Says nothing about scopes or its owner. */
apiTokenSchema.methods.isLive = function isLive(now = new Date()) {
  return !this.revokedAt && this.expiresAt > now;
};

apiTokenSchema.index({ owner: 1, createdAt: -1 });

export const ApiToken = mongoose.model('ApiToken', apiTokenSchema);
export default ApiToken;
