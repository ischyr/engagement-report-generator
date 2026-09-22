/**
 * What reaches somebody's bell, and what they have turned off.
 *
 *   npm run test:notify-prefs
 *
 * A preference is only a preference if every sender honours it, and there are twenty-one places in
 * this codebase that tell somebody something. The one that forgets is the one somebody adds next,
 * and the failure is silent in the worst direction: a switch that appears to work, on a kind of
 * notification that keeps arriving.
 *
 * So the load-bearing check here is not any single flow. It is that **nothing writes to the
 * collection except the funnel** — asserted against the source, because that is the only way to
 * catch a twenty-second site that does not exist yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken } from '../middleware/auth.js';
import { User } from '../models/user.model.js';
import { Notification, NOTIFICATION_TYPES } from '../models/notification.model.js';
import { notify, wants, isMutable, ALWAYS_ON } from '../services/notify.service.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ------------------------------------------------- nobody goes round the back --- */

console.log('Every sender goes through the funnel:');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      /* The suites themselves may write fixtures directly; they are not senders. */
      if (entry.name === 'scripts') continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    /* The funnel is the one file allowed to touch the collection this way. */
    if (full.endsWith(path.join('services', 'notify.service.js'))) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/Notification\.(create|insertMany)\s*\(/.test(text)) {
      offenders.push(path.relative(SRC, full).replaceAll('\\', '/'));
    }
  }
};
walk(SRC);

check(
  'nothing writes notifications except notify.service.js',
  offenders.length === 0,
  offenders.join(', ')
);

/* ----------------------------------------------------------------- the rule --- */

console.log('\nThe rule itself:');

check('an account that has never changed anything wants everything', wants({}, 'mention'));
check('and so does one with an empty preference map', wants({ notificationsOff: {} }, 'mention'));
check(
  'a type it turned off is not wanted',
  !wants({ notificationsOff: { mention: true } }, 'mention')
);
check(
  'turning one off leaves the others alone',
  wants({ notificationsOff: { mention: true } }, 'render-failed')
);
/* Hydrated documents carry a Map, `.lean()` ones carry an object, and both reach this. */
check(
  'a Map reads the same as a plain object',
  !wants({ notificationsOff: new Map([['mention', true]]) }, 'mention')
);
for (const type of ALWAYS_ON) {
  check(
    `  ${type} cannot be turned off, whatever is stored`,
    wants({ notificationsOff: { [type]: true } }, type)
  );
}
check(
  'every type is either mutable or on the short always-on list',
  NOTIFICATION_TYPES.every((type) => isMutable(type) || ALWAYS_ON.has(type))
);

/* -------------------------------------------------------------- end to end --- */

await connectDatabase();
const app = createApp();
const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener));
});
const origin = `http://127.0.0.1:${server.address().port}`;

const call = async (token, method, path_, body) => {
  const response = await fetch(`${origin}${path_}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
};

await User.deleteMany({ username: /^zz-prefs-/ });
const stamp = Date.now();
const person = await User.create({
  username: `zz-prefs-${stamp}`,
  email: `zz-prefs-${stamp}@example.test`,
  password: 'Testing-12345!',
  roles: ['user'],
  approvedAt: new Date(),
});
const token = signAccessToken(person);
const sent = () => Notification.countDocuments({ user: person._id });

console.log('\nWhat actually arrives:');

await notify({ user: person._id, type: 'mention', message: 'first' });
check('a notification arrives when nothing is switched off', (await sent()) === 1);

const turnedOff = await call(token, 'PUT', '/api/notifications/preferences/mention', { on: false });
check('a kind can be switched off', turnedOff.status === 200, String(turnedOff.status));

await notify({ user: person._id, type: 'mention', message: 'second' });
check('and then it does not arrive', (await sent()) === 1, 'it was sent anyway');

await notify({ user: person._id, type: 'render-failed', message: 'still wanted' });
check('while a kind that was left on still does', (await sent()) === 2);

/* Dropped, not stored-and-hidden: an unread count pointing at nothing is worse than silence. */
check(
  'a muted notification is not kept out of sight',
  (await Notification.countDocuments({ user: person._id, message: 'second' })) === 0
);

const backOn = await call(token, 'PUT', '/api/notifications/preferences/mention', { on: true });
check('and it can be switched back on', backOn.status === 200);
await notify({ user: person._id, type: 'mention', message: 'third' });
check('  after which it arrives again', (await sent()) === 3);

/*
 * A batch aimed at several people is filtered per person, not all-or-nothing — the case an
 * engagement with a team of five hits every time somebody asks a question of everybody.
 */
const other = await User.create({
  username: `zz-prefs-other-${stamp}`,
  email: `zz-prefs-other-${stamp}@example.test`,
  password: 'Testing-12345!',
  roles: ['user'],
  approvedAt: new Date(),
});
await call(token, 'PUT', '/api/notifications/preferences/booking-soon', { on: false });
const delivered = await notify([
  { user: person._id, type: 'booking-soon', message: 'batch' },
  { user: other._id, type: 'booking-soon', message: 'batch' },
]);
check('a batch is filtered per person', delivered === 1, String(delivered));
check(
  '  the one who muted it gets nothing',
  (await Notification.countDocuments({ user: person._id, type: 'booking-soon' })) === 0
);
check(
  '  and the one who did not gets it',
  (await Notification.countDocuments({ user: other._id, type: 'booking-soon' })) === 1
);

/* --------------------------------------------------------------- refusals --- */

console.log('\nWhat it refuses:');

for (const type of ALWAYS_ON) {
  check(
    `  ${type} cannot be switched off through the API either`,
    (await call(token, 'PUT', `/api/notifications/preferences/${type}`, { on: false })).status === 400
  );
}
check(
  'a kind that does not exist is a 404, not a stored preference nobody reads',
  (await call(token, 'PUT', '/api/notifications/preferences/invented', { on: false })).status === 404
);
check(
  'signed out, preferences are not readable',
  (await call(null, 'GET', '/api/notifications/preferences')).status === 401
);

/* -------------------------------------------------------------- the page --- */

console.log('\nWhat the settings page is given:');

const prefs = await call(token, 'GET', '/api/notifications/preferences');
check('it answers', prefs.status === 200);
const listed = (prefs.body?.groups ?? []).flatMap((group) => group.types.map((row) => row.type));
check(
  'every kind of notification is on it',
  NOTIFICATION_TYPES.every((type) => listed.includes(type)),
  NOTIFICATION_TYPES.filter((type) => !listed.includes(type)).join(', ')
);
check('and nothing is listed twice', new Set(listed).size === listed.length);
check('it reports nothing unlisted', (prefs.body?.unlisted ?? []).length === 0);
check(
  'the always-on ones are marked as locked rather than shown as switches',
  (prefs.body?.groups ?? [])
    .flatMap((group) => group.types)
    .filter((row) => ALWAYS_ON.has(row.type))
    .every((row) => row.locked === true)
);
check(
  'and a kind this account switched off reads as off',
  (prefs.body?.groups ?? [])
    .flatMap((group) => group.types)
    .find((row) => row.type === 'booking-soon')?.on === false
);
check(
  'every row has words a person can read',
  (prefs.body?.groups ?? []).every((group) => group.types.every((row) => row.label?.length > 5))
);

/* --------------------------------------------------------------- tidy up --- */

await Notification.deleteMany({ user: { $in: [person._id, other._id] } });
await User.deleteMany({ _id: { $in: [person._id, other._id] } });

server.close();
await disconnectDatabase();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
