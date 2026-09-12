/**
 * The queue of everything a client has said and nobody has dealt with.
 *
 *   npm run test:verification
 *
 * Two things reach a team from outside it — a claim that a finding is fixed, and a question about
 * one — and both used to live only inside the engagement they arrived in. `GET /verification`
 * gathers them across every engagement somebody can see.
 *
 * A page that crosses every engagement is a page that can leak one, so most of this file is about
 * the edges rather than the happy path:
 *
 *   - an engagement this person is not on must not appear, however much is waiting on it
 *   - a question the *team* asked the client is not a question from the client, and the queue is
 *     the wrong place for it
 *   - a question already answered, and a claim already checked, are not waiting on anybody
 *   - archived engagements are out; approved ones are deliberately in, because a link refuses new
 *     claims once a report is closed, so anything still there arrived before it and is exactly the
 *     thing that would otherwise be lost
 *
 * And the loop that makes it a queue rather than a report: verifying a claim through the route the
 * Retest tab uses clears the claim, and answering a question settles it — so both rows leave.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
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

const PORT = 4134;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-verification-${Date.now()}`);
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

const days = (n) => new Date(Date.now() - n * 86400000);

/** Prose that must never be on a queue's wire: the list draws none of it. */
const PROSE = '<p>The parameter is reflected without encoding, and here is the whole write-up.</p>';

const finding = (title, extra = {}) => ({
  title,
  cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
  description: PROSE,
  observation: PROSE,
  remediation: PROSE,
  poc: PROSE,
  remediationStatus: 'open',
  ...extra,
});

try {
  await Settings.getSettings();

  const mine = await User.create({
    username: 'ver-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ver-lead@example.invalid',
    password: 'VerifyPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const other = await User.create({
    username: 'ver-stranger',
    firstname: 'Marijke',
    lastname: 'de Vries',
    email: 'ver-stranger@example.invalid',
    password: 'VerifyPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(mine);
  const strangerSession = signAccessToken(other);
  const company = await Company.create({ name: 'Northwind', createdBy: mine._id });

  /* The engagement everything below happens on. */
  const audit = await Audit.create({
    name: 'Northwind Shipment Portal',
    reference: 'PT-2026-041',
    company: company._id,
    creator: mine._id,
    language: 'en',
    findings: [
      /* Claimed fixed nine days ago — the oldest thing in the queue. */
      finding('Session cookie without Secure', {
        clientClaim: {
          status: 'fixed',
          at: days(9),
          by: 'Dana at Northwind',
          note: 'Moved it behind the session check and deployed on Tuesday.',
          media: ['65aaaaaaaaaaaaaaaaaaaaa1'],
        },
      }),
      /* Claimed fixed two days ago. */
      finding('Directory listing enabled', {
        clientClaim: { status: 'fixed', at: days(2), by: 'Dana at Northwind', note: '', media: [] },
      }),
      /* The client says this one is still open — a statement, not a retest. */
      finding('Verbose error messages', {
        clientClaim: { status: 'open', at: days(4), by: 'Dana at Northwind', note: '', media: [] },
      }),
      /* Nobody has said anything about this one. */
      finding('Missing security headers'),
      /* Already checked by the team: the claim was cleared, which is what "verified" means. */
      finding('Weak TLS configuration', { remediationStatus: 'fixed' }),
    ],
    questions: [
      {
        text: 'Which load balancer is this about?',
        context: '',
        fromClient: 'Dana at Northwind',
        status: 'open',
        createdAt: days(6),
      },
      {
        text: 'Is the staging host in scope for the retest?',
        fromClient: 'Dana at Northwind',
        status: 'answered',
        answer: 'It is.',
        createdAt: days(5),
      },
      /* The team asking the client something. Not a client question, and not this queue's business. */
      {
        text: 'INTERNALQUESTION do they know the backup admin account is still enabled?',
        askedOf: 'Dana',
        status: 'open',
        createdAt: days(8),
      },
    ],
  });

  /* One this person is not on at all, with plenty waiting on it. */
  const hidden = await Audit.create({
    name: 'Someone Else Ltd',
    reference: 'PT-2026-099',
    company: company._id,
    creator: other._id,
    language: 'en',
    findings: [
      finding('SECRETFINDING on another team engagement', {
        clientClaim: { status: 'fixed', at: days(30), by: 'Their client', note: '', media: [] },
      }),
    ],
    questions: [
      { text: 'SECRETQUESTION from their client', fromClient: 'Their client', status: 'open' },
    ],
  });

  /* And one that has been put away. */
  await Audit.create({
    name: 'Archived Engagement',
    reference: 'PT-2025-001',
    company: company._id,
    creator: mine._id,
    language: 'en',
    archivedAt: new Date(),
    findings: [
      finding('ARCHIVEDFINDING', {
        clientClaim: { status: 'fixed', at: days(40), by: 'Old client', note: '', media: [] },
      }),
    ],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nThe queue is everything a client said, oldest first:');
  let queue = null;
  {
    const answer = await call('GET', '/api/verification', null, session);
    check('it answers', answer.status === 200, answer.text.slice(0, 160));
    queue = answer.body;

    check(
      'three claims — two fixed, one the client says is still open',
      queue.claims.length === 3,
      queue.claims.map((row) => row.title).join(' | ')
    );
    check(
      '  the oldest is first, which is the point of the page',
      queue.claims[0].title === 'Session cookie without Secure',
      queue.claims.map((row) => `${row.title}@${row.at}`).join(' | ')
    );
    check(
      '  a claim carries what the client said, in their words',
      queue.claims[0].note.startsWith('Moved it behind the session check') &&
        queue.claims[0].by === 'Dana at Northwind',
      JSON.stringify([queue.claims[0].by, queue.claims[0].note])
    );
    check(
      '  and how many screenshots came with it',
      queue.claims[0].attachments === 1,
      String(queue.claims[0].attachments)
    );
    check(
      '  with the severity worked out here, not on the page',
      queue.claims[0].severity === 'High' && typeof queue.claims[0].score === 'number',
      JSON.stringify([queue.claims[0].severity, queue.claims[0].score])
    );
    check(
      'a finding nobody has claimed is not in the queue',
      !queue.claims.some((row) => row.title === 'Missing security headers'),
      ''
    );
    check(
      'and one the team already checked is not either — the claim was cleared',
      !queue.claims.some((row) => row.title === 'Weak TLS configuration'),
      ''
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nOnly the questions a client actually asked:');
  {
    check(
      'one open question from the client',
      queue.questions.length === 1 &&
        queue.questions[0].text === 'Which load balancer is this about?',
      queue.questions.map((row) => row.text).join(' | ')
    );
    check(
      '  it says which link it came through',
      queue.questions[0].from === 'Dana at Northwind',
      String(queue.questions[0].from)
    );
    check(
      'an answered one is waiting on nobody',
      !queue.questions.some((row) => row.text.includes('staging host')),
      ''
    );
    /*
     * The one worth planting. A team question is internal — written to a colleague about a client —
     * and a queue that swept up everything in the array would have put it here beside the client's
     * own words, which is a different page's job and a different tone of voice entirely.
     */
    check(
      "the team's own question to the client is not in the client's queue",
      !JSON.stringify(queue).includes('INTERNALQUESTION'),
      ''
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nIt can only ever show engagements you could already open:');
  {
    check(
      "another team's engagement is not in mine",
      !JSON.stringify(queue).includes('SECRETFINDING') &&
        !JSON.stringify(queue).includes('SECRETQUESTION'),
      ''
    );
    check(
      'an archived engagement is out of the working queue',
      !JSON.stringify(queue).includes('ARCHIVEDFINDING'),
      ''
    );

    const theirs = await call('GET', '/api/verification', null, strangerSession);
    check(
      'and the other way round: they see theirs and not mine',
      theirs.body.claims.length === 1 &&
        theirs.body.claims[0].title.startsWith('SECRETFINDING') &&
        !theirs.text.includes('Session cookie without Secure'),
      theirs.body.claims.map((row) => row.title).join(' | ')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd it carries none of the prose a finding is made of:');
  {
    const answer = await call('GET', '/api/verification', null, session);
    check(
      'no description, impact, remediation or proof of concept on the wire',
      !answer.text.includes('reflected without encoding'),
      answer.text.slice(0, 140)
    );
    check(
      'totals say what is waiting',
      queue.totals.claims === 3 && queue.totals.toVerify === 2 && queue.totals.questions === 1,
      JSON.stringify(queue.totals)
    );
    check(
      '  and how long the oldest has been',
      queue.totals.oldestDays === 9,
      String(queue.totals.oldestDays)
    );
    check(
      '  and that all of it is mine, since I am the one running these engagements',
      queue.totals.mine === 4,
      String(queue.totals.mine)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nDealing with a row takes it out of the queue:');
  {
    const first = queue.claims[0];
    const verified = await call(
      'PUT',
      `/api/audits/${first.auditId}/findings/${first.findingId}`,
      { remediationStatus: 'fixed' },
      session
    );
    check('the retest is recorded', verified.status === 200, verified.text.slice(0, 140));

    const answered = await call(
      'PUT',
      `/api/audits/${audit._id}/questions/${queue.questions[0].questionId}`,
      { status: 'answered', answer: 'The one in front of the portal.' },
      session
    );
    check('the answer is recorded', answered.status === 200, answered.text.slice(0, 140));

    const after = (await call('GET', '/api/verification', null, session)).body;
    check(
      'the verified claim is gone, and the rest is still there',
      after.claims.length === 2 &&
        !after.claims.some((row) => row.findingId === first.findingId),
      after.claims.map((row) => row.title).join(' | ')
    );
    check('the answered question is gone too', after.questions.length === 0, JSON.stringify(after.questions));
    check(
      '  and the next oldest has moved to the top',
      after.claims[0].title === 'Verbose error messages',
      after.claims.map((row) => row.title).join(' | ')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA closed report still shows what was never dealt with:');
  {
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'APPROVED' } });
    const after = (await call('GET', '/api/verification', null, session)).body;
    check(
      'approving an engagement does not empty its queue',
      after.claims.length === 2,
      after.claims.map((row) => `${row.title}:${row.state}`).join(' | ')
    );
    check(
      '  and each row says the report is closed, so the page can say why it offers no buttons',
      after.claims.every((row) => row.state === 'APPROVED'),
      after.claims.map((row) => row.state).join(' | ')
    );
    /* Which is not merely cosmetic: the write really is refused. */
    const refused = await call(
      'PUT',
      `/api/audits/${audit._id}/findings/${after.claims[0].findingId}`,
      { remediationStatus: 'fixed' },
      session
    );
    check(
      '  and the write behind those buttons is genuinely refused',
      refused.status === 403,
      String(refused.status)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd nothing at all is a state of its own, not an error:');
  {
    await Audit.updateMany({}, { $set: { 'findings.$[].clientClaim.status': '' } });
    const empty = (await call('GET', '/api/verification', null, session)).body;
    check(
      'an empty queue answers with empty lists',
      empty.claims.length === 0 && empty.questions.length === 0,
      JSON.stringify(empty.totals)
    );
    check('and no oldest to report', empty.totals.oldestDays === null, String(empty.totals.oldestDays));
  }

  /* Quiet the unused-variable lint on a fixture that exists to be invisible. */
  void hidden;
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
