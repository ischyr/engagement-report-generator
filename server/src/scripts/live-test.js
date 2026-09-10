/**
 * One request answers everything a signed-in browser asks for on a timer.
 *
 *   npm run test:live
 *
 * The client used to run four loops against three endpoints: a heartbeat, a presence roster, a
 * notification list, and a second roster read per open record. Something has to tell the server the
 * browser is still here, so the heartbeat is the request that cannot be removed — and it is now the
 * one that answers. This is the server half of that.
 *
 * The assertion that matters most is the last one: the merged answer and the endpoints it replaced
 * must agree. Two readers of "who is online" that disagree about the window would mean the roster
 * in the sidebar and the roster behind "somebody else is in this finding" are different rosters,
 * and the second one would be a lie told at the worst possible moment.
 *
 * Driven over a socket through `createApp()`, because what is being tested is the shape of a
 * response rather than the behaviour of a function.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { ONLINE_WINDOW_MS } from '../services/live.service.js';

process.env.VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-live-test-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { session, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
  await Settings.getSettings();

  const ines = await User.create({
    username: 'live-ines',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ines@example.invalid',
    password: 'LivePass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const marcus = await User.create({
    username: 'live-marcus',
    email: 'marcus@example.invalid',
    password: 'LivePass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });

  const session = signAccessToken(ines);
  const other = signAccessToken(marcus);

  await Notification.create({
    user: ines._id,
    type: 'mention',
    actor: marcus._id,
    message: 'Marcus mentioned you in a finding',
    href: '/engagements/x',
  });
  await Notification.create({
    user: ines._id,
    type: 'mention',
    actor: marcus._id,
    message: 'And again, in a note',
    href: '/engagements/x',
    read: true,
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nThe heartbeat answers with everything the timers used to ask for:');
  {
    const { status, body } = await call('POST', '/api/presence/heartbeat', {
      session,
      body: { activity: 'editing Northwind', location: 'finding:a:b' },
    });

    check('it succeeds', status === 200 && body?.ok === true, status);
    check('and says how long online lasts', body?.onlineWindowMs === ONLINE_WINDOW_MS, body?.onlineWindowMs);

    check('it carries the roster', Array.isArray(body?.users), typeof body?.users);
    /*
     * The caller must be in the roster it is handed. The update runs before the read for exactly
     * this reason: answering with a roster that does not contain the person who just announced
     * themselves would make the sidebar flicker them in a beat late, every time.
     */
    const me = (body.users ?? []).find((row) => row.isSelf);
    check('with the caller in it, marked as themselves', Boolean(me), JSON.stringify(body.users?.map((u) => u.username)));
    check('carrying what they said they were doing', me?.activity === 'editing Northwind', me?.activity);
    check('and where they said they were', me?.location === 'finding:a:b', me?.location);

    check('it carries the notifications', Array.isArray(body?.notifications?.items), typeof body?.notifications);
    check('with the unread count the badge shows', body.notifications.unread === 1, body.notifications.unread);
    check('and both items, read or not', body.notifications.items.length === 2, body.notifications.items.length);
    check(
      'the actor is resolved to a name, not left as an id',
      Boolean(body.notifications.items[0]?.actor?.username),
      JSON.stringify(body.notifications.items[0]?.actor)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nIt sees other people, and they see it:');
  {
    await call('POST', '/api/presence/heartbeat', {
      session: other,
      body: { activity: 'reading the scope', location: 'engagement:a:scope' },
    });
    const { body } = await call('POST', '/api/presence/heartbeat', { session, body: {} });

    check('two people are online', (body.users ?? []).length === 2, (body.users ?? []).length);
    const them = body.users.find((row) => !row.isSelf);
    check('the other one is not marked as self', them?.username === 'live-marcus', them?.username);
    check('and their activity travels', them?.activity === 'reading the scope', them?.activity);
    /* An empty body clears the caller's own place, which is how leaving a record works. */
    check('an empty beat clears where the caller was', body.users.find((r) => r.isSelf)?.location === '', JSON.stringify(body.users.find((r) => r.isSelf)));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the endpoints it replaced still agree with it:');
  {
    const beat = await call('POST', '/api/presence/heartbeat', { session, body: {} });
    const roster = await call('GET', '/api/presence', { session });
    const bar = await call('GET', '/api/notifications?limit=40', { session });

    /*
     * The drift assertion. `presenceRoster` and `notificationSummary` are shared, so this passes by
     * construction today — which is the point: if somebody later gives the heartbeat its own query
     * to make it cheaper, this fails and says so, rather than the sidebar and the "somebody else is
     * in this finding" banner quietly disagreeing about who is here.
     */
    const names = (list) => (list ?? []).map((row) => row.username).sort();
    check(
      'GET /presence returns the same people',
      JSON.stringify(names(roster.body?.users)) === JSON.stringify(names(beat.body?.users)),
      `${JSON.stringify(names(roster.body?.users))} vs ${JSON.stringify(names(beat.body?.users))}`
    );
    check(
      'and the same online window',
      roster.body?.onlineWindowMs === beat.body?.onlineWindowMs,
      `${roster.body?.onlineWindowMs} vs ${beat.body?.onlineWindowMs}`
    );
    check(
      'GET /notifications returns the same unread count',
      bar.body?.unread === beat.body?.notifications?.unread,
      `${bar.body?.unread} vs ${beat.body?.notifications?.unread}`
    );
    check(
      'and the same number of items',
      (bar.body?.items ?? []).length === beat.body?.notifications?.items.length,
      `${(bar.body?.items ?? []).length} vs ${beat.body?.notifications?.items.length}`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nGoing quiet still takes somebody off the list:');
  {
    /* Older than the window: the same thing as a browser that closed. */
    await User.updateOne(
      { _id: marcus._id },
      { $set: { lastSeenAt: new Date(Date.now() - ONLINE_WINDOW_MS - 5_000) } }
    );
    const { body } = await call('POST', '/api/presence/heartbeat', { session, body: {} });
    check('only the caller is left', (body.users ?? []).length === 1, (body.users ?? []).length);

    await call('POST', '/api/presence/leave', { session });
    const after = await call('GET', '/api/presence', { session });
    check('and leaving clears them at once', (after.body?.users ?? []).length === 0, (after.body?.users ?? []).length);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nIt is not a way in without a session:');
  {
    const anon = await call('POST', '/api/presence/heartbeat', { body: {} });
    check('no session is refused', anon.status === 401, anon.status);
    check('and nothing about anybody comes back', !anon.body?.users, JSON.stringify(anon.body)?.slice(0, 120));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
