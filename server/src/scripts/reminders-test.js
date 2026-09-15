/**
 * Chasing a client, and the far longer list of reasons not to.
 *
 *   npm run test:reminders
 *
 * This is the only thing in the application that sends mail to somebody outside the firm without
 * a person deciding to at that moment. Everything else the client receives is the consequence of
 * somebody pressing a button; this arrives on a timer, days later, to an address the app kept.
 *
 * So the useful assertions are not "it sends". They are the nine ways it declines to, each of
 * which is a client who does *not* get an email they would have been entitled to resent — a link
 * that was withdrawn, a report since signed off, everything already claimed, a read-only reader
 * who could not act on it anyway. A sweep that chased any of those would be worse than a sweep
 * that never ran, and none of them would produce an error anywhere.
 *
 * The cap has a check of its own for the same reason. A fortnightly chase over a six-month link is
 * thirteen emails, which is not a reminder, and the client who ignored the fifth was not going to
 * answer the ninth.
 *
 * `reminderDue` is exported and tested directly rather than through the sweep, because "why not"
 * is the interesting half and a sweep can only say how many it skipped.
 */
import crypto from 'node:crypto';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { User } from '../models/user.model.js';
import { issueShareLink } from '../services/share.service.js';
import {
  REMINDER_LIMIT,
  outstandingOf,
  reminderDue,
  remindOutstandingFindings,
} from '../services/remediation-reminders.service.js';

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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-reminders-${Date.now()}`);

/* -------------------------------------------------------------------------- */
/* A mailbox, so "it sent" can mean something                                 */
/* -------------------------------------------------------------------------- */

const net = await import('node:net');
const received = [];
const smtp = net.createServer((socket) => {
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
      else if (command === 'DATA') {
        data = true;
        say('354 Go ahead');
      } else if (command === 'QUIT') {
        say('221 Bye');
        socket.end();
      } else say('250 Ok');
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => smtp.listen(4154, '127.0.0.1', resolve));

/**
 * One captured message as a person would read it.
 *
 * Headers out of their RFC 2047 encoded words, and every base64 run decoded — `mime.js` sends a
 * body base64 once a line would pass 998 octets. Without this, an assertion that the message does
 * *not* contain something passes whatever the message says, which is how a check meant to keep
 * finding titles out of client mail becomes a check of nothing at all.
 */
const readable = (raw) => {
  const headers = String(raw).replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, b64) =>
    Buffer.from(b64, 'base64').toString('utf8')
  );
  const bodies = (headers.match(/(?:^[A-Za-z0-9+/=]{60,76}\r?\n)+/gm) ?? [])
    .map((block) => {
      try {
        return Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  return `${headers}\n${bodies}`;
};

const DAY = 86_400_000;
const later = (days) => new Date(Date.now() + days * DAY);

try {
  const settings = await Settings.getSettings();
  settings.email.enabled = true;
  settings.email.host = '127.0.0.1';
  settings.email.port = 4154;
  settings.email.security = 'none';
  settings.email.fromAddress = 'reports@example.invalid';
  settings.email.fromName = 'Engy';
  await settings.save();

  const lead = await User.create({
    username: 'rem-lead',
    email: 'rem-lead@example.invalid',
    password: 'RemindPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const company = await Company.create({ name: 'Northwind', createdBy: lead._id });

  /** An engagement with two findings, neither claimed. */
  const makeAudit = async (state = 'EDIT', claims = ['', '']) =>
    Audit.create({
      name: 'Northwind Portal',
      reference: `PT-${Math.random().toString(36).slice(2, 7)}`,
      company: company._id,
      creator: lead._id,
      state,
      findings: claims.map((claim, index) => ({
        identifier: index + 1,
        title: `Finding ${index + 1}`,
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
        ...(claim ? { clientClaim: { status: claim, at: new Date(), by: 'Dana', note: '', media: [] } } : {}),
      })),
    });

  /** A link that was sent, and asked to chase — the only shape that is ever due. */
  const makeLink = async (audit, options = {}) => {
    const { link } = await issueShareLink({ audit, label: 'Dana', actor: lead, ...options });
    link.reminder.everyDays = options.everyDays ?? 14;
    if (options.sent !== false) {
      link.sentTo.push({ name: 'Dana', email: 'dana@northwind.example', at: later(-20), by: lead._id });
    }
    await link.save();
    return link;
  };

  /* ------------------------------------------------------------------------ */
  console.log('\nWhat is outstanding is what the client has not claimed:');
  {
    const audit = await makeAudit('EDIT', ['', 'fixed']);
    const counts = outstandingOf(audit);
    check('two findings', counts.total === 2, String(counts.total));
    check('  one claimed', counts.fixed === 1, String(counts.fixed));
    check('  one still open', counts.open === 1, String(counts.open));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA link that was sent, asked to chase, and has something to chase, is due:');
  {
    const audit = await makeAudit();
    const link = await makeLink(audit);
    const verdict = reminderDue(link, audit);
    check('it is due', verdict.due === true, verdict.why);
    check('  and knows how many are open', verdict.outstanding === 2, String(verdict.outstanding));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd every one of these is a client who is not written to:');
  {
    const audit = await makeAudit();

    const cases = [
      [
        'nobody asked for reminders',
        async () => {
          const link = await makeLink(audit, { everyDays: 0 });
          return [link, audit];
        },
        /nobody asked/i,
      ],
      [
        'the link was withdrawn',
        async () => {
          const link = await makeLink(audit);
          link.revokedAt = new Date();
          return [link, audit];
        },
        /withdrawn/i,
      ],
      [
        'the link has expired',
        async () => {
          const link = await makeLink(audit);
          link.expiresAt = later(-1);
          return [link, audit];
        },
        /expired/i,
      ],
      [
        'it is a progress link, which has nothing to chase',
        async () => {
          const link = await makeLink(audit, { kind: 'status' });
          return [link, audit];
        },
        /progress link/i,
      ],
      [
        'the reader cannot act on it',
        async () => {
          const link = await makeLink(audit, { allowUpdates: false });
          return [link, audit];
        },
        /read-only/i,
      ],
      [
        'nobody was sent it from here, so there is no address',
        async () => {
          const link = await makeLink(audit, { sent: false });
          return [link, audit];
        },
        /nobody was sent/i,
      ],
      [
        'it has been chased enough',
        async () => {
          const link = await makeLink(audit);
          link.reminder.sent = REMINDER_LIMIT;
          return [link, audit];
        },
        /chased enough/i,
      ],
      [
        'the report is closed, so there is nothing they could do',
        async () => {
          const closed = await makeAudit('APPROVED');
          const link = await makeLink(closed);
          return [link, closed];
        },
        /closed/i,
      ],
      [
        'everything has been claimed fixed',
        async () => {
          const done = await makeAudit('EDIT', ['fixed', 'fixed']);
          const link = await makeLink(done);
          return [link, done];
        },
        /claimed fixed/i,
      ],
      [
        'it is not due yet',
        async () => {
          const link = await makeLink(audit);
          link.reminder.lastAt = later(-1);
          return [link, audit];
        },
        /not due yet/i,
      ],
    ];

    for (const [why, build, pattern] of cases) {
      const [link, subject] = await build();
      const verdict = reminderDue(link, subject);
      check(why, verdict.due === false && pattern.test(verdict.why), `${verdict.due} — ${verdict.why}`);
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe clock runs from the send, not from the making:');
  {
    const audit = await makeAudit();
    const link = await makeLink(audit);
    /*
     * A link made on Monday and sent on Thursday should be chased a fortnight after Thursday. The
     * only honest starting point is whoever was written to last.
     */
    link.sentTo[0].at = later(-3);
    link.reminder.everyDays = 14;
    check('three days after the send it is not due', reminderDue(link, audit).due === false, '');

    link.sentTo[0].at = later(-20);
    check('  twenty days after it is', reminderDue(link, audit).due === true, reminderDue(link, audit).why);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe sweep sends, and does not send twice:');
  {
    await ShareLink.deleteMany({});
    received.length = 0;

    const audit = await makeAudit();
    const link = await makeLink(audit);

    const first = await remindOutstandingFindings();
    check('one chase went out', first.sent === 1, JSON.stringify(first));
    check('  and a message really arrived', received.length === 1, `${received.length} messages`);

    const again = await remindOutstandingFindings();
    check('running it again sends nothing', again.sent === 0, JSON.stringify(again));
    check('  and no second message', received.length === 1, `${received.length} messages`);

    const after = await ShareLink.findById(link._id);
    check('  the link recorded it', after.reminder.sent === 1, String(after.reminder.sent));
    check('  and when', Boolean(after.reminder.lastAt), String(after.reminder.lastAt));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd it stops, rather than going on forever:');
  {
    await ShareLink.deleteMany({});
    received.length = 0;

    const audit = await makeAudit();
    /*
     * Six months, so the cap is what stops this rather than the expiry. A thirty-day link — the
     * default — runs out after the third chase when the clock is walked forward a fortnight at a
     * time, which is correct behaviour and would have been a misleading way to test the cap.
     */
    const link = await makeLink(audit, { days: 180 });

    /* Fourteen days on each time, so the cap is what stops it rather than the cadence. */
    for (let round = 0; round < REMINDER_LIMIT + 3; round += 1) {
      await remindOutstandingFindings({ now: later(round * 14 + 1) });
    }

    check(
      `it sent ${REMINDER_LIMIT} and stopped`,
      received.length === REMINDER_LIMIT,
      `${received.length} messages`
    );
    const after = await ShareLink.findById(link._id);
    check('  and says so on the link', after.reminder.sent === REMINDER_LIMIT, String(after.reminder.sent));

    /* The last one says it is the last one, which is the difference between a reminder and pressure. */
    const last = readable(received.at(-1) ?? '');
    check('  the final message says it is the last', /last of these/i.test(last), last.slice(-300));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd it never names what was found:');
  {
    /*
     * An email is forwarded, quoted and left in mailboxes. A subject line naming three criticals
     * at a named client is the kind of thing that ends up somewhere it should not, so the mail
     * carries a count and the page behind the link carries everything else.
     */
    const message = readable(received.at(-1) ?? '');
    /* Decoded, or these would pass against a base64 body they could never have matched. */
    check('the message was read, not just the envelope', /still open|marked as fixed/i.test(message), message.slice(0, 200));
    check('  no finding titles', !/Finding 1|Finding 2/.test(message), 'a title reached the mail');
    check('  no severities', !/critical|high|medium/i.test(message), 'a severity reached the mail');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd an instance with no mail server chases nobody:');
  {
    await ShareLink.deleteMany({});
    received.length = 0;
    const off = await Settings.getSettings();
    off.email.enabled = false;
    await off.save();

    const audit = await makeAudit();
    await makeLink(audit);
    const result = await remindOutstandingFindings();
    check('nothing is sent', result.sent === 0, JSON.stringify(result));
    check('  and it is not an error', received.length === 0, `${received.length} messages`);
  }
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the suite itself stopped — ${error.stack}`);
} finally {
  await new Promise((resolve) => smtp.close(resolve));
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
