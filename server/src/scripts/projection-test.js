/**
 * A read that asks for less must still answer with everything, and still refuse everyone it did.
 *
 *   npm run test:projection
 *
 * Twenty per-tab endpoints stopped reading the whole engagement. Opening the Notes tab used to
 * load the findings, the 53 checklist items, the enumeration tree and the sections in order to
 * answer with four notes; eleven other routes read the entire document purely to authorise a
 * query against a different collection. They now name what they need.
 *
 * Projections fail in two ways, and neither of them looks like a failure:
 *
 *   - **a missing array reads as an empty one.** The endpoint answers 200, the tab is blank, and
 *     nothing anywhere says why. So every array here is seeded with a distinctive string and the
 *     assertion is that the string comes back.
 *   - **a missing guard field reads as "no access".** `creator`, `collaborators`, `reviewers`,
 *     `memberUntil`, `classification` and `deletedAt` are what decide who may open an engagement.
 *     Projected away, the checks do not error — they quietly answer "you are not on this
 *     engagement" to somebody who is, or worse, stop refusing somebody who is not. That is the
 *     second half of this file, and it is the half worth having.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-projection-test-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function get(path, session) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  const text = await response.text();
  return { status: response.status, text, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null };
}

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'proj-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ines@example.invalid',
    password: 'ProjPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const stranger = await User.create({
    username: 'proj-stranger',
    email: 'stranger@example.invalid',
    password: 'ProjPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const leaver = await User.create({
    username: 'proj-leaver',
    email: 'leaver@example.invalid',
    password: 'ProjPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });

  const company = await Company.create({ name: 'Northwind Logistics', createdBy: lead._id });
  const session = signAccessToken(lead);

  /**
   * One engagement with something distinctive in every array a projected route reads.
   *
   * The markers are the assertion. A projection that names the wrong field answers with an empty
   * array and a 200, so "did the endpoint work" proves nothing — "is MARKER-notes in the body"
   * proves it read the right thing.
   */
  const audit = await Audit.create({
    name: 'Northwind Shipment Portal',
    reference: 'PT-2026-041',
    company: company._id,
    creator: lead._id,
    collaborators: [lead._id, leaver._id],
    state: 'EDIT',
    findings: [
      {
        identifier: 1,
        title: 'MARKER-finding readable without authentication',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
        /* Held, so /locks has something to answer with — an unlocked finding correctly
           produces an empty list, which would make that assertion prove nothing. */
        lockedBy: lead._id,
        lockedAt: new Date(),
      },
    ],
    notes: [{ title: 'MARKER-notes', content: 'the note body', author: lead._id }],
    questions: [{ text: 'MARKER-questions is this host in scope?', askedOf: 'Marijke' }],
    testChecks: [{ title: 'MARKER-testChecks TLS configuration', createdBy: lead._id }],
    handovers: [{ did: 'MARKER-handovers swept the portal', author: lead._id }],
    intrusions: [{ title: 'MARKER-intrusions disabled MFA', action: 'disabled', author: lead._id }],
    enumerationVars: [{ name: 'MARKER-vars', value: 'portal.example' }],
    sections: [{ field: 'summary', name: 'MARKER-sections Executive summary', text: 'x' }],
    scope: [{ name: 'MARKER-scope', hosts: [{ hostname: 'portal.example' }] }],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nEvery projected tab still answers with its own contents:');
  {
    const cases = [
      ['/notes', 'MARKER-notes'],
      ['/questions', 'MARKER-questions'],
      ['/test-checks', 'MARKER-testChecks'],
      ['/handovers', 'MARKER-handovers'],
      ['/intrusions', 'MARKER-intrusions'],
      ['/enumeration/vars', 'MARKER-vars'],
      ['/locks', 'MARKER-finding'],
      ['/findings/similar?title=readable', null],
    ];

    for (const [suffix, marker] of cases) {
      const { status, text } = await get(`/api/audits/${audit._id}${suffix}`, session);
      check(`${suffix} answers`, status === 200, `${status} ${text.slice(0, 120)}`);
      if (marker) {
        check(
          `  and its contents are there, not an empty array`,
          text.includes(marker),
          `no ${marker} in ${text.slice(0, 160)}`
        );
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe routes that read the document only to authorise a query still work:');
  {
    /*
     * These answer from other collections — Delivery, Signature, ScopeChange, PhishingTarget,
     * EngagementDocument, DetectionEvent, Credential, Activity — so the lists are empty on a fresh
     * engagement and that is correct. What is being checked is that they do not fall over: a
     * handler dereferencing an array the projection dropped would 500 here rather than 200.
     */
    for (const suffix of [
      '/credentials',
      '/signatures',
      '/scope-changes',
      '/phishing',
      '/documents',
      '/detections',
      '/deliveries',
      '/findings/deleted',
      '/activity',
      '/enumeration/presets',
      '/kit-where/rack-1',
    ]) {
      const { status, text } = await get(`/api/audits/${audit._id}${suffix}`, session);
      check(`${suffix} answers 200`, status === 200, `${status} ${text.slice(0, 140)}`);
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the guards a projection could have dropped still hold:');
  {
    /* Not on it at all. If `collaborators` were projected away, everybody would be a stranger. */
    const outside = await get(`/api/audits/${audit._id}/notes`, signAccessToken(stranger));
    check('somebody not on the engagement is refused', outside.status === 403, outside.status);
    check(
      'and it is the access message, not a crash',
      /do not have access/i.test(outside.body?.error ?? ''),
      outside.body?.error
    );

    /*
     * Membership with a date that has passed. `memberUntil` is the field, and it is the one most
     * likely to be forgotten in a projection because no handler reads it — only the guard does.
     */
    await Audit.updateOne(
      { _id: audit._id },
      { $set: { memberUntil: [{ user: leaver._id, until: '2020-01-01' }] } }
    );
    const expired = await get(`/api/audits/${audit._id}/notes`, signAccessToken(leaver));
    check('expired membership is refused', expired.status === 403, expired.status);
    check(
      'and says the access ended rather than that the engagement is missing',
      /access to this engagement ended/i.test(expired.body?.error ?? ''),
      expired.body?.error
    );

    /* And the creator is never expired by a stray row, projected read or not. */
    const still = await get(`/api/audits/${audit._id}/notes`, session);
    check('the creator still gets in', still.status === 200, still.status);

    /*
     * Restricted work needs two-factor authentication, and `classification` is what says so. A
     * projection that dropped it would make every restricted engagement openable by anybody on it
     * with a password alone.
     */
    await Audit.updateOne({ _id: audit._id }, { $set: { classification: 'restricted' } });
    const restricted = await get(`/api/audits/${audit._id}/notes`, session);
    check('a restricted engagement needs an authenticator', restricted.status === 403, restricted.status);
    check(
      'and says which',
      /two-factor/i.test(restricted.body?.error ?? ''),
      restricted.body?.error
    );

    await User.updateOne({ _id: lead._id }, { $set: { totpEnabled: true } });
    const withTotp = await get(`/api/audits/${audit._id}/notes`, signAccessToken(await User.findById(lead._id)));
    check('and lets them in once they have one', withTotp.status === 200, withTotp.status);
    await Audit.updateOne({ _id: audit._id }, { $set: { classification: 'standard' } });

    /* The trash. `deletedAt` is the field, and nothing but the guard reads it. */
    await Audit.updateOne({ _id: audit._id }, { $set: { deletedAt: new Date() } });
    const trashed = await get(`/api/audits/${audit._id}/notes`, session);
    check('a trashed engagement is not readable', trashed.status === 404, trashed.status);
    /* Except by the routes that manage the trash, which pass includeDeleted. */
    const history = await get(`/api/audits/${audit._id}/activity`, session);
    check('while the activity log still opens it, as it is meant to', history.status === 200, history.status);
    await Audit.updateOne({ _id: audit._id }, { $unset: { deletedAt: 1 } });
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA projected document can still be saved without losing what it never loaded:');
  {
    /*
     * The reason `AUDIT_BASE_FIELDS` includes `name`: it is `required` on the schema, and Mongoose
     * validates the whole document on save. A projected document saved without it fails validation
     * on a field the route never touched — which is a 500 on a write that should have worked.
     *
     * Tested at the model level rather than through a route, because no write route projects yet
     * and the point is that one safely can.
     */
    const projected = await Audit.findById(audit._id).select(
      'name creator collaborators reviewers memberUntil classification classifiedBy deletedAt state updatedAt createdAt notes'
    );
    projected.notes.push({ title: 'MARKER-added-while-projected', content: 'y', author: lead._id });

    let error = null;
    try {
      await projected.save();
    } catch (problem) {
      error = problem;
    }
    check('it saves', !error, String(error?.message).slice(0, 200));

    const fresh = await Audit.findById(audit._id);
    check('the note was added', fresh.notes.some((n) => n.title === 'MARKER-added-while-projected'));
    check('the notes it did load are intact', fresh.notes.some((n) => n.title === 'MARKER-notes'));
    /* The assertion that matters: the arrays the projection never saw are still there. */
    check(
      'and the findings it never loaded are untouched',
      fresh.findings.length === 1 && fresh.findings[0].title.includes('MARKER-finding'),
      `${fresh.findings.length} findings`
    );
    check(
      'as are the checks, questions and sections',
      fresh.testChecks.length === 1 && fresh.questions.length === 1 && fresh.sections.length === 1,
      `${fresh.testChecks.length}/${fresh.questions.length}/${fresh.sections.length}`
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
