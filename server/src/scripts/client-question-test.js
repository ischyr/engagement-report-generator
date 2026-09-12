/**
 * The other half of the client conversation, and the wall down the middle of it.
 *
 *   npm run test:client-question
 *
 * A share link has taken "we fixed it, and here is what we changed" for a while. It never took a
 * question, so a reader who needed to know *which* load balancer a finding was about left the page
 * and sent an email that arrived nowhere near the finding. It takes one now, into the Questions tab
 * that has existed the whole time for that conversation pointed the other way.
 *
 * Half of this file is the feature. The other half is the thing the feature made possible and
 * dangerous: reading an answer back means the share page's projection now includes `questions`, and
 * that array holds every question the *team* has written about this client — in words meant for
 * colleagues. A filter stands between the two, and a filter is the kind of thing that is correct
 * until somebody refactors the shape around it. So the wall is asserted from the client's side,
 * with a team question deliberately planted where it would show if the wall were not there.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { Activity } from '../models/activity.model.js';
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

const PORT = 4129;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-client-question-${Date.now()}`);
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

/** A question the team wrote, which the client must never see however the page is shaped. */
const SECRET = 'Do they know their old backup admin account is still enabled?';

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'cq-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'cq-lead@example.invalid',
    password: 'QuestionPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const company = await Company.create({ name: 'Northwind', createdBy: lead._id });

  const audit = await Audit.create({
    name: 'Northwind portal',
    reference: 'PT-1',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    findings: [
      {
        identifier: 1,
        title: 'Session cookie without Secure',
        description: '<p>The cookie is set without the flag.</p>',
        remediation: '<p>Set it.</p>',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
      },
    ],
  });

  const findingId = String(audit.findings[0]._id);

  /*
   * Planted, and planted *on the finding*.
   *
   * `clientView` filters on two conditions — from a client, and about this finding. A team
   * question with no context fails the second one, so an assertion about leaking would pass
   * whether or not the first condition existed. Giving it the finding's id leaves `fromClient`
   * as the only thing between these words and the client's screen, which is the thing being
   * tested. Verified by deleting that check and watching this go red.
   */
  audit.questions.push({
    text: SECRET,
    context: findingId,
    askedOf: 'Marijke',
    status: 'open',
    askedBy: lead._id,
  });
  await audit.save();

  const made = await call('POST', `/api/share/link/${audit._id}`, {
    label: 'Marijke at Northwind',
    days: 30,
    allowUpdates: true,
    kind: 'findings',
  }, session);
  check('a share link is made', made.status === 201 || made.status === 200, `${made.status} ${made.text.slice(0, 140)}`);
  const token = made.body?.token ?? made.body?.url?.split('/').pop();
  check('  and it hands back the token once', Boolean(token), JSON.stringify(made.body).slice(0, 140));


  /* ------------------------------------------------------------------------ */
  console.log('\nThe client can ask about a finding:');
  {
    const asked = await call('POST', `/api/share/${token}/findings/${findingId}/question`, {
      text: 'Which of our three load balancers does this apply to?',
    });
    check('the question is accepted', asked.status === 201, `${asked.status} ${asked.text.slice(0, 160)}`);
    check('  and handed straight back', asked.body?.text?.startsWith('Which of our three'), asked.body?.text);
    check('  with no answer yet', asked.body?.answer === '', JSON.stringify(asked.body?.answer));

    const fresh = await Audit.findById(audit._id);
    const landed = fresh.questions.find((row) => row.fromClient);
    check('it lands in the engagement’s questions', Boolean(landed), 'nothing arrived');
    check('  marked with the link it came through', landed?.fromClient === 'Marijke at Northwind', landed?.fromClient);
    check('  against the finding, so it can be followed', String(landed?.context) === findingId, landed?.context);
    check('  open, and not printing', landed?.status === 'open' && landed?.print === false, `${landed?.status}/${landed?.print}`);
    check('  with no author, because there is no account', landed?.askedBy == null, String(landed?.askedBy));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the team is told, rather than finding out by chance:');
  {
    const told = await Notification.find({ audit: audit._id, type: 'client-asked-question' }).lean();
    check('a notification goes to the engagement', told.length === 1, String(told.length));
    check('  quoting what they asked', /load balancers/.test(told[0]?.message ?? ''), told[0]?.message);
    check(
      '  and pointing at the tab the answer is written in',
      told[0]?.href === `/engagements/${audit._id}?tab=questions`,
      told[0]?.href
    );
    check('  with no actor, because nobody on the team did it', told[0]?.actor == null, String(told[0]?.actor));

    const logged = await Activity.find({ audit: audit._id, action: 'client.asked' }).lean();
    check('and the activity log says so too', logged.length === 1, String(logged.length));
    check(
      '  naming the link rather than a person',
      /Marijke at Northwind/.test(logged[0]?.summary ?? ''),
      logged[0]?.summary
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe answer finds its way back to them:');
  {
    const before = await call('GET', `/api/share/${token}`);
    const theirs = before.body?.findings?.[0]?.questions ?? [];
    check('their own question is read back to them', theirs.length === 1, JSON.stringify(theirs));
    check('  still waiting', theirs[0]?.answer === '', theirs[0]?.answer);

    /* The team answers it the ordinary way, through the tab. */
    const fresh = await Audit.findById(audit._id);
    const id = fresh.questions.find((row) => row.fromClient)._id;
    const answered = await call(
      'PUT',
      `/api/audits/${audit._id}/questions/${id}`,
      { status: 'answered', answer: 'The public one only — lb-edge-01.' },
      session
    );
    check('the team answers it', answered.status === 200, `${answered.status} ${answered.text.slice(0, 140)}`);

    const after = await call('GET', `/api/share/${token}`);
    const now = after.body?.findings?.[0]?.questions ?? [];
    check('the client sees the answer', now[0]?.answer === 'The public one only — lb-edge-01.', now[0]?.answer);
    check('  with when it was answered', Boolean(now[0]?.answeredAt), String(now[0]?.answeredAt));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd never sees a question the team asked about them:');
  {
    const view = await call('GET', `/api/share/${token}`);
    check(
      'the whole payload does not contain it',
      !view.text.includes('backup admin'),
      'the team’s own question reached the client'
    );
    check(
      '  and only their own question comes back',
      (view.body?.findings?.[0]?.questions ?? []).length === 1,
      JSON.stringify(view.body?.findings?.[0]?.questions)
    );
    check(
      '  with nothing of the record but the words and the reply',
      Object.keys(view.body?.findings?.[0]?.questions?.[0] ?? {}).sort().join(',') ===
        '_id,answer,answeredAt,askedAt,text',
      Object.keys(view.body?.findings?.[0]?.questions?.[0] ?? {}).join(',')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the link’s own rules still hold:');
  {
    const readOnly = await call('POST', `/api/share/link/${audit._id}`, {
      label: 'Read only',
      days: 30,
      allowUpdates: false,
      kind: 'findings',
    }, session);
    const quiet = readOnly.body?.token;
    const refused = await call('POST', `/api/share/${quiet}/findings/${findingId}/question`, {
      text: 'Can I ask anyway?',
    });
    check('a read-only link refuses a question', refused.status === 403, `${refused.status} ${refused.text.slice(0, 120)}`);

    const statusLink = await call('POST', `/api/share/link/${audit._id}`, {
      label: 'Progress',
      days: 30,
      kind: 'status',
    }, session);
    const progress = await call(
      'POST',
      `/api/share/${statusLink.body?.token}/findings/${findingId}/question`,
      { text: 'And here?' }
    );
    check('  a status link has no findings to ask about', progress.status === 403, String(progress.status));

    const nonsense = await call('POST', `/api/share/${token}/findings/${'0'.repeat(24)}/question`, {
      text: 'About a finding that is not there',
    });
    check('  a finding that is not on the report is a 404', nonsense.status === 404, String(nonsense.status));

    const empty = await call('POST', `/api/share/${token}/findings/${findingId}/question`, { text: 'hm' });
    check('  and two characters is not a question', empty.status === 422, String(empty.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA closed report takes nothing more:');
  {
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'APPROVED' } });
    const late = await call('POST', `/api/share/${token}/findings/${findingId}/question`, {
      text: 'One more thing',
    });
    check('an approved engagement refuses it', late.status === 403, String(late.status));
    check('  and says what to do about that', /reopen/i.test(late.text), late.text.slice(0, 140));
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
