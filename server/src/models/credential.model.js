import mongoose from 'mongoose';

/**
 * A credential the client handed over for the length of an engagement.
 *
 * Its own collection, for the same reason deleted findings have one: a secret must be
 * invisible to everything that reads an engagement — report data, the tag catalogue, the
 * search index, a `GET /audits/:id` that some future feature spreads into a template —
 * and remembering to strip it in each of those is a list nobody can be sure they finished.
 * Living outside the audit makes that structural rather than careful.
 *
 * The secret itself is never stored in the clear; `secret` holds the AES-GCM parts. The
 * label, username and URL are not encrypted, because a list you cannot read is not a list,
 * and knowing that "the VPN account" exists is not the same as holding it.
 */
const credentialSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    username: { type: String, default: '', trim: true, maxlength: 200 },
    url: { type: String, default: '', trim: true, maxlength: 500 },
    /** What it is for, where it came from, which environment. Not a secret. */
    notes: { type: String, default: '', maxlength: 2000 },

    /** AES-256-GCM: initialisation vector, auth tag and ciphertext, all base64. */
    secret: {
      iv: { type: String, required: true },
      tag: { type: String, required: true },
      data: { type: String, required: true },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Who has looked, and when they last did.
     *
     * A credential store without an access trail asks the team to trust each other and
     * gives the client nothing. Revealing one is a deliberate act and is recorded as one,
     * in the engagement's activity log as well as here.
     */
    reveals: { type: Number, default: 0 },
    lastRevealedAt: { type: Date, default: null },
    lastRevealedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Optional self-destruct. Mongo deletes the row itself, so a credential set to expire
     * does not depend on anybody remembering — which is the whole point of setting it.
     */
    expiresAt: { type: Date, default: null, expires: 0 },
  },
  { timestamps: true }
);

credentialSchema.index({ audit: 1, createdAt: -1 });

export const Credential = mongoose.model('Credential', credentialSchema);
export default Credential;
