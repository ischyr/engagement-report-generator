/**
 * The client's side of a retest, over a real HTTP server and a real database.
 *
 *   npm run test:client-claim
 *
 * This exercises the only route in the application that takes a file from somebody with no
 * account, so most of what is below is the refusals. The happy path is four assertions; the rest
 * asks whether each defence actually holds, because a defence nobody tested is a comment.
 *
 * Driven through `createApp()` over a socket rather than by calling the service, because the thing
 * being tested is the endpoint: the rate limiter, the multer limits, the guards and their order are
 * all properties of the route and none of them exist below it.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';

import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { ShareLink } from '../models/share-link.model.js';
import { User } from '../models/user.model.js';
import { Activity } from '../models/activity.model.js';
import { issueShareLink } from '../services/share.service.js';
import { auditEvidenceBin } from '../services/media.service.js';
import { buildReportData } from '../services/report.service.js';

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

/** A one-pixel PNG, which is a real image as far as any sniffer is concerned. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const uri = `mongodb://127.0.0.1:27017/engy-client-claim-test-${Date.now()}`;
await mongoose.connect(uri);

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** A multipart body, by hand: there is no browser here to build one. */
const multipart = (filename, contentType, bytes) => {
  const boundary = `----engy${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), type: `multipart/form-data; boundary=${boundary}` };
};

const post = (path, body, type = 'application/json') =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });

const attach = (token, findingId, file = multipart('fix.png', 'image/png', PNG)) =>
  fetch(`${origin}/api/share/${token}/findings/${findingId}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file.body,
  });

try {
  /* ------------------------------------------------------------------ set up */
  await Settings.getSettings();
  const lead = await User.create({
    username: 'claim-lead',
    firstname: 'Nadia',
    lastname: 'Okonjo',
    email: 'nadia@example.invalid',
    password: 'ClaimPass123!',
    role: 'user',
    enabled: true,
    approvedAt: new Date(),
  });
  const company = await Company.create({ name: 'Northwind Logistics', createdBy: lead._id });

  const makeAudit = async (overrides = {}) =>
    Audit.create({
      name: 'Northwind Shipment Portal',
      company: company._id,
      creator: lead._id,
      collaborators: [lead._id],
      state: 'REVIEW',
      findings: [
        {
          identifier: 1,
          title: 'Shipment documents readable without authentication',
          cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
          createdBy: lead._id,
        },
      ],
      ...overrides,
    });

  const audit = await makeAudit();
  const findingId = String(audit.findings[0]._id);

  const open = await issueShareLink({
    audit,
    label: 'Dana at Northwind',
    days: 7,
    allowUpdates: true,
    allowEvidence: true,
    actor: lead,
  });

  /* ------------------------------------------------------- the claim and note */
  console.log('\nA claim with a sentence attached:');
  {
    const response = await post(`/api/share/${open.token}/findings/${findingId}`, {
      fixed: true,
      note: 'Moved /api/documents behind the session check and deployed on Tuesday.',
    });
    check('is accepted', response.ok, `${response.status}`);

    const fresh = await Audit.findById(audit._id).lean();
    const claim = fresh.findings[0].clientClaim;
    check('records the status', claim.status === 'fixed', claim.status);
    check('and the sentence', claim.note.startsWith('Moved /api/documents'), claim.note);
    check('and who said it', claim.by === 'Dana at Northwind', claim.by);
    check('the finding moves with it', fresh.findings[0].remediationStatus === 'fixed');

    const body = await response.json();
    check(
      'and the page reads their own words back to them',
      body.findings?.[0]?.claim?.note?.startsWith('Moved /api/documents'),
      JSON.stringify(body.findings?.[0]?.claim)
    );

    const told = await Notification.countDocuments({ audit: audit._id });
    check('the team is told', told === 1, `${told}`);
    const message = (await Notification.findOne({ audit: audit._id }).lean())?.message ?? '';
    check('and told there is something to read', message.includes('said what they did'), message);
  }

  console.log('\nA second visit, to explain more:');
  {
    /* The status does not change; the note does. Both facts have to survive. */
    const response = await post(`/api/share/${open.token}/findings/${findingId}`, {
      fixed: true,
      note: 'Also rotated the credential that was in the waybill.',
    });
    check('is accepted', response.ok, `${response.status}`);
    const claim = (await Audit.findById(audit._id).lean()).findings[0].clientClaim;
    check('the new sentence replaces the old', claim.note.startsWith('Also rotated'), claim.note);

    const entries = await Activity.countDocuments({ audit: audit._id });
    check('and it is in the log rather than silent', entries >= 2, `${entries} entries`);
  }

  /* ----------------------------------------------------------- the attachment */
  console.log('\nA screenshot of the fix:');
  {
    const response = await attach(open.token, findingId);
    check('is accepted', response.status === 201, `${response.status}`);
    const body = await response.json().catch(() => ({}));
    check('and counted', body.attachments === 1, JSON.stringify(body));

    const claim = (await Audit.findById(audit._id).lean()).findings[0].clientClaim;
    check('the id is on the claim', (claim.media ?? []).length === 1, JSON.stringify(claim.media));

    const bin = await auditEvidenceBin(audit._id);
    check('it appears in the evidence bin', bin.length === 1, `${bin.length}`);
    check("marked as the client's own", bin[0]?.source === 'client', JSON.stringify(bin[0]?.source));
    check(
      'and with no uploader, because there is no account behind it',
      bin[0]?.uploader === null,
      JSON.stringify(bin[0]?.uploader)
    );
  }

  /* ------------------------------------------------------------ the refusals */
  console.log('\nAnd what it refuses:');
  {
    /*
     * The ceiling, on a link of its own.
     *
     * Six is what a client can attach; the seventh is refused. Reached by putting six ids on the
     * claim rather than by uploading six times, because the rate limit below would be spent long
     * before the ceiling was, and then this assertion would be testing that instead.
     */
    const full = await makeAudit();
    const fullFinding = full.findings[0];
    fullFinding.clientClaim = {
      status: 'fixed',
      at: new Date(),
      by: 'Dana at Northwind',
      media: Array.from({ length: 6 }, () => new mongoose.Types.ObjectId().toString()),
    };
    await full.save();

    const fullLink = await issueShareLink({
      audit: full,
      label: 'Six already',
      days: 7,
      allowUpdates: true,
      allowEvidence: true,
      actor: lead,
    });
    const overflowing = await attach(fullLink.token, String(fullFinding._id));
    check('a seventh attachment is refused', overflowing.status === 403, `${overflowing.status}`);
    check(
      'and says so in a way a client can act on',
      /as many attachments as this link takes/i.test(await overflowing.text()),
      'the refusal did not explain itself'
    );

    /* A link that was not given permission. */
    const noEvidence = await issueShareLink({
      audit,
      label: 'Read only',
      days: 7,
      allowUpdates: true,
      allowEvidence: false,
      actor: lead,
    });
    check(
      'a link without permission cannot attach',
      (await attach(noEvidence.token, findingId)).status === 403
    );
    check(
      'but can still claim, as it always could',
      (await post(`/api/share/${noEvidence.token}/findings/${findingId}`, { fixed: true })).ok
    );

    /* A read-only link. */
    const readOnly = await issueShareLink({
      audit,
      label: 'Look, do not touch',
      days: 7,
      allowUpdates: false,
      allowEvidence: true,
      actor: lead,
    });
    check(
      'a read-only link cannot attach even if asked for',
      (await attach(readOnly.token, findingId)).status === 403,
      'allowEvidence outlived allowUpdates'
    );

    /* A status link has no findings at all. */
    const status = await issueShareLink({ audit, days: 7, kind: 'status', actor: lead });
    check('a status link cannot attach', (await attach(status.token, findingId)).status === 403);

    /* Something that is not an image. */
    const script = multipart('fix.sh', 'text/x-shellscript', Buffer.from('#!/bin/sh\nrm -rf /\n'));
    check(
      'a shell script is not a screenshot',
      (await attach(open.token, findingId, script)).status === 400
    );

    /* Something that says it is an image and is not. */
    const liar = multipart('fix.png', 'image/png', Buffer.from('#!/bin/sh\nid\n'));
    const lied = await attach(open.token, findingId, liar);
    check(
      'nor is a script that claims to be one',
      lied.status === 400,
      `${lied.status} — the content was trusted from its header`
    );

    /* A restricted engagement, whatever the link says. */
    const restricted = await makeAudit({ classification: 'restricted' });
    const restrictedLink = await issueShareLink({
      audit: restricted,
      days: 7,
      allowUpdates: true,
      allowEvidence: true,
      actor: lead,
    });
    const refused = await attach(restrictedLink.token, String(restricted.findings[0]._id));
    check('a restricted engagement refuses attachments', refused.status === 403, `${refused.status}`);

    /* An approved report is closed. */
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'APPROVED' } });
    check(
      'and an approved report is closed to both',
      (await attach(open.token, findingId)).status === 403 &&
        (await post(`/api/share/${open.token}/findings/${findingId}`, { fixed: false })).status === 403
    );
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'REVIEW' } });

    /* A token nobody issued. */
    const nobody = await attach('a'.repeat(64), findingId);
    check('an invented token is not found', nobody.status === 404, `${nobody.status}`);

    /*
     * And the rate limit, which by now is spent.
     *
     * Ten requests an hour from one address, counted whether they succeeded or were refused: this
     * test has made ten by this point, so the next one is answered by the limiter before any of the
     * checks above it run. That ordering is the point — a stranger cannot probe the guards cheaply.
     */
    const limited = await attach(open.token, findingId);
    check('and the address itself runs out of attempts', limited.status === 429, `${limited.status}`);

    const claim = (await Audit.findById(audit._id).lean()).findings[0].clientClaim;
    check(
      'with no more stored than were allowed',
      (claim.media ?? []).length <= 6,
      `${claim.media?.length} on the claim`
    );
  }
  /* ------------------------------------------------- and never into the report */
  console.log('\nWhat the client wrote stays out of the document:');
  {
    /*
     * The one field on a finding whose contents were typed by somebody outside the firm.
     *
     * A claim is not a verified fix; the model keeps them apart on purpose. So a template must not
     * be able to reach the claim at all, or a report could state a fix on the strength of the
     * client having said so, in their own words, over a link that can be forwarded.
     */
    const withClaim = await makeAudit();
    withClaim.findings[0].clientClaim = {
      status: 'fixed',
      at: new Date(),
      by: 'Dana at Northwind',
      note: 'SECRET-CLIENT-SENTENCE that must not be printed',
      media: ['deadbeefdeadbeefdeadbeef'],
    };
    await withClaim.save();

    const settings = await Settings.getSettings();
    const data = buildReportData(withClaim.toObject(), settings.toObject(), {}, {});
    const serialised = JSON.stringify(data);

    check(
      'the claim is not on the finding the template sees',
      data.findings?.[0] && !('clientClaim' in data.findings[0]),
      Object.keys(data.findings?.[0] ?? {}).filter((key) => /claim/i.test(key)).join(', ')
    );
    check(
      'and their sentence is nowhere in the data at all',
      !serialised.includes('SECRET-CLIENT-SENTENCE'),
      'the note reached the report data'
    );
    check(
      'while the status a tester set does print, because that is a fact we checked',
      data.findings?.[0]?.remediationStatus !== undefined,
      'remediationStatus was stripped along with the claim'
    );
  }
} finally {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
