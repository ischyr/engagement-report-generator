import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import {
  User,
  SIGN_IN_BLOCK_MESSAGES,
  WORKING_ROLES,
  ROLE_LABELS,
} from '../models/user.model.js';
import { Session } from '../models/session.model.js';
import { unauthorized, forbidden } from '../utils/http-error.js';
import asyncHandler from '../utils/async-handler.js';

export const REFRESH_COOKIE = 'engy_refresh';

/**
 * A second, narrower cookie that exists only so `<img src="/api/media/…">` works.
 *
 * The access token lives in memory to keep it away from XSS, but an `<img>` tag
 * cannot carry an Authorization header. Cookies it sends automatically — so
 * evidence is authenticated by a cookie scoped to the media path and nothing
 * else, the same containment idea as the refresh cookie being scoped to
 * `/api/auth`. Stolen, it grants exactly one capability: reading images.
 */
export const MEDIA_COOKIE = 'engy_media';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, roles: user.roles ?? [], username: user.username },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl }
  );
}

/**
 * `sid` names the session row this token belongs to, so one browser can be signed
 * out without ending every other one. Absent on tokens issued before sessions were
 * recorded — those are honoured until they expire rather than logging everybody out
 * on deploy, and they simply do not appear in the session list.
 */
export function signRefreshToken(user, sid) {
  return jwt.sign(
    { sub: user._id.toString(), version: user.tokenVersion, ...(sid ? { sid } : {}) },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshTtl }
  );
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function signMediaToken(user, sid) {
  return jwt.sign(
    { sub: user._id.toString(), version: user.tokenVersion, scope: 'media', ...(sid ? { sid } : {}) },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshTtl }
  );
}

export function mediaCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/api/media',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

/** Whether a session id still names a session that has not been signed out. */
async function sessionIsLive(sid) {
  const session = await Session.findOne({ sid }).select('revokedAt');
  return Boolean(session) && !session.revokedAt;
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * The account behind a verified token, or an explanation of why it cannot be used.
 *
 * Says which of the two it is — turned off, or never let in — because a token that
 * stops working the moment an admin revokes approval is only useful if the person
 * holding it can tell that from an expiry and stop retrying.
 */
function usableAccount(user) {
  if (!user) throw unauthorized('Account no longer exists');
  const block = user.signInBlock();
  if (block) throw unauthorized(SIGN_IN_BLOCK_MESSAGES[block]);
  return user;
}

/** Rejects the request unless a valid, approved, enabled user is behind it. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw unauthorized('Missing access token');

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token');
  }

  req.user = usableAccount(await User.findById(payload.sub));
  return next();
});

/**
 * Auth for image requests: the normal access token if the caller can send one,
 * otherwise the media cookie that an `<img>` tag carries by itself.
 *
 * `tokenVersion` is checked, so disabling an account or forcing a password change
 * cuts off evidence access at the same moment it cuts off everything else.
 */
export const requireMediaAuth = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, env.jwt.accessSecret);
      const user = await User.findById(payload.sub);
      if (user && !user.signInBlock()) {
        req.user = user;
        return next();
      }
    } catch {
      // Fall through to the cookie: an expired access token is the common case
      // for a page that has been open a while, and the cookie outlives it.
    }
  }

  const cookie = req.cookies?.[MEDIA_COOKIE];
  if (!cookie) throw unauthorized('Not signed in');

  let payload;
  try {
    payload = jwt.verify(cookie, env.jwt.refreshSecret);
  } catch {
    throw unauthorized('Media session expired');
  }
  if (payload.scope !== 'media') throw unauthorized('Wrong token for this route');

  const user = usableAccount(await User.findById(payload.sub));
  if (user.tokenVersion !== payload.version) throw unauthorized('Media session expired');
  // The media cookie lives as long as the refresh token, so without this a signed-out
  // session would keep reading a client's evidence for days after being ended.
  if (payload.sid && !(await sessionIsLive(payload.sid))) {
    throw unauthorized('That session has been signed out');
  }

  req.user = user;
  return next();
});

/**
 * Route guard: `requireRole('admin')`. Admins always pass.
 *
 * Reads every role the account holds, not just the primary one. The whole point of an account
 * being able to hold more than one is that a consultant who is also a manager passes both a
 * consultant check and a manager check.
 */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.hasRole(...roles)) return next();
    return next(
      forbidden(
        `This action requires one of: ${roles.map((role) => ROLE_LABELS[role] ?? role).join(', ')}`
      )
    );
  };

/** Blocks mutating verbs for read-only accounts. */
export const requireWrite = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  /*
   * Read-only means read-only whatever else the account holds — the point of the role is that
   * somebody cannot change anything, so a second role must not quietly undo it. Anybody meant to
   * write simply does not have it.
   */
  if ((req.user.roles ?? []).includes('readonly')) {
    return next(forbidden('Your account is read-only'));
  }
  return next();
};

/**
 * Everything past the auth gate that a sales account may reach.
 *
 * An allowlist, not a denylist, because the two fail in opposite directions: a route
 * added tomorrow and forgotten is invisible to sales under this rule, and visible to them
 * under the other one. Being locked out of something new is a complaint; being let into
 * the whole client's findings is a breach.
 *
 * Prefixes rather than exact paths, so `/sales/anything` and `/notifications/:id/read`
 * come along without listing every verb.
 *
 *   /sales         — the section itself
 *   /proposals     — the pipeline, which sales drives and the work side evaluates
 *   /version       — the build label in the footer
 *   /notifications — their own bell, which holds nothing about anybody's work
 *   /presence      — the heartbeat the shell sends on a timer for everybody
 *
 * Account management is not in the list because it does not need to be: `/auth` is
 * mounted before this gate, so changing a password or pairing an authenticator works for
 * every role without an exception here.
 */
const SALES_PREFIXES = ['/sales', '/proposals', '/version', '/notifications', '/presence'];

/**
 * Keeps a sales account inside the Sales section.
 *
 * Mounted once, immediately after the token check, rather than as a guard on each of the
 * two dozen routers it would otherwise have to be remembered on. Hiding the nav links is
 * not access control — a URL typed by hand, or a client left open while somebody's role
 * changed, both arrive here.
 *
 * Written as "confine anything that is not a working role" rather than "confine sales",
 * so it fails safe: a role this function has not heard of is walled in rather than let
 * through. That is not hypothetical — this role was called `finance` for one commit, and
 * under the other spelling a leftover account would have been handed the whole app.
 */
export const confineSales = (req, _res, next) => {
  // Any working role is enough. An account that is both sales and a consultant works here.
  if (!req.user || (req.user.roles ?? []).some((role) => WORKING_ROLES.includes(role))) {
    return next();
  }
  // `req.path` here is relative to where this middleware is mounted, i.e. under /api.
  const allowed = SALES_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
  );
  if (allowed) return next();
  return next(forbidden('This account only has access to the Sales section'));
};

export default requireAuth;
