import mongoose from 'mongoose';

/**
 * A one-time link that lets somebody set their own password.
 *
 * Two things were missing and they are the same mechanism. An admin creating an account had to
 * *choose* the password and then tell the person over chat — so the first thing every account
 * ever had was a password its owner did not choose and somebody else knew. And there was no way
 * back in for a forgotten password at all: the only lever was an admin editing the account and,
 * again, conveying the new password by hand.
 *
 * There is no SMTP in this app, deliberately, so the link is *handed back to whoever asked for
 * it* rather than emailed. That is the honest version of the feature: the app guarantees the
 * password is chosen by its owner and never travels through anybody else, and the delivery of a
 * URL is left to a channel the firm already trusts.
 *
 * Only a hash of the token is stored, exactly like a password. A dump of this collection must not
 * be a set of account takeovers, and there is no legitimate reason to read a token back — the
 * only holder that matters is the person with the link.
 */

export const TOKEN_PURPOSES = ['invite', 'reset'];

const accountTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** SHA-256 of the token that went out. Never the token itself. */
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: TOKEN_PURPOSES, required: true },

    /** Who issued it, so an unexpected reset has a name attached to it. */
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Where from, for the same reason. */
    issuedIp: { type: String, default: '' },

    /**
     * Mongo removes the row once it passes. An expired invitation is not a record worth keeping,
     * and a used one is deleted outright — see `consumeAccountToken`.
     */
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

export const AccountToken = mongoose.model('AccountToken', accountTokenSchema);
export default AccountToken;
