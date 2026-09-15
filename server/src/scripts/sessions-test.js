/**
 * Where an account is signed in, who may see that, and what signing one out actually does.
 *
 *   npm run test:sessions
 *
 * The feature was already built — model, routes, and a card on the profile page. What it did not
 * have was anything asserting the promises its own comments make, and they are promises about
 * access rather than about convenience:
 *
 *   - *"Own sessions only — there is no route to read anybody else's, including for an admin."*
 *   - *"The sid itself is never published: it is the thing the cookie proves."*
 *   - *"Everywhere but here. Deliberately not a `tokenVersion` bump."*
 *   - *"This is where signing a session out actually takes effect."*
 *
 * Each of those is one clause away from being untrue, and none of them fails loudly when it
 * breaks. A `findOne` that loses its `user:` scope still returns a session and the page still
 * works; it just belongs to somebody else. A revoked session whose refresh is no longer checked
 * still *looks* signed out in the list while the browser holding it carries on indefinitely. That
 * is the kind of fault that is found by a customer or by nobody.
 *
 * So this signs in as real people, over real cookies, and tries the things that must not work.
 *
 * The one genuinely subtle property is the last section's. Signing a session out does not stop the
 * access token that browser already holds — it cannot, the token is a signature and nothing is
 * asked about it until it expires — so "signed out" means "the next refresh is refused". The route
 * says so in a comment; the test is what keeps it true.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Session } from '../models/session.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';

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

const PORT = 4141;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-sessions-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/**
 * One browser, with its own cookie jar.
 *
 * A jar rather than a single header because this is the whole subject: the refresh cookie is what
 * distinguishes one signed-in browser from another, and a test that shared one between two
 * "people" would be testing nothing at all.
 */
function browser(label) {
  const jar = new Map();
  return {
    label,
    accessToken: null,
    get cookieHeader() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    /** The raw Set-Cookie lines from the last response, so the header itself can be asserted. */
    lastSetCookie: [],
    keep(response) {
      this.lastSetCookie = response.headers.getSetCookie?.() ?? [];
      for (const line of this.lastSetCookie) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        /* An expired cookie is a cleared one — which is itself a thing worth observing. */
        if (!value || /Expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    },
    has(name) {
      return jar.has(name);
    },
  };
}

const call = async (who, method, path, body) => {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(who?.accessToken ? { Authorization: `Bearer ${who.accessToken}` } : {}),
      ...(who?.cookieHeader ? { Cookie: who.cookieHeader } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  who?.keep(response);
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

const PASSWORD = 'SessionPass123!';

/** Sign in, keeping the cookies and the access token the way the app does. */
const signIn = async (who, username) => {
  const result = await call(who, 'POST', '/api/auth/login', { username, password: PASSWORD });
  if (result.status !== 200) throw new Error(`${username} could not sign in: ${result.text}`);
  who.accessToken = result.body.accessToken;
  return result;
};

try {
  await Settings.getSettings();

  const make = async (username, role = 'user') =>
    User.create({
      username,
      email: `${username}@example.invalid`,
      password: PASSWORD,
      role,
      roles: [role],
      enabled: true,
      approvedAt: new Date(),
    });

  const ines = await make('sess-ines');
  await make('sess-dana');
  await make('sess-admin', 'admin');

  /* ------------------------------------------------------------------------ */
  console.log('\nSigning in puts a browser on the list:');
  const laptop = browser('laptop');
  {
    await signIn(laptop, 'sess-ines');
    check('the refresh cookie is set', laptop.has('engy_refresh'), 'no cookie');

    const { body } = await call(laptop, 'GET', '/api/auth/sessions');
    check('one session is listed', (body?.sessions ?? []).length === 1, JSON.stringify(body));
    check('  and it knows it is this one', body.sessions[0]?.current === true, 'not marked current');
    check(
      '  it says what the device is',
      typeof body.sessions[0]?.device === 'string' && body.sessions[0].device.length > 0,
      body.sessions[0]?.device
    );

    /*
     * The sid is the thing the cookie proves. Publishing it would turn a page anybody's own
     * browser can open into a place a session identifier can be read out of.
     */
    check(
      '  and never publishes the sid',
      !JSON.stringify(body).includes('sid') && !('sid' in (body.sessions[0] ?? {})),
      JSON.stringify(body.sessions[0])
    );

    const stored = await Session.findOne({ user: ines._id });
    check(
      '  the row exists and is not revoked',
      Boolean(stored) && stored.revokedAt === null,
      String(stored?.revokedAt)
    );
    check(
      '  and the sid on the row is not the id the page was given',
      stored.sid !== body.sessions[0].id,
      'the sid is being handed out as the id'
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA second browser is a second session, not a replacement:');
  const phone = browser('phone');
  {
    await signIn(phone, 'sess-ines');
    const { body } = await call(laptop, 'GET', '/api/auth/sessions');
    check('both are listed', (body?.sessions ?? []).length === 2, String(body?.sessions?.length));
    check(
      '  exactly one of them is the one asking',
      body.sessions.filter((session) => session.current).length === 1,
      JSON.stringify(body.sessions.map((s) => s.current))
    );

    const fromPhone = await call(phone, 'GET', '/api/auth/sessions');
    check(
      '  and each browser sees itself as the current one',
      fromPhone.body.sessions.find((s) => s.current)?.id !==
        body.sessions.find((s) => s.current)?.id,
      'both browsers think they are the same session'
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThey are one account’s, and an admin is not an exception:');
  {
    const dana = browser('dana');
    await signIn(dana, 'sess-dana');
    const boss = browser('admin');
    await signIn(boss, 'sess-admin');

    const theirs = await call(dana, 'GET', '/api/auth/sessions');
    check(
      'somebody else sees only their own',
      (theirs.body?.sessions ?? []).length === 1,
      String(theirs.body?.sessions?.length)
    );

    const mine = await call(laptop, 'GET', '/api/auth/sessions');
    const id = mine.body.sessions[0].id;

    const stolen = await call(dana, 'DELETE', `/api/auth/sessions/${id}`);
    check('and cannot sign one of mine out', stolen.status === 404, String(stolen.status));

    /*
     * The comment on the route is explicit that this is not an administrative power: an admin who
     * needs somebody out disables the account or resets the password, both of which end every
     * session at once and are visible as what they are.
     */
    const asAdmin = await call(boss, 'GET', '/api/auth/sessions');
    check(
      'an admin sees their own sessions, not everybody’s',
      (asAdmin.body?.sessions ?? []).length === 1,
      String(asAdmin.body?.sessions?.length)
    );
    const adminDelete = await call(boss, 'DELETE', `/api/auth/sessions/${id}`);
    check('  and cannot sign somebody else’s out either', adminDelete.status === 404, String(adminDelete.status));

    const survived = await call(laptop, 'GET', '/api/auth/sessions');
    check(
      '  so mine are all still there',
      (survived.body?.sessions ?? []).length === 2,
      String(survived.body?.sessions?.length)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nSigning a session out is what refuses its next refresh:');
  {
    const listed = await call(laptop, 'GET', '/api/auth/sessions');
    const other = listed.body.sessions.find((session) => !session.current);

    /* The phone can still refresh, which is the before half of the assertion. */
    const before = await call(phone, 'POST', '/api/auth/refresh');
    check('the other browser can refresh while it is live', before.status === 200, String(before.status));

    const ended = await call(laptop, 'DELETE', `/api/auth/sessions/${other.id}`);
    check('it can be signed out from here', ended.status === 200, ended.text.slice(0, 120));
    check('  and that was not this browser', ended.body?.current === false, String(ended.body?.current));

    /*
     * The property the whole feature rests on. Not "it disappears from a list" — a list is a
     * display. The session is out when the browser holding it can no longer trade its refresh
     * cookie for a new access token.
     */
    const after = await call(phone, 'POST', '/api/auth/refresh');
    check('the browser that was signed out cannot refresh', after.status === 401, String(after.status));
    check(
      '  and is told what happened rather than "expired"',
      /signed out/i.test(after.body?.error ?? ''),
      after.body?.error
    );
    check('  and its refresh cookie is cleared', !phone.has('engy_refresh'), 'the cookie is still set');

    /*
     * Cleared, not merely emptied — which is a distinction this found the hard way.
     *
     * `res.clearCookie(name, options)` sets `expires` to the epoch and then merges the options
     * over the top, so the `maxAge` in the cookie builders won: every sign-out emitted
     * `engy_refresh=; Max-Age=604800`, keeping a valueless cookie in the browser for another
     * week instead of removing it. Nobody stayed signed in, because the value was gone — but
     * Express 5 ignores `maxAge` here, so the behaviour would have changed on upgrade, and a
     * cookie that is supposed to be deleted should be deleted.
     */
    const cleared = phone.lastSetCookie.find((line) => line.startsWith('engy_refresh='));
    check(
      '  and cleared rather than emptied for another week',
      Boolean(cleared) && !/Max-Age=(?!0\b)\d/.test(cleared),
      cleared
    );

    const left = await call(laptop, 'GET', '/api/auth/sessions');
    check('  and it is off the list', (left.body?.sessions ?? []).length === 1, String(left.body?.sessions?.length));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nEverywhere but here:');
  {
    /* Three more browsers, so "the others" is a number rather than a single case. */
    const extras = [];
    for (const name of ['tablet', 'desk', 'spare']) {
      const b = browser(name);
      await signIn(b, 'sess-ines');
      extras.push(b);
    }

    const before = await call(laptop, 'GET', '/api/auth/sessions');
    check('there are four', (before.body?.sessions ?? []).length === 4, String(before.body?.sessions?.length));

    const result = await call(laptop, 'POST', '/api/auth/sessions/revoke-others');
    check('the others are signed out', result.body?.revoked === 3, JSON.stringify(result.body));

    const after = await call(laptop, 'GET', '/api/auth/sessions');
    check('  leaving this one', (after.body?.sessions ?? []).length === 1, String(after.body?.sessions?.length));
    check('  which is still the current one', after.body.sessions[0]?.current === true, 'not current');

    /*
     * And it is not a `tokenVersion` bump, which is the all-or-nothing control this exists to be
     * an alternative to. If it were, the browser that asked would have signed itself out.
     */
    const stillHere = await call(laptop, 'GET', '/api/auth/me');
    check('  and the browser that asked is still signed in', stillHere.status === 200, String(stillHere.status));
    const refreshed = await call(laptop, 'POST', '/api/auth/refresh');
    check('  and can still refresh', refreshed.status === 200, String(refreshed.status));

    const stillIn = [];
    for (const extra of extras) {
      const gone = await call(extra, 'POST', '/api/auth/refresh');
      if (gone.status !== 401) stillIn.push(`${extra.label} (${gone.status})`);
    }
    check(
      `  and all ${extras.length} of them are refused on their next refresh`,
      stillIn.length === 0,
      `still signed in: ${stillIn.join(', ')}`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the rejected attempts are the account’s own to read and clear:');
  {
    const wrong = browser('guesser');
    for (let i = 0; i < 2; i += 1) {
      await call(wrong, 'POST', '/api/auth/login', {
        username: 'sess-ines',
        password: 'NotThePassword1!',
      });
    }

    const { body } = await call(laptop, 'GET', '/api/auth/sessions');
    check('failed attempts are listed', (body?.failedLogins ?? []).length === 2, String(body?.failedLogins?.length));

    const cleared = await call(laptop, 'DELETE', '/api/auth/failed-logins');
    check('  and can be cleared', cleared.status === 200, String(cleared.status));
    const empty = await call(laptop, 'GET', '/api/auth/sessions');
    check('  which empties the list', (empty.body?.failedLogins ?? []).length === 0, JSON.stringify(empty.body?.failedLogins));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd none of it is reachable without signing in:');
  {
    const nobody = browser('nobody');
    const list = await call(nobody, 'GET', '/api/auth/sessions');
    check('the list needs an account', list.status === 401, String(list.status));
    const revoke = await call(nobody, 'POST', '/api/auth/sessions/revoke-others');
    check('  and so does signing the others out', revoke.status === 401, String(revoke.status));
  }
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the suite itself stopped — ${error.stack}`);
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
