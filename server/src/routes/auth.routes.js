import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import env from '../config/env.js';
import { User, SIGN_IN_BLOCK_MESSAGES } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import { Session, newSessionId } from '../models/session.model.js';
import { Notification } from '../models/notification.model.js';
import { describeDevice } from '../utils/device-key.js';
import { consumeAccountToken, readAccountToken } from '../services/account-tokens.service.js';
import { notifyAdminsOfPendingAccount } from '../services/account-approval.service.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound, unauthorized } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import {
  requireAuth,
  signAccessToken,
  signRefreshToken,
  signMediaToken,
  refreshCookieOptions,
  mediaCookieOptions,
  REFRESH_COOKIE,
  MEDIA_COOKIE,
} from '../middleware/auth.js';
import {
  consumeCode,
  disableTotp,
  finishEnrolment,
  hasPendingEnrolment,
  loadEnrolChallenge,
  loadLoginChallenge,
  resumeEnrolment,
  signEnrolChallenge,
  signLoginChallenge,
  startEnrolment,
} from '../services/mfa.service.js';

const router = Router();

/** Brute-force guard on the credential endpoints only. */
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Username must be at least 3 characters')
    .max(40)
    .regex(/^[a-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore only'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: passwordSchema,
  firstname: z.string().trim().max(80).optional().default(''),
  lastname: z.string().trim().max(80).optional().default(''),
});

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

/** How long a refresh cookie — and therefore a session row — lives. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The first line of a user agent string, trimmed to something readable.
 *
 * Kept raw rather than parsed into "Chrome on Windows": a wrong guess about somebody's
 * browser is worse than the honest string when the question being asked is "do I
 * recognise this session".
 */
const describeAgent = (req) => String(req?.headers?.['user-agent'] ?? '').slice(0, 400);

/**
 * Tells somebody their account was used from a browser it has not been used from before.
 *
 * The only notification in the app that is about the account rather than the work, and the one
 * most worth interrupting for: this instance holds borrowed client credentials and
 * vulnerabilities that are not public yet.
 *
 * Two deliberate quiets. A first-ever sign-in says nothing — everybody's first device is new,
 * and a warning on the way in teaches people the warning is noise. And the address alone never
 * triggers it: home broadband and mobile networks rotate addresses constantly, so an
 * IP-sensitive notice would fire weekly and be ignored by the second month. The address is
 * *reported* in the message, because it is what makes an unexpected notice actionable.
 */
async function noticeNewDevice({ user, req, device }) {
  const seen = await Session.countDocuments({ user: user._id, deviceKey: device.key });
  if (seen > 0) return false;
  // Nothing to compare against: this is the first session this account has ever had.
  const anyBefore = await Session.countDocuments({ user: user._id });
  if (anyBefore === 0) return false;

  await Notification.create({
    user: user._id,
    type: 'new-sign-in',
    actor: user._id,
    message: `Signed in from ${device.label}${callerIp(req) ? ` at ${callerIp(req)}` : ''} for the first time`,
    href: '/profile',
  });
  return true;
}

/** Behind a proxy this is only as trustworthy as `trust proxy`, so it is a hint. */
const callerIp = (req) => String(req?.ip ?? req?.socket?.remoteAddress ?? '').slice(0, 60);

/**
 * Issues the cookies and the access token for one browser.
 *
 * A new session row per sign-in, reused on refresh: without that, "where am I signed
 * in" cannot be answered and signing one browser out means signing all of them out.
 */
async function issueSession(res, user, req, existingSid = null) {
  let sid = existingSid;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  if (sid) {
    // Refresh: keep the row, push its expiry out and note that it is still in use.
    await Session.updateOne(
      { sid },
      { $set: { lastSeenAt: new Date(), expiresAt, userAgent: describeAgent(req), ip: callerIp(req) } }
    );
  } else {
    const device = describeDevice(describeAgent(req));
    /*
     * Asked *before* the row is written, or the new session would be the very thing that makes
     * itself look familiar.
     */
    await noticeNewDevice({ user, req, device });

    sid = newSessionId();
    await Session.create({
      user: user._id,
      sid,
      userAgent: describeAgent(req),
      ip: callerIp(req),
      deviceKey: device.key,
      expiresAt,
    });
  }

  res.cookie(REFRESH_COOKIE, signRefreshToken(user, sid), refreshCookieOptions());
  // Scoped to /api/media, so <img> tags can load evidence without the access
  // token an image request cannot carry.
  res.cookie(MEDIA_COOKIE, signMediaToken(user, sid), mediaCookieOptions());
  return { user: user.toPublic(), accessToken: signAccessToken(user) };
}

/** Keeps the last ten rejected attempts on the account, newest first. */
async function recordFailedLogin(user, req, reason) {
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        failedLogins: {
          $each: [{ at: new Date(), ip: callerIp(req), userAgent: describeAgent(req), reason }],
          $position: 0,
          $slice: 10,
        },
      },
    }
  );
}

/**
 * The answer for somebody who has done everything right and still cannot come in.
 *
 * A 200 rather than a 403, and deliberately so: nothing has gone wrong. They typed the
 * right password, they paired an app, and what remains is a person elsewhere pressing a
 * button. `mfaRequired` already works this way — a successful reply that is not yet a
 * session — and reusing that shape keeps the client from having to treat a normal state
 * as an error.
 */
function awaitingApproval(user) {
  return {
    approvalRequired: true,
    username: user.username,
    /** So the screen can say "you are set up" rather than only "you are waiting". */
    twoFactorReady: Boolean(user.totpEnabled),
  };
}

/* -------------------------------------------------------------------------- */

/** Lets the login screen show "create the first account" instead of a form. */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const count = await User.estimatedDocumentCount();

    /*
     * Branding rides along here because the sign-in screen needs it before anyone is
     * authenticated, and the settings document is admin-only. Only these three
     * fields — nothing else from Settings is public.
     */
    let branding = { appName: 'Engy Report', tagline: 'Engagement Reporting', logo: '' };
    try {
      const settings = await Settings.getSettings();
      branding = {
        appName: settings.branding?.appName || branding.appName,
        tagline: settings.branding?.tagline ?? branding.tagline,
        logo: settings.branding?.logo ?? '',
      };
    } catch {
      // The sign-in screen must render even if the settings document cannot be read.
    }

    res.json({
      registrationOpen: env.allowRegistration || count === 0,
      needsBootstrap: count === 0,
      /*
       * Said before the form is filled in, not after. Somebody who registers expecting to
       * be working in a minute and instead meets a waiting screen has been misled by the
       * page, and the fix is on the page rather than in the wording of the refusal.
       *
       * False while bootstrapping: the first account has nobody to approve it.
       */
      approvalRequired: count > 0,
      userCount: count,
      branding,
    });
  })
);

/**
 * Registration hands back an enrolment challenge rather than a session: every
 * new account must set up an authenticator before it can be used. No access
 * token and no refresh cookie are issued until a code has been verified — and
 * on any instance that already has accounts, not even then, until an
 * administrator approves it.
 */
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const count = await User.countDocuments();
    // The very first account always gets through, and becomes the admin.
    if (count > 0 && !env.allowRegistration) {
      throw forbidden('Registration is closed. Ask an administrator to create your account.');
    }

    const { username, email, password, firstname, lastname } = req.body;
    const clash = await User.findOne({ $or: [{ username }, { email }] });
    if (clash) {
      throw badRequest(
        clash.username === username ? 'That username is taken' : 'That email is already registered'
      );
    }

    const user = await User.create({
      username,
      email,
      password,
      firstname,
      lastname,
      role: count === 0 ? 'admin' : 'user',
      // New accounts must pair an authenticator before they can be used.
      totpEnrolmentRequired: true,
      /*
       * The first account on an empty instance lets itself in — there is nobody else to
       * ask, and an instance whose only account is waiting for approval is an instance
       * nobody can ever use. Everybody after that waits.
       */
      approvedAt: count === 0 ? new Date() : null,
    });

    const enrolment = await startEnrolment(user);
    res.status(201).json({
      enrolmentRequired: true,
      enrolmentToken: signEnrolChallenge(user),
      enrolment,
      /** So the enrolment screen already knows what happens when the code is accepted. */
      approvalRequired: !user.approvedAt,
      user: user.toPublic(),
    });
  })
);

/**
 * Second half of registration: the code proves the app holds the secret.
 *
 * And the last point at which a self-registered account stops. Enrolment is finished
 * first and kept — the work the new person did is not thrown away because they have to
 * wait — but no session is issued, and this is where the admins are told, because a
 * registration that got this far is a real request rather than an abandoned tab.
 */
router.post(
  '/register/verify',
  authLimiter,
  validate(z.object({ enrolmentToken: z.string().min(10), code: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const user = await loadEnrolChallenge(req.body.enrolmentToken);
    await finishEnrolment(user, req.body.code);

    if (!user.approvedAt) {
      await notifyAdminsOfPendingAccount(user);
      return res.json(awaitingApproval(user));
    }

    user.lastLoginAt = new Date();
    user.lastSeenAt = new Date();
    await user.save({ validateBeforeSave: false });

    res.json(await issueSession(res, user, req));
  })
);

/**
 * What is behind a one-time link, without spending it.
 *
 * Enough for the form to greet the right person and nothing more: no email, no role, no hint
 * about what else the account can do. A wrong or expired token is simply "not valid" — "no such
 * token" and "that expired" are the same answer to somebody guessing, and the person holding a
 * real link does not need the difference to know they should ask for another.
 */
router.get(
  '/set-password/:token',
  authLimiter,
  asyncHandler(async (req, res) => {
    const row = await readAccountToken(req.params.token);
    if (!row) throw badRequest('That link is not valid any more. Ask for a new one.');
    res.json({
      valid: true,
      purpose: row.purpose,
      username: row.user.username,
      fullname:
        [row.user.firstname, row.user.lastname].filter(Boolean).join(' ') || row.user.username,
      expiresAt: row.expiresAt,
    });
  })
);

/**
 * Spends it.
 *
 * Deliberately does *not* sign anybody in. A link that both sets a password and hands back a
 * session would make the link itself a credential — forwarded once in a chat, it is the account.
 * Setting the password and then typing it is one extra step and the only thing that proves the
 * person at the keyboard is the one who chose it.
 */
router.post(
  '/set-password/:token',
  authLimiter,
  validate(z.object({ password: passwordSchema })),
  asyncHandler(async (req, res) => {
    const result = await consumeAccountToken(req.params.token, req.body.password);
    if (!result) throw badRequest('That link is not valid any more. Ask for a new one.');
    res.json({
      ok: true,
      purpose: result.purpose,
      username: result.user.username,
      /** Every other session for this account has just been ended — say so rather than not. */
      signedOutEverywhere: true,
    });
  })
);

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    // Accept either the username or the email address.
    const user = await User.findOne({
      $or: [{ username }, { email: username }],
    }).select('+password +totpSecret');

    // Same message either way — don't reveal which usernames exist.
    if (!user || !(await user.verifyPassword(password))) {
      // Only when the account exists: a failure against a name nobody owns has
      // nobody to tell, and keeping it would build a list of guessed usernames.
      if (user) await recordFailedLogin(user, req, 'password');
      throw unauthorized('Incorrect username or password');
    }
    if (!user.enabled) throw forbidden(SIGN_IN_BLOCK_MESSAGES.disabled);

    /*
     * Waiting for approval, and past the point where it could do the one thing it is
     * allowed to do.
     *
     * The exception is deliberate and is the whole shape of this feature: an unapproved
     * account may still finish pairing an authenticator, so the setup that is the new
     * person's to do happens while they wait rather than after. Anything else it might
     * ask for — including being sent a code it would only be refused for — stops here.
     */
    if (!user.approvedAt && !hasPendingEnrolment(user)) {
      return res.json(awaitingApproval(user));
    }

    // Password was right but the account still owes a second factor.
    if (user.totpEnabled) {
      return res.json({
        mfaRequired: true,
        mfaToken: signLoginChallenge(user),
        username: user.username,
      });
    }

    // Registered but never confirmed a code. Without this branch the enrolment
    // screen could simply be closed and the account used with a password alone,
    // which would make enrolment optional in practice.
    if (hasPendingEnrolment(user)) {
      return res.json({
        enrolmentRequired: true,
        enrolmentToken: signEnrolChallenge(user),
        enrolment: await resumeEnrolment(user),
        username: user.username,
      });
    }

    // Accounts that predate 2FA, or that turned it off, sign in directly and are
    // nudged to enrol from their profile.
    user.lastLoginAt = new Date();
    user.lastSeenAt = new Date();
    await user.save({ validateBeforeSave: false });

    return res.json(await issueSession(res, user, req));
  })
);

/** Second step of login: exchange the challenge plus a code for a session. */
router.post(
  '/login/verify',
  authLimiter,
  validate(z.object({ mfaToken: z.string().min(10), code: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const user = await loadLoginChallenge(req.body.mfaToken);
    if (!user.totpEnabled) {
      throw badRequest('Two-factor authentication is not enabled for this account.');
    }
    try {
      await consumeCode(user, req.body.code);
    } catch (err) {
      // Somebody with the password but not the authenticator is the attempt most
      // worth showing its owner.
      await recordFailedLogin(user, req, 'code');
      throw err;
    }

    /*
     * Should be unreachable — `/login` refuses to mint a challenge for an unapproved
     * account — but a challenge is a token with a lifetime of its own, and approval can
     * be withdrawn inside it. Checked here so the gate does not depend on the order two
     * requests happen to arrive in.
     */
    if (!user.approvedAt) return res.json(awaitingApproval(user));

    user.lastLoginAt = new Date();
    user.lastSeenAt = new Date();
    await user.save({ validateBeforeSave: false });

    res.json(await issueSession(res, user, req));
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh token');

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.refreshSecret);
    } catch {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.clearCookie(MEDIA_COOKIE, mediaCookieOptions());
      throw unauthorized('Session expired, please sign in again');
    }

    const user = await User.findById(payload.sub);
    // tokenVersion is bumped on logout-everywhere, password changes, and revoked approval.
    if (!user || user.signInBlock() || user.tokenVersion !== payload.version) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      res.clearCookie(MEDIA_COOKIE, mediaCookieOptions());
      throw unauthorized('Session is no longer valid');
    }

    /*
     * This is where signing a session out actually takes effect. The access token that
     * browser already holds keeps working until it expires — up to JWT_ACCESS_TTL,
     * 30 minutes by default — and then the refused refresh signs it out for good.
     * Tokens minted before sessions were recorded carry no `sid` and are honoured
     * until they expire, rather than logging everybody out on upgrade.
     */
    if (payload.sid) {
      const session = await Session.findOne({ sid: payload.sid }).select('revokedAt');
      if (!session || session.revokedAt) {
        res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
        res.clearCookie(MEDIA_COOKIE, mediaCookieOptions());
        throw unauthorized('That session was signed out');
      }
    }

    res.json(await issueSession(res, user, req, payload.sid ?? null));
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // End the session row too, otherwise "sign out" only deletes the cookies and the
    // session stays listed as live on every other device.
    const refresh = req.cookies?.[REFRESH_COOKIE];
    if (refresh) {
      try {
        const { sid } = jwt.verify(refresh, env.jwt.refreshSecret);
        if (sid) await Session.updateOne({ sid, revokedAt: null }, { $set: { revokedAt: new Date() } });
      } catch {
        /* an expired cookie has nothing left to revoke */
      }
    }
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.clearCookie(MEDIA_COOKIE, mediaCookieOptions());
    // Drop presence straight away so signing out does not leave a ghost in the
    // online list until the heartbeat window expires. Best-effort: the caller may
    // not have a valid access token by this point.
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) {
      try {
        const { sub } = jwt.verify(token, env.jwt.accessSecret);
        await User.updateOne({ _id: sub }, { $set: { lastSeenAt: null, activity: '' } });
      } catch {
        /* expired or absent token — nothing to clear */
      }
    }
    res.json({ ok: true });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user.toPublic() });
  })
);

/* ------------------------------- sessions --------------------------------- */

/** The session this request's refresh cookie belongs to, if it still has one. */
function currentSid(req) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, env.jwt.refreshSecret).sid ?? null;
  } catch {
    return null;
  }
}

/**
 * Where this account is signed in, and what has been refused lately.
 *
 * Own sessions only — there is no route to read anybody else's, including for an
 * admin, because "who is signed in where" is not the same authority as managing
 * accounts. An admin who needs somebody out disables the account or resets their
 * password, both of which end every session at once.
 */
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sid = currentSid(req);
    const sessions = await Session.find({ user: req.user._id, revokedAt: null })
      .select('sid userAgent ip deviceKey lastSeenAt createdAt expiresAt')
      .sort({ lastSeenAt: -1 });

    res.json({
      sessions: sessions.map((session) => ({
        id: session._id.toString(),
        // The sid itself is never published: it is the thing the cookie proves.
        current: Boolean(sid) && session.sid === sid,
        userAgent: session.userAgent,
        /** The browser and platform in words, so the list is readable without parsing a UA. */
        device: describeDevice(session.userAgent).label,
        ip: session.ip,
        lastSeenAt: session.lastSeenAt,
        signedInAt: session.createdAt,
        expiresAt: session.expiresAt,
      })),
      failedLogins: req.user.failedLogins ?? [],
      /** How long a signed-out session's access token can still be used. */
      accessTtl: env.jwt.accessTtl,
    });
  })
);

/** Signs one session out. Yours only, and the current one is allowed. */
router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await Session.findOne({ _id: req.params.id, user: req.user._id });
    if (!session) throw notFound('No such session');

    session.revokedAt = session.revokedAt ?? new Date();
    await session.save();

    // Ending the session you are in is a sign-out, so the cookies have to go too.
    if (session.sid === currentSid(req)) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      res.clearCookie(MEDIA_COOKIE, mediaCookieOptions());
    }
    res.json({ ok: true, current: session.sid === currentSid(req) });
  })
);

/**
 * Everywhere but here.
 *
 * Deliberately not a `tokenVersion` bump: that is the all-or-nothing control, and it
 * would sign out the browser asking as well.
 */
router.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sid = currentSid(req);
    const result = await Session.updateMany(
      { user: req.user._id, revokedAt: null, ...(sid ? { sid: { $ne: sid } } : {}) },
      { $set: { revokedAt: new Date() } }
    );
    res.json({ ok: true, revoked: result.modifiedCount ?? 0 });
  })
);

/** Clears the rejected-attempt list once its owner has read it. */
router.delete(
  '/failed-logins',
  requireAuth,
  asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $set: { failedLogins: [] } });
    res.json({ ok: true });
  })
);

router.put(
  '/me',
  requireAuth,
  validate(
    z.object({
      firstname: z.string().trim().max(80).optional(),
      lastname: z.string().trim().max(80).optional(),
      email: z.string().trim().toLowerCase().email().optional(),
      phone: z.string().trim().max(40).optional(),
      title: z.string().trim().max(80).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    Object.assign(req.user, req.body);
    await req.user.save();
    res.json({ user: req.user.toPublic() });
  })
);

/* -------------------------------------------------------------------------- */
/* Two-factor, managed from the user's own profile                            */
/* -------------------------------------------------------------------------- */

/** Begins (or restarts) enrolment for an account that has 2FA switched off. */
router.post(
  '/me/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select(
      '+totpSecret +totpLastStep +totpFailures +totpLockedUntil'
    );
    const enrolment = await startEnrolment(user);
    res.json({ enrolment });
  })
);

router.post(
  '/me/2fa/enable',
  requireAuth,
  authLimiter,
  validate(z.object({ code: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select(
      '+totpSecret +totpLastStep +totpFailures +totpLockedUntil'
    );
    await finishEnrolment(user, req.body.code);
    res.json({ user: user.toPublic() });
  })
);

/**
 * Turning 2FA off needs the current password *and* a valid code — otherwise
 * whoever is holding a live session could quietly remove the second factor.
 */
router.post(
  '/me/2fa/disable',
  requireAuth,
  authLimiter,
  validate(z.object({ password: z.string().min(1, 'Password is required'), code: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select(
      '+password +totpSecret +totpLastStep +totpFailures +totpLockedUntil'
    );
    if (!user.totpEnabled) throw badRequest('Two-factor authentication is already off.');
    if (!(await user.verifyPassword(req.body.password))) {
      throw badRequest('That password is not correct.');
    }
    await consumeCode(user, req.body.code);
    await disableTotp(user);
    res.json({ user: user.toPublic() });
  })
);

router.put(
  '/me/password',
  requireAuth,
  validate(
    z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: passwordSchema,
    })
  ),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.verifyPassword(req.body.currentPassword))) {
      throw badRequest('Current password is incorrect');
    }
    user.password = req.body.newPassword;
    // Invalidate refresh tokens issued before the change.
    user.tokenVersion += 1;
    await user.save();
    // The bump already makes them unusable; marking them revoked keeps the session
    // list honest rather than showing sessions that would be refused if used.
    await Session.updateMany(
      { user: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    res.json(await issueSession(res, user, req));
  })
);

export default router;
