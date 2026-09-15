/**
 * What a client can say when it is not about one finding — including on a report that is closed.
 *
 *   npm run test:client-ask
 *
 * Two routes, and the interesting one is the second.
 *
 * `POST /:token/question` is the general version of the per-finding question that already existed:
 * a maintenance window, a host being decommissioned, who to talk to about the retest. It follows
 * the same rules as its neighbour and the checks here mostly exist to prove that it does.
 *
 * `POST /:token/reopen` is the odd one. It is the only route in this file that works *because* the
 * report is closed — every other write refuses an approved engagement with "tell your contact and
 * they will reopen it", which sends the reader out of the app to find a human at the exact moment
 * they have found they need something. Three routes said that sentence and none offered a way.
 *
 * So it has two rules that look wrong until you see why:
 *
 *   - **It is not behind `allowUpdates`.** A read-only link says this reader may not change the
 *     report. Asking a person for something is not changing the report, and a reader who cannot
 *     even ask is a reader who telephones somebody instead.
 *   - **Asking twice leaves one entry.** There is no value in a queue of identical pleas, and the
 *     second attempt is answered rather than ignored.
 *
 * And the rule that does not bend: it never reopens anything. Reopening an approved report is a
 * decision with a signature behind it. This asks.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { issueShareLink } from '../services/share.service.js';

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

const PORT = 4153;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-client-ask-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const call = async (method, path, body) => {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'ask-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ask-lead@example.invalid',
    password: 'AskPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const company = await Company.create({ name: 'Northwind', createdBy: lead._id });

  const makeAudit = async (state) =>
    Audit.create({
      name: `Northwind Portal ${state}`,
      reference: `PT-${state}`,
      company: company._id,
      creator: lead._id,
      state,
      findings: [
        {
          identifier: 1,
          title: 'Session cookie without Secure',
          cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
          createdBy: lead._id,
        },
      ],
    });

  const linkFor = async (audit, options = {}) => {
    const { token } = await issueShareLink({ audit, label: 'Dana at Northwind', actor: lead, ...options });
    return token;
  };

  /* ------------------------------------------------------------------------ */
  console.log('\nA client can say something that is not about one finding:');
  {
    const audit = await makeAudit('EDIT');
    const token = await linkFor(audit);

    const asked = await call('POST', `/api/share/${token}/question`, {
      text: 'We have a change freeze from the 12th — does that affect the retest?',
    });
    check('it is taken', asked.status === 201, asked.text.slice(0, 140));

    const after = await Audit.findById(audit._id);
    const question = (after.questions ?? []).at(-1);
    check('  and lands in the questions', Boolean(question), 'nothing was recorded');
    check('  marked as the client’s', question?.fromClient === 'Dana at Northwind', question?.fromClient);
    /*
     * Empty rather than an id: the model documents `context` as free text naming what the question
     * is about, and nothing is the honest value for one about the engagement itself.
     */
    check('  with no finding attached', question?.context === '', JSON.stringify(question?.context));
    check('  open, and not printed', question?.status === 'open' && question?.print === false, '');
    check('  and nobody with an account is credited', question?.askedBy === null, String(question?.askedBy));

    const told = await Notification.find({ audit: audit._id });
    check('  the team is told', told.length === 1, `${told.length} notifications`);
    check('    and sent to the conversation', /tab=questions/.test(told[0]?.href ?? ''), told[0]?.href);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the same rules as the question beside it:');
  {
    const audit = await makeAudit('EDIT');
    const readOnly = await linkFor(audit, { allowUpdates: false });
    const refused = await call('POST', `/api/share/${readOnly}/question`, { text: 'Anything at all' });
    check('a read-only link cannot ask', refused.status === 403, String(refused.status));

    const status = await linkFor(audit, { kind: 'status' });
    const nope = await call('POST', `/api/share/${status}/question`, { text: 'Anything at all' });
    check('  and a progress link cannot either', nope.status === 403, String(nope.status));

    const short = await call('POST', `/api/share/${await linkFor(audit)}/question`, { text: 'no' });
    check('  and two characters is not a question', short.status === 422, String(short.status));

    const gone = await call('POST', '/api/share/not-a-real-token-at-all-here/question', { text: 'Hello?' });
    check('  and a token nobody issued is not found', gone.status === 404, String(gone.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA closed report can be asked about, which is the whole point:');
  {
    const audit = await makeAudit('APPROVED');
    const token = await linkFor(audit);

    /* The state of things before: every ordinary write is refused, and says so. */
    const question = await call('POST', `/api/share/${token}/question`, { text: 'Can we talk?' });
    check('an ordinary question is still refused', question.status === 403, String(question.status));
    check(
      '  and now says how to ask rather than "find a human"',
      /reopen/i.test(question.body?.error ?? ''),
      question.body?.error
    );

    const asked = await call('POST', `/api/share/${token}/reopen`, {
      reason: 'We fixed two of these last week.',
    });
    check('and reopening can be asked for', asked.status === 201, asked.text.slice(0, 140));

    const after = await Audit.findById(audit._id);
    const entry = (after.questions ?? []).find((row) => row.context === 'reopen');
    check('  it lands as a question the team will see', Boolean(entry), 'nothing was recorded');
    check('  named so the team can tell what kind of ask it is', entry?.context === 'reopen', entry?.context);
    check('  carrying their reason', /fixed two of these/.test(entry?.text ?? ''), entry?.text);
    check('  and the client’s name', /Dana at Northwind/.test(entry?.text ?? ''), entry?.text);

    /*
     * The rule that does not bend. Reopening is a decision with a signature behind it; this is the
     * request and nothing more, and a route that quietly moved the state would be the worst kind
     * of helpful.
     */
    check('  and the report is still closed', after.state === 'APPROVED', after.state);

    const told = await Notification.find({ audit: audit._id });
    check('  the team is told', told.length === 1, `${told.length} notifications`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAsking twice is still one request:');
  {
    const audit = await makeAudit('APPROVED');
    const token = await linkFor(audit);

    await call('POST', `/api/share/${token}/reopen`, { reason: 'Once' });
    const again = await call('POST', `/api/share/${token}/reopen`, { reason: 'Twice' });

    check('the second is answered, not refused', again.status === 200, String(again.status));
    check('  and says it has already been asked', again.body?.alreadyAsked === true, JSON.stringify(again.body));

    const after = await Audit.findById(audit._id);
    const entries = (after.questions ?? []).filter((row) => row.context === 'reopen');
    check('  leaving one entry rather than a queue', entries.length === 1, `${entries.length} entries`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd a reader who may not change anything may still ask:');
  {
    const audit = await makeAudit('APPROVED');
    /*
     * Deliberately not behind `allowUpdates`. A read-only link says this reader looks and does not
     * touch the report — asking a person for something is not touching the report, and a reader
     * who cannot even ask telephones somebody instead.
     */
    const token = await linkFor(audit, { allowUpdates: false });
    const asked = await call('POST', `/api/share/${token}/reopen`, {});
    check('a read-only link can ask for it back', asked.status === 201, asked.text.slice(0, 140));

    const status = await linkFor(audit, { kind: 'status' });
    const nope = await call('POST', `/api/share/${status}/reopen`, {});
    check('  but a progress link still cannot', nope.status === 403, String(nope.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd asking to reopen something already open is not an error:');
  {
    const audit = await makeAudit('EDIT');
    const token = await linkFor(audit);
    const asked = await call('POST', `/api/share/${token}/reopen`, {});
    check('it says so plainly', asked.status === 200 && asked.body?.alreadyOpen === true, asked.text.slice(0, 120));

    const after = await Audit.findById(audit._id);
    check('  and records nothing', (after.questions ?? []).length === 0, `${after.questions?.length} questions`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the client never sees the team’s own questions:');
  {
    const audit = await makeAudit('EDIT');
    /*
     * The wall this file shares with `client-question-test`: the questions array holds what the
     * team asked *about* this client, in words meant for colleagues. A general question route that
     * read the array back would be a new way through that wall, so a team question is planted here
     * to prove the reading path has not grown one.
     */
    audit.questions.push({ text: 'Do they know their old backup admin account is still enabled?', status: 'open' });
    await audit.save();

    const token = await linkFor(audit);
    const seen = await call('GET', `/api/share/${token}`);
    check('the page loads', seen.status === 200, String(seen.status));
    check(
      '  and none of it is in what the client is sent',
      !seen.text.includes('backup admin account'),
      'the team’s own question reached the client'
    );
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
