import crypto from 'node:crypto';
import mongoose from 'mongoose';

/**
 * One signed-in browser.
 *
 * The refresh token already proved who you are; what it could not answer is *where
 * you are signed in*. For a tool holding unreleased client vulnerabilities, "is there
 * a session I do not recognise" and "sign that one out" are not luxuries, and
 * `tokenVersion` — the only control that existed — is all-or-nothing: it ends every
 * session everywhere, including the one asking.
 *
 * The refresh token carries this document's `sid`, so a session can be refused
 * individually without touching the others.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Random, and the only link between a cookie and this row. */
    sid: { type: String, required: true, unique: true },

    /**
     * Descriptive only, and never trusted: both are client-controlled. They exist so a
     * person can recognise their own sessions, not to authenticate anything.
     */
    userAgent: { type: String, default: '', maxlength: 400 },
    ip: { type: String, default: '', maxlength: 60 },

    /**
     * The browser and platform, reduced to something comparable.
     *
     * Stored rather than derived on the fly so "have I signed in from this before" is an
     * indexed lookup rather than a scan that re-parses every past user-agent string. See
     * `utils/device-key.js` for why the version numbers are deliberately thrown away.
     */
    deviceKey: { type: String, default: '', maxlength: 120 },

    /**
     * Moves when the session refreshes, which is roughly once per access-token
     * lifetime. So this is "seen within the last few minutes", not to the second.
     */
    lastSeenAt: { type: Date, default: Date.now },
    /** Set when signed out, from here or from another session. */
    revokedAt: { type: Date, default: null },
    /** Why it ended, when something other than the person's own sign-out ended it. */
    revokedReason: { type: String, default: '' },
    /**
     * Mongo deletes the row itself once the refresh token behind it could no longer
     * be valid, so this collection cannot grow without bound.
     */
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

// "My live sessions, newest first" is the only query the page makes.
sessionSchema.index({ user: 1, revokedAt: 1, createdAt: -1 });
// "Have I ever signed in from this browser before", asked once per sign-in.
sessionSchema.index({ user: 1, deviceKey: 1 });

export const newSessionId = () => crypto.randomBytes(24).toString('base64url');

export const Session = mongoose.model('Session', sessionSchema);
export default Session;
