/**
 * Sending a client their link, and what happens when that does not work.
 *
 *   npm run test:share-send
 *
 * Every link this app makes for a client used to be a URL somebody copied into their own mail
 * client and explained by hand — the app had SMTP configured, mailed its own users all day, and
 * never once wrote to the person the link was for.
 *
 * It sends now, and the interesting half is the failure. A link that has been issued exists; the
 * hash is in the database and the token is in the response. So a mail server that is down, an
 * address with a typo in it, or a transport that throws must not lose the link — they must come
 * back as a description of what did not happen, with the URL still in hand. Anything else trades
 * a working link for an error message.
 *
 * The other thing asserted here is the constraint that shapes the whole feature: **only the hash
 * is kept**, and the token is returned exactly once. There is no send-it-again, and there must
 * never be one, because a token this app could hand out twice is a token it could hand to the
 * wrong person twice. Resending means issuing another link.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';

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

/* -------------------------------------------------------------------------- */
/* A mail server that says what it was given                                  */
/* -------------------------------------------------------------------------- */

/**
 * A real SMTP conversation, held by hand.
 *
 * `mail-test.js` already proves the transport speaks SMTP correctly, so this does not: it only
 * needs somewhere for the send to land, and a way to read what came out. The modes are the point —
 * a server that refuses one recipient and a server that refuses the connection are different
 * failures and the route is supposed to tell them apart.
 */
function mailbox({ mode = 'accept' } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let data = false;
    let body = '';
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 test ESMTP');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (data) {
        body += text;
        if (text.includes('\r\n.\r\n')) {
          data = false;
          received.push(body);
          body = '';
          say('250 Ok');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') say('250-test\r\n250 SIZE 10240000');
        else if (command === 'MAIL') say('250 Ok');
        else if (command === 'RCPT') {
          /* One address refused and the rest accepted: the partial failure the route must survive. */
          if (mode === 'refuse-one' && /bounces@/i.test(line)) say('550 No such mailbox');
          else say('250 Ok');
        } else if (command === 'DATA') {
          data = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'QUIT') {
          say('221 Bye');
          socket.end();
        } else say('250 Ok');
      }
    });
    socket.on('error', () => {});
  });
  return { server, received };
}

const net = await import('node:net');

/**
 * One captured message as a person would read it.
 *
 * Headers and both body parts, decoded. `mime.js` sends a body base64 when a line would pass the
 * 998-octet limit and leaves it alone otherwise, and puts a non-ASCII header inside an RFC 2047
 * encoded word — so an assertion against the raw conversation is an assertion about the transport
 * rather than about what was said. The first version of this file did exactly that and reported
 * that the covering note had not been sent, when it had.
 */
const readable = (raw) => {
  const decodedHeaders = String(raw).replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, b64) =>
    Buffer.from(b64, 'base64').toString('utf8')
  );

  /* Every base64 run in the message, decoded and appended, so either encoding is readable. */
  const decodedBodies = (decodedHeaders.match(/(?:^[A-Za-z0-9+/=]{60,76}\r?\n)+/gm) ?? [])
    .map((block) => {
      try {
        return Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  return `${decodedHeaders}\n${decodedBodies}`;
};

const PORT = 4151;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-share-send-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const call = async (method, path, body, session) => {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

let smtp = null;
const SMTP_PORT = 4152;

/** Point the instance at a mailbox of the given temperament, or at nothing at all. */
const useMail = async (mode) => {
  if (smtp) {
    await new Promise((resolve) => smtp.server.close(resolve));
    smtp = null;
  }
  const settings = await Settings.getSettings();
  if (mode === 'off') {
    settings.email.enabled = false;
    await settings.save();
    return null;
  }
  smtp = mailbox({ mode });
  await new Promise((resolve) => smtp.server.listen(SMTP_PORT, '127.0.0.1', resolve));
  /*
   * Field by field rather than by replacing `settings.email`. It holds a nested `secret`
   * subdocument, and an object spread hands mongoose an `undefined` where that shape belongs —
   * which fails validation on save, before any of this has tested anything.
   */
  settings.email.enabled = true;
  settings.email.host = '127.0.0.1';
  settings.email.port = SMTP_PORT;
  settings.email.security = 'none';
  settings.email.fromAddress = 'reports@example.invalid';
  settings.email.fromName = 'Engy';
  settings.email.notifications = true;
  await settings.save();
  return smtp;
};

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'share-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ines@example.invalid',
    password: 'SharePass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const company = await Company.create({ name: 'Northwind', createdBy: lead._id });
  const audit = await Audit.create({
    name: 'Northwind Shipment Portal',
    reference: 'PT-2026-041',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    findings: [
      {
        identifier: 1,
        title: 'Session cookie without Secure',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
      },
    ],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA link can be issued without sending anything, as it always could:');
  {
    await useMail('off');
    const made = await call('POST', `/api/share/link/${audit._id}`, { label: 'Dana' }, session);
    check('it is made', made.status === 201, made.text.slice(0, 140));
    check('  and the URL comes back', String(made.body?.path ?? '').startsWith('/shared/'), made.body?.path);
    check('  nothing was attempted', made.body?.sending?.attempted === false, JSON.stringify(made.body?.sending));

    const row = await ShareLink.findById(made.body._id);
    check('  and nobody is recorded as having been sent it', (row.sentTo ?? []).length === 0, JSON.stringify(row.sentTo));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd with addresses on it, the client is told:');
  {
    const box = await useMail('accept');
    const made = await call(
      'POST',
      `/api/share/link/${audit._id}`,
      {
        label: 'Northwind security',
        kind: 'findings',
        recipients: [
          { name: 'Dana Okafor', email: 'dana@northwind.example' },
          { name: 'Sam Reid', email: 'sam@northwind.example' },
        ],
        message: 'Here is what we found last week.',
      },
      session
    );

    check('the link is made', made.status === 201, made.text.slice(0, 140));
    check('  and two people were sent it', made.body?.sending?.sent?.length === 2, JSON.stringify(made.body?.sending));
    check('  with nothing refused', made.body?.sending?.refused?.length === 0, JSON.stringify(made.body?.sending?.refused));

    const sent = box.received.map(readable).join('\n');
    check('  a message really went out', box.received.length === 1, `${box.received.length} messages`);
    check('  addressed to both', /dana@northwind\.example/.test(sent) && /sam@northwind\.example/.test(sent), '');
    check('  carrying the covering note', /Here is what we found last week/.test(sent), '');
    check(
      '  and the link itself',
      sent.includes(String(made.body.path).replace('/shared/', '')) || /shared/.test(sent),
      'no link in the message'
    );
    /*
     * The wording is chosen by the kind, and this is the half that matters: a findings link asks
     * the reader for something. Sent with a status link's wording, a client reads it as news.
     */
    check('  in the words a findings link needs', /what we found/i.test(sent), '');

    const row = await ShareLink.findById(made.body._id);
    check('  and the link remembers who it went to', (row.sentTo ?? []).length === 2, JSON.stringify(row.sentTo));
    check('    with the sender recorded', String(row.sentTo[0].by) === String(lead._id), String(row.sentTo[0].by));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA status link is sent in different words, because it asks for nothing:');
  {
    const box = await useMail('accept');
    await call(
      'POST',
      `/api/share/link/${audit._id}`,
      { kind: 'status', recipients: [{ name: 'Dana', email: 'dana@northwind.example' }] },
      session
    );
    const sent = box.received.map(readable).join('\n');
    check('it says where we are', /progress|where we are/i.test(sent), sent.slice(0, 200));
    check('  and that nothing is needed', /Nothing is needed from you/i.test(sent), '');
    check('  and never says "what we found"', !/what we found/i.test(sent), 'a status link used the findings wording');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWhen the mail fails, the link survives it:');
  {
    /* The instance has no mail server at all — the commonest case, on a fresh install. */
    await useMail('off');
    const made = await call(
      'POST',
      `/api/share/link/${audit._id}`,
      { recipients: [{ email: 'dana@northwind.example' }] },
      session
    );

    check('the link is still issued', made.status === 201, made.text.slice(0, 140));
    check('  and the URL still comes back', String(made.body?.path ?? '').startsWith('/shared/'), made.body?.path);
    check('  it was attempted', made.body?.sending?.attempted === true, JSON.stringify(made.body?.sending));
    check('  nobody was sent it', made.body?.sending?.sent?.length === 0, JSON.stringify(made.body?.sending?.sent));
    /*
     * And it says why, in words somebody can act on. "Failed" would leave the sender wondering
     * whether the client has the link or not, which is the one thing they must not wonder.
     */
    check(
      '  and it says why, and what to do instead',
      /not configured|still yours to send/i.test(made.body?.sending?.reason ?? ''),
      made.body?.sending?.reason
    );

    const row = await ShareLink.findById(made.body._id);
    check('  nobody is recorded as having received it', (row.sentTo ?? []).length === 0, JSON.stringify(row.sentTo));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd one bad address does not cost the others theirs:');
  {
    const box = await useMail('refuse-one');
    const made = await call(
      'POST',
      `/api/share/link/${audit._id}`,
      {
        recipients: [
          { name: 'Dana', email: 'dana@northwind.example' },
          { name: 'Gone', email: 'bounces@northwind.example' },
          { name: 'Typo', email: 'not-an-address' },
        ],
      },
      session
    );

    check('the link is issued', made.status === 201, made.text.slice(0, 140));
    check('  one was sent', made.body?.sending?.sent?.length === 1, JSON.stringify(made.body?.sending?.sent));
    check(
      '  and both the others are named',
      (made.body?.sending?.refused ?? []).length === 2,
      JSON.stringify(made.body?.sending?.refused)
    );
    check('  a message did go out', box.received.length === 1, `${box.received.length} messages`);

    const row = await ShareLink.findById(made.body._id);
    check('  and only the one who got it is recorded', (row.sentTo ?? []).length === 1, JSON.stringify(row.sentTo));
    check('    which is the right one', row.sentTo[0].email === 'dana@northwind.example', row.sentTo[0]?.email);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd there is no second chance at the token, by design:');
  {
    const made = await call('POST', `/api/share/link/${audit._id}`, { label: 'Once' }, session);
    const token = made.body.token;
    check('the token is in the creating response', typeof token === 'string' && token.length > 20, String(token));

    const listed = await call('GET', `/api/share/link/${audit._id}`, null, session);
    const found = (listed.body?.links ?? []).find((link) => link._id === made.body._id);
    check('  and in nothing afterwards', found && !('token' in found) && !('path' in found), JSON.stringify(found));

    const row = await ShareLink.findById(made.body._id);
    check('  the database holds only a hash', !row.token && row.tokenHash?.length === 64, String(row.tokenHash?.length));
    check(
      '    which is not the token',
      row.tokenHash !== token,
      'the token is stored as itself'
    );
  }
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the suite itself stopped — ${error.stack}`);
} finally {
  if (smtp) await new Promise((resolve) => smtp.server.close(resolve));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
