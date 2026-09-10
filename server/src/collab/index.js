/**
 * The WebSocket side of collaborative editing: who may open a room, and for which field.
 *
 * Attached to the same HTTP server the API runs on, so there is one port, one origin and one
 * reverse-proxy rule to get right. A separate service would be a second thing to deploy and a
 * second thing to authenticate.
 *
 * ## Authentication
 *
 * From a cookie, because a WebSocket handshake carries cookies and cannot carry an `Authorization`
 * header. The two usual ways round that are both worse: a token in the query string ends up in
 * every proxy access log, and a token in the subprotocol header is a token in a header nobody
 * expects to be secret.
 *
 * Its own cookie — `engy_collab`, scoped to this path — rather than the media one. A cookie is only
 * sent to the path it was scoped to, and the media cookie is scoped to `/api/media`, so it never
 * arrives here at all: every upgrade was refused while evidence loaded perfectly. Widening that
 * scope would have been the wrong fix, because it is a seven-day credential and `/api` is every
 * request the app makes. Two narrow cookies, with different scope claims, so neither opens the
 * other's door.
 *
 * It is httpOnly, signed, versioned against the account and checked against the session, so signing
 * out closes it at the same moment it closes everything else.
 *
 * ## Authorisation
 *
 * Per room, and per engagement, against the same clause every page uses. A room name carries the
 * engagement it belongs to, and a socket is only joined once that engagement has been loaded
 * through `visibleAuditFilter` — so a room name guessed from another engagement's id is a 403 and
 * not a document. Read-only accounts are refused: a shared document has no read-only seat, and one
 * that looked read-only but let a keystroke through would be a lie.
 */

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { log } from '../utils/logger.js';
import { User } from '../models/user.model.js';
import { Audit } from '../models/audit.model.js';
import { Session } from '../models/session.model.js';
import { Settings } from '../models/settings.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { COLLAB_COOKIE } from '../middleware/auth.js';
import { joinRoom } from './rooms.js';

export const COLLAB_PATH = '/api/collab';

/**
 * A room name, and the only shape this server accepts.
 *
 * One field of one thing, named below. Per field rather than per engagement, because a room is the
 * unit that gets written back to one string in Mongo — and because two people writing different
 * findings should not be sharing a document at all.
 *
 * The list is a whitelist, and that is the point: a room is not "any path the client asks for". A
 * field added to a finding next year is not shareable until somebody adds it here, which is the
 * same argument `share.service.js` makes about what a client link may show.
 *
 * Both kinds of field are here. A rich-text one carries a ProseMirror document; a single-line one
 * carries a `Y.Text` that `CollaborativeInput` binds to a plain box. This server cannot tell them
 * apart and does not need to — it has never known what is inside a room.
 */
/** The prose fields of a finding, and its title, which is a plain box sharing a `Y.Text`. */
const FINDING_FIELDS = 'title|description|scope|poc|observation|remediation';
/** A step's write-up, and every single-line box beside it. */
const STEP_FIELDS = 'content|title|tool|target|command|ranAt|summary';

const ROOM = new RegExp(
  `^([0-9a-f]{24})/(` +
    `finding/[0-9a-f]{24}/(?:${FINDING_FIELDS})` +
    `|section/[0-9a-f]{24}` +
    `|note/[0-9a-f]{24}` +
    `|step/[0-9a-f]{24}/(?:${STEP_FIELDS})` +
    `)$`
);

/** The cookie header, parsed just enough to find one name. */
function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

/** Who is asking, from the cookie a browser sends by itself. */
async function userFromRequest(request) {
  const cookie = readCookie(request.headers?.cookie, COLLAB_COOKIE);
  if (!cookie) return null;

  let payload;
  try {
    payload = jwt.verify(cookie, env.jwt.refreshSecret);
  } catch {
    return null;
  }
  /* Its own scope: a cookie minted for evidence must not open somebody's document. */
  if (payload.scope !== 'collab') return null;

  const user = await User.findById(payload.sub);
  if (!user || user.signInBlock?.()) return null;
  if (user.tokenVersion !== payload.version) return null;
  /*
   * A signed-out session must not keep a socket open, the same rule the media route applies.
   *
   * Matched on `sid`, which is the session's own identifier and not its `_id`. Getting that wrong
   * refused every real sign-in while every test passed, because a token minted without a session
   * skips this branch entirely — so the bug was invisible to anything that did not log in properly.
   */
  if (payload.sid) {
    const session = await Session.findOne({ sid: payload.sid }).select('revokedAt');
    if (!session || session.revokedAt) return null;
  }
  return user;
}

/**
 * Whether this person may edit this engagement at all.
 *
 * The same clause the rest of the app scopes by, so membership that has run out, an engagement in
 * the trash and a restricted engagement somebody is not on all refuse here exactly as they refuse
 * everywhere else. Nothing about collaboration widens who can see what.
 */
async function mayEdit(user, auditId) {
  if (user.role === 'readonly') return false;
  if (!mongoose.isValidObjectId(auditId)) return false;
  const audit = await Audit.findOne(
    visibleAuditFilter(user, { _id: auditId })
  ).select('_id state deletedAt');
  if (!audit || audit.deletedAt) return false;
  /* An approved report is frozen for everyone but an admin — the page says so, and so does this. */
  if (audit.state === 'APPROVED' && user.role !== 'admin') return false;
  return true;
}

/**
 * Attaches the collaboration server to an HTTP server.
 *
 * `noServer` and an explicit upgrade handler rather than a path option, because the answer to an
 * unauthenticated or wrong-shaped upgrade should be an HTTP status a proxy and a developer can both
 * read, not a socket that opens and then closes for reasons nobody can see.
 */
export function attachCollabServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', async (request, socket, head) => {
    const refuse = (status, why) => {
      log.warn(`Collab upgrade refused (${status}): ${why}`);
      socket.write(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    try {
      const url = new URL(request.url, 'http://localhost');
      if (!url.pathname.startsWith(`${COLLAB_PATH}/`)) {
        /* Not ours. Another upgrade handler may want it; if nobody does, the socket is dropped. */
        return;
      }

      /*
       * Switched off is switched off, checked here rather than trusted to the client.
       *
       * The browser is told whether the instance shares documents and does not try when it does
       * not, so this is a backstop rather than the gate anybody meets — which is why it is not
       * logged as a warning: an administrator turning the feature off should not thereby fill
       * their log with refusals.
       */
      const settings = await Settings.getSettings();
      if (!settings.collab?.enabled) {
        socket.write('HTTP/1.1 403 Collaborative editing is switched off\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const name = decodeURIComponent(url.pathname.slice(COLLAB_PATH.length + 1));
      const match = ROOM.exec(name);
      if (!match) return refuse(400, 'Bad room');

      const user = await userFromRequest(request);
      if (!user) return refuse(401, 'Unauthorized');
      if (!(await mayEdit(user, match[1]))) return refuse(403, 'Forbidden');

      wss.handleUpgrade(request, socket, head, (ws) => {
        /*
         * Named here, from the account rather than from anything the client says about itself.
         * A cursor label is shown to colleagues as a fact about who is typing; letting the client
         * choose it would make it a claim.
         */
        ws.collabUser = {
          id: String(user._id),
          name: user.fullname || user.username,
          username: user.username,
        };
        ws.collabSocketId = `${user._id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        joinRoom(name, ws);
        log.debug?.(`Collab: ${user.username} joined ${name}`);
      });
    } catch (error) {
      refuse(500, 'Upgrade failed');
      log.warn(`Collab upgrade error: ${error.message}`);
    }
  });

  return wss;
}

export default attachCollabServer;
