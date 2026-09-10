/**
 * Checks collaborative editing on the wire.
 *
 *   npm run test:collab-socket
 *
 * Two sockets in one room, against the real server, speaking the protocol the browser speaks. What
 * is proved here is the part that cannot be proved from the client alone:
 *
 *   - text typed on one socket arrives at the other, and the two documents converge
 *   - somebody joining late is given the document as it stands
 *   - a cursor is announced, and is taken away when its owner disappears
 *   - and the refusals: no cookie, a cookie for an account that cannot edit this engagement, a
 *     room name pointing at somebody else's engagement, a room name that is not a field
 *
 * Needs a database, like the other end-to-end suites. Everything it makes is removed afterwards.
 */

import http from 'node:http';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { attachCollabServer, COLLAB_PATH } from '../collab/index.js';
import { closeAllRooms, roomMembers } from '../collab/rooms.js';
import { signCollabToken, COLLAB_COOKIE } from '../middleware/auth.js';
import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { Session } from '../models/session.model.js';
import { log } from '../utils/logger.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something to become true, rather than for a fixed time. */
async function until(predicate, { timeout = 4000, every = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(every);
  }
  return false;
}

async function main() {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  attachCollabServer(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const wsBase = `ws://127.0.0.1:${port}${COLLAB_PATH}`;

  const made = [];
  let auditId = null;
  let otherAuditId = null;

  const makeUser = async (suffix, role = 'user') => {
    const username = `zz-collab-ws-${suffix}`;
    await User.deleteOne({ username });
    const user = await User.create({
      username,
      email: `${username}@example.invalid`,
      password: 'collab-socket-password',
      role,
      totpEnrolmentRequired: false,
      approvedAt: new Date(),
    });
    made.push(username);
    return user;
  };

  /** A provider, with the cookie a browser would send. */
  const connect = (room, user, doc = new Y.Doc()) => {
    const provider = new WebsocketProvider(wsBase, room, doc, {
      WebSocketPolyfill: class extends WebSocket {
        constructor(address, protocols) {
          super(address, protocols, {
            headers: { Cookie: `${COLLAB_COOKIE}=${signCollabToken(user)}` },
          });
        }
      },
      connect: true,
      /*
       * Everything through the server, which is the only thing this file is for.
       *
       * y-websocket also syncs peers over a BroadcastChannel, and Node has had one since 18 — so
       * two providers in this one process were converging locally while the server sat empty, and
       * every check here passed without a byte crossing the socket. A test that cannot fail is
       * worse than no test.
       */
      disableBc: true,
      /* No reconnection storm in a test that deliberately gets refused. */
      maxBackoffTime: 500,
    });
    return { provider, doc };
  };

  /*
   * Switched on for the duration, and put back exactly as it was found.
   *
   * The feature is off by default — an instance that has not asked for it behaves as it always
   * did — so every check below would otherwise be testing the refusal.
   */
  const { Settings } = await import('../models/settings.model.js');
  const settingsRow = await Settings.getSettings();
  const collabBefore = settingsRow.toObject().collab;
  settingsRow.collab = { enabled: true };
  settingsRow.markModified('collab');
  await settingsRow.save();

  try {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const stranger = await makeUser('stranger');
    const readonly = await makeUser('readonly', 'readonly');

    const audit = await Audit.create({
      name: 'zz-collab-ws engagement',
      creator: alice._id,
      collaborators: [bob._id, readonly._id],
      findings: [{ title: 'zz-collab-ws finding', cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N' }],
    });
    auditId = audit._id;
    const findingId = audit.findings[0]._id;
    const room = `${auditId}/finding/${findingId}/description`;

    const other = await Audit.create({ name: 'zz-collab-ws elsewhere', creator: stranger._id });
    otherAuditId = other._id;

    /* ------------------------------------------------------------ two people */
    log.info('');
    log.info('Two people in one field');

    const first = connect(room, alice);
    const connected = await until(() => first.provider.wsconnected);
    check('a member can open a room', connected, `status ${first.provider.wsconnected}`);

    const second = connect(room, bob);
    await until(() => second.provider.wsconnected);

    first.doc.getText('body').insert(0, 'Hello from Alice.');
    const arrived = await until(() => second.doc.getText('body').toString().includes('Alice'));
    check('what one types arrives at the other', arrived, second.doc.getText('body').toString());

    second.doc.getText('body').insert(0, 'Bob first. ');
    const converged = await until(
      () => first.doc.getText('body').toString() === second.doc.getText('body').toString()
    );
    check(
      'and the two documents converge on the same text',
      converged,
      `${first.doc.getText('body')} | ${second.doc.getText('body')}`
    );

    /* ------------------------------------------------------------ late joiner */
    const late = connect(room, alice);
    const caughtUp = await until(
      () => late.doc.getText('body').toString() === first.doc.getText('body').toString()
    );
    check(
      'somebody arriving late is given the document as it stands',
      caughtUp,
      late.doc.getText('body').toString()
    );
    late.provider.destroy();

    /* -------------------------------------------------------------- presence */
    log.info('');
    log.info('Who is in the room');

    first.provider.awareness.setLocalStateField('user', {
      id: String(alice._id),
      name: 'Alice',
      color: '#8b5cf6',
    });
    const seen = await until(() =>
      [...second.provider.awareness.getStates().values()].some((state) => state?.user?.name === 'Alice')
    );
    check('a cursor is announced to everybody else', seen, JSON.stringify([...second.provider.awareness.getStates().values()]));
    check(
      'and the server can say who is in a room, for the presence dots',
      roomMembers(room).some((person) => person.name === 'Alice'),
      JSON.stringify(roomMembers(room))
    );

    first.provider.destroy();
    const gone = await until(
      () =>
        ![...second.provider.awareness.getStates().values()].some(
          (state) => state?.user?.name === 'Alice'
        ),
      { timeout: 6000 }
    );
    check('and it is taken away when they leave, rather than left behind', gone);

    second.provider.destroy();

    /* -------------------------------------------------------------- refusals */
    log.info('');
    log.info('And who cannot');

    /** Opens a raw socket and reports how the handshake ended. */
    const rawAttempt = (roomName, cookie) =>
      new Promise((resolve) => {
        const socket = new WebSocket(`${wsBase}/${roomName}`, {
          headers: cookie ? { Cookie: cookie } : {},
        });
        const done = (answer) => {
          try {
            socket.close();
          } catch {
            /* already gone */
          }
          resolve(answer);
        };
        socket.on('open', () => done({ opened: true }));
        socket.on('unexpected-response', (_req, res) => done({ status: res.statusCode }));
        socket.on('error', (error) => done({ error: error.message }));
        setTimeout(() => done({ timedOut: true }), 4000);
      });

    check(
      'no cookie is refused, and says so in the handshake',
      (await rawAttempt(room, null)).status === 401,
      JSON.stringify(await rawAttempt(room, null))
    );
    check(
      'somebody not on the engagement is refused',
      (await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(stranger)}`)).status === 403,
      JSON.stringify(await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(stranger)}`))
    );
    check(
      'a read-only account is refused, because a shared document has no read-only seat',
      (await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(readonly)}`)).status === 403,
      JSON.stringify(await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(readonly)}`))
    );
    check(
      'a room on somebody else’s engagement is refused even with a good cookie',
      (await rawAttempt(`${otherAuditId}/finding/${findingId}/description`, `${COLLAB_COOKIE}=${signCollabToken(alice)}`))
        .status === 403
    );
    /*
     * A cookie with a session in it, which is what a signed-in browser actually holds.
     *
     * Every check above mints a token without one, and a token without a session skips the
     * session check entirely — so the branch that looks a session up was never run here, and it
     * was wrong: it matched on `_id` where the model uses `sid`. Every real sign-in was refused
     * while this file reported thirteen passes.
     */
    const sid = `zz-collab-ws-${Date.now()}`;
    await Session.create({
      sid,
      user: alice._id,
      userAgent: 'collab socket test',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const withSession = await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(alice, sid)}`);
    check(
      'a cookie carrying a live session opens the room, as a signed-in browser does',
      withSession.opened === true,
      JSON.stringify(withSession)
    );

    await Session.updateOne({ sid }, { $set: { revokedAt: new Date() } });
    const revoked = await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(alice, sid)}`);
    check(
      'and signing that session out closes the door behind it',
      revoked.status === 401,
      JSON.stringify(revoked)
    );
    await Session.deleteOne({ sid });

    check(
      'and a room name that is not a field of anything is refused before any lookup',
      (await rawAttempt('not-a-room', `${COLLAB_COOKIE}=${signCollabToken(alice)}`)).status === 400
    );
    /*
     * Every shape the whitelist allows, and one it does not.
     *
     * The list is the security boundary as much as the auth is: a room is not "any path a client
     * asks for", and a field added to a finding next year is not shareable until somebody says so.
     */
    for (const shape of [
      `${auditId}/finding/${findingId}/title`,
      `${auditId}/finding/${findingId}/remediation`,
      `${auditId}/step/${findingId}/content`,
      `${auditId}/step/${findingId}/command`,
      `${auditId}/step/${findingId}/summary`,
    ]) {
      check(
        `a room is allowed for ${shape.split('/').slice(1).join('/')}`,
        (await rawAttempt(shape, `${COLLAB_COOKIE}=${signCollabToken(alice)}`)).opened === true
      );
    }

    for (const shape of [
      /* Tool output is a record of what a tool printed. Nobody edits it together. */
      `${auditId}/step/${findingId}/output`,
      /* A score is a vector, not prose, and it has its own control. */
      `${auditId}/finding/${findingId}/cvssv3`,
      /* A step with no field named at all. */
      `${auditId}/step/${findingId}`,
    ]) {
      check(
        `and refused for ${shape.split('/').slice(1).join('/')}`,
        (await rawAttempt(shape, `${COLLAB_COOKIE}=${signCollabToken(alice)}`)).status === 400
      );
    }
    /* ------------------------------------------------------- the switch --- */
    log.info('');
    log.info('And when an administrator switches it off');

    settingsRow.collab = { enabled: false };
    settingsRow.markModified('collab');
    await settingsRow.save();

    const offAttempt = await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(alice)}`);
    check(
      'a member with a good cookie is refused while sharing is switched off',
      offAttempt.status === 403,
      JSON.stringify(offAttempt)
    );

    settingsRow.collab = { enabled: true };
    settingsRow.markModified('collab');
    await settingsRow.save();
    const onAgain = await rawAttempt(room, `${COLLAB_COOKIE}=${signCollabToken(alice)}`);
    check(
      'and let back in the moment it is switched on, with nothing to restart',
      onAgain.opened === true,
      JSON.stringify(onAgain)
    );
  } finally {
    /* The instance goes back exactly as it was found, switch included. */
    settingsRow.collab = collabBefore;
    settingsRow.markModified('collab');
    await settingsRow.save();

    closeAllRooms();
    if (auditId) await Audit.deleteOne({ _id: auditId });
    if (otherAuditId) await Audit.deleteOne({ _id: otherAuditId });
    await User.deleteMany({ username: { $in: made } });
    await new Promise((resolve) => server.close(resolve));
    await disconnectDatabase();
  }

  log.info('');
  if (failed === 0) log.info(`RESULT: ${passed} checks passed`);
  else log.error(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
