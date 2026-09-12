/**
 * Generating a report without holding the request open, and telling two of them apart.
 *
 *   npm run test:report-flow
 *
 * Two changes, one suite, because they are the same path: a report is queued, rendered, collected —
 * and the render that produced it now records what was in it, so the next one can be subtracted
 * from it.
 *
 * **The queue.** `GET /:id/report` used to build the document inside the request, which is why the
 * operations notes told operators to raise their proxy timeout. The interesting assertions are not
 * "a document came out" — the smoke test has covered that for a year — but the things a queue adds
 * and the things it can get wrong: does asking twice start two renders, is a job left `running` by
 * a dead process picked up again, do the bytes expire, and is access checked when the job *runs*
 * rather than only when it was asked for. That last one is the whole risk of putting time between
 * asking and doing.
 *
 * **The diff.** The register could say a delivered report was out of date and not a word about how.
 * Each render now carries the report's contents itemised and hashed, so two of them subtract to a
 * list. What is tested is that the list is right — including the cases where it must refuse to
 * answer, because a feature whose value is exactness must never say "nothing changed" when it
 * means "I cannot tell".
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { Template } from '../models/template.model.js';
import { User } from '../models/user.model.js';
import { RenderJob } from '../models/render-job.model.js';
import { RenderRecord } from '../models/render-record.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { recoverOrphans, sweepExpired } from '../services/render-queue.service.js';
import { reportSnapshot, snapshotDifferences } from '../utils/report-fingerprint.js';
import { generateReport } from '../services/report.service.js';

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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-report-flow-test-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const call = async (method, path, session, body) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};
const get = (path, session) => call('GET', path, session);
const post = (path, session, body = {}) => call('POST', path, session, body);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Follows a job to a finish, or gives up and says what it was doing when it did. */
async function settle(auditId, jobId, session, timeout = 90_000) {
  const until = Date.now() + timeout;
  let last = null;
  while (Date.now() < until) {
    const { status, body } = await get(`/api/audits/${auditId}/report/jobs/${jobId}`, session);
    /*
     * A non-200 is not a finished job, and treating it as one is how this harness once reported a
     * 403's message as a render's failure reason and passed. If the poll cannot read the job, say
     * so here rather than handing the caller something job-shaped that is not a job.
     */
    if (status !== 200) throw new Error(`polling the job answered ${status}: ${JSON.stringify(body)}`);
    last = body;
    if (body && !['queued', 'running'].includes(body.status)) return body;
    await sleep(250);
  }
  throw new Error(`job never finished — last seen ${last?.status} at "${last?.stage}"`);
}

/** The set of changes as flat strings, so an assertion reads like the thing it is asserting. */
const said = (changes) =>
  (changes ?? []).map(
    (change) =>
      `${change.change} ${change.kind} "${change.label}"${
        change.fields ? ` (${change.fields.join(', ')})` : ''
      }`
  );

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'flow-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'flow-ines@example.invalid',
    password: 'FlowPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const mate = await User.create({
    username: 'flow-mate',
    email: 'flow-mate@example.invalid',
    password: 'FlowPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const mateSession = signAccessToken(mate);

  /* The template that ships with the app, which is the one every install renders with. */
  const template = await Template.create({
    name: 'Flow test template',
    filename: 'engy-default-template.docx',
    kind: 'docx',
    purpose: 'report',
  });

  const company = await Company.create({ name: 'Northwind Logistics', createdBy: lead._id });
  const VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N';

  const audit = await Audit.create({
    name: 'Northwind Shipment Portal',
    reference: 'PT-2026-041',
    company: company._id,
    creator: lead._id,
    collaborators: [mate._id],
    state: 'EDIT',
    template: template._id,
    findings: [
      {
        identifier: 1,
        title: 'Reflected cross-site scripting in the search box',
        description: '<p>The <code>q</code> parameter is reflected without encoding.</p>',
        remediation: '<p>Encode on output.</p>',
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
      {
        identifier: 2,
        title: 'Directory listing enabled',
        description: '<p>The uploads folder lists its contents.</p>',
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
    ],
    sections: [{ field: 'summary', name: 'Executive summary', text: '<p>Two issues.</p>' }],
    scope: [{ name: 'Public estate', hosts: [{ hostname: 'portal.example' }] }],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nAsking for a report answers straight away, and the work happens behind it:');
  let firstRenderId = null;
  {
    const started = Date.now();
    const asked = await post(`/api/audits/${audit._id}/report/jobs`, session);
    const answeredIn = Date.now() - started;

    check('the request is accepted', asked.status === 202, `${asked.status} ${asked.text.slice(0, 160)}`);
    check(
      `  and answers in ${answeredIn}ms rather than holding the connection open`,
      answeredIn < 2000,
      `${answeredIn}ms`
    );
    check(
      '  with a job that is queued or already running',
      ['queued', 'running'].includes(asked.body?.status),
      asked.body?.status
    );

    /* Asking again must join, not start a second render of the same thing. */
    const again = await post(`/api/audits/${audit._id}/report/jobs`, session);
    check('asking twice joins the one already going', again.body?.joined === true, JSON.stringify(again.body?.status));
    check(
      '  and it is the same job, not a second one',
      String(again.body?._id) === String(asked.body?._id),
      `${again.body?._id} vs ${asked.body?._id}`
    );

    const done = await settle(audit._id, asked.body._id, session);
    check('it finishes', done.status === 'done', `${done.status}: ${done.error}`);
    check('  reporting 100%', done.progress === 100, String(done.progress));
    check('  with a filename', Boolean(done.filename), done.filename);
    check('  and the digest of the bytes it stored', /^[0-9a-f]{64}$/.test(done.outputHash ?? ''), done.outputHash);
    check('  linked to its render record', Boolean(done.renderId), done.renderId);
    firstRenderId = done.renderId;

    check('nothing has collected it yet', !done.collectedAt, String(done.collectedAt));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe render says which part it is on, in order:');
  {
    /*
     * Asserted against the renderer directly rather than by polling a job.
     *
     * The browser check watched the button and saw two stages, because a twelve-finding report
     * renders faster than a one-second poll — which says nothing about whether the stages exist.
     * Calling `generateReport` with a spy asks the question that was actually meant: does it
     * report, in order, with rising numbers, and does it name the slow step before starting it
     * rather than after.
     */
    const seen = [];
    await generateReport({
      audit: await Audit.findById(audit._id).populate('company'),
      template: await Template.findById(template._id),
      settings: await Settings.getSettings(),
      user: lead,
      enumerationBodies: new Map(),
      onProgress: async (stage, progress) => seen.push({ stage, progress }),
    });

    check(`it reports ${seen.length} stages`, seen.length >= 4, JSON.stringify(seen));
    check(
      '  with progress that only goes forwards',
      seen.every((step, index) => index === 0 || step.progress > seen[index - 1].progress),
      seen.map((step) => step.progress).join(' → ')
    );
    check(
      '  naming the assembly before starting it, since nothing can be said from inside it',
      seen.some((step) => /assembling/i.test(step.stage)),
      seen.map((step) => step.stage).join(' | ')
    );
    check(
      '  and stopping short of 100, which is the queue’s to give',
      seen[seen.length - 1].progress < 100,
      String(seen[seen.length - 1].progress)
    );
    check(
      '  in words a person waiting would use, not function names',
      seen.every((step) => /^[A-Z][a-z]/.test(step.stage) && !/[A-Z][a-z]+[A-Z]/.test(step.stage)),
      seen.map((step) => step.stage).join(' | ')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the document is there to be collected:');
  let firstHash = null;
  {
    const { body: list } = await get(`/api/audits/${audit._id}/report/jobs`, session);
    const job = list.jobs[0];
    const response = await fetch(`${origin}/api/audits/${audit._id}/report/jobs/${job._id}/file`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    const bytes = Buffer.from(await response.arrayBuffer());

    check('the file downloads', response.status === 200, String(response.status));
    check(
      '  as a Word document rather than an error page',
      bytes.subarray(0, 2).toString() === 'PK' && bytes.length > 10_000,
      `${bytes.length} bytes starting ${bytes.subarray(0, 2).toString('hex')}`
    );
    firstHash = crypto.createHash('sha256').update(bytes).digest('hex');
    check(
      '  and the bytes are exactly the ones the job hashed',
      firstHash === job.outputHash,
      `${firstHash.slice(0, 16)} vs ${String(job.outputHash).slice(0, 16)}`
    );
    check(
      '  with the digest headers the delivery form prefills from',
      response.headers.get('x-report-sha256') === job.outputHash &&
        Number(response.headers.get('x-report-size')) === bytes.length,
      `${response.headers.get('x-report-sha256')} / ${response.headers.get('x-report-size')}`
    );

    const { body: after } = await get(`/api/audits/${audit._id}/report/jobs/${job._id}`, session);
    check('collecting it is recorded', Boolean(after.collectedAt), String(after.collectedAt));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA render that cannot work fails as itself, not as a silent nothing:');
  {
    const broken = await Audit.create({
      name: 'No template here',
      reference: 'PT-BROKEN',
      company: company._id,
      creator: lead._id,
      state: 'EDIT',
      findings: [],
    });
    const asked = await post(`/api/audits/${broken._id}/report/jobs`, session);
    const done = await settle(broken._id, asked.body._id, session);
    check('the job fails', done.status === 'failed', done.status);
    check(
      '  carrying the message the old synchronous route would have returned',
      /template/i.test(done.error ?? ''),
      done.error
    );
    const file = await get(`/api/audits/${broken._id}/report/jobs/${asked.body._id}/file`, session);
    check('  and its file cannot be downloaded', file.status === 400, String(file.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAccess is checked when the job runs, not only when it was asked for:');
  {
    /*
     * The risk a queue introduces. Somebody asks for a report, is taken off the engagement while
     * it waits, and the old code would have had nothing to say about it — the authorisation
     * happened at a moment that has passed.
     */
    const asked = await post(`/api/audits/${audit._id}/report/jobs`, mateSession);
    await Audit.updateOne({ _id: audit._id }, { $set: { collaborators: [] } });

    /*
     * Followed as the lead, not as the person who asked.
     *
     * Polling as `mate` is what the first version of this did, and it reads the job through the
     * engagement — which `mate` can no longer open, so every poll came back 403. `settle` saw a
     * body with no `status`, returned it as if it were a finished job, and the assertion about the
     * error message passed against the 403's own text. The check was green and testing nothing.
     */
    const done = await settle(audit._id, asked.body._id, session);
    check(
      'a job from somebody since removed produces no document',
      done.status === 'failed',
      `${done.status} — ${done.error}`
    );
    check('  and says why', /access|not have/i.test(done.error ?? ''), done.error);

    await Audit.updateOne({ _id: audit._id }, { $set: { collaborators: [mate._id] } });
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA job left behind by a process that died is picked up again:');
  {
    const orphan = await RenderJob.create({
      audit: audit._id,
      status: 'running',
      attempts: 1,
      requestedBy: lead._id,
      stage: 'Assembling the document',
      progress: 75,
    });
    const hopeless = await RenderJob.create({
      audit: audit._id,
      status: 'running',
      attempts: 2,
      requestedBy: lead._id,
    });

    await recoverOrphans();
    const back = await RenderJob.findById(orphan._id);
    const gone = await RenderJob.findById(hopeless._id);
    check('one that has only been tried once is queued again', back.status === 'queued', back.status);
    check('  and its progress is reset rather than left at 75%', back.progress === 0, String(back.progress));
    check(
      'one that has already been tried twice is abandoned',
      gone.status === 'failed',
      gone.status
    );
    check('  with an explanation a person can act on', /restart/i.test(gone.error ?? ''), gone.error);

    /* Tidied up so the queue below is not doing this one's work. */
    await RenderJob.deleteMany({ _id: { $in: [orphan._id, hopeless._id] } });
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the documents do not accumulate forever:');
  {
    const collected = await RenderJob.findOne({ audit: audit._id, status: 'done' });
    check('there is a finished job with a file', Boolean(collected?.fileId), String(collected?.fileId));

    const bucket = mongoose.connection.db.collection('renderjobs.files');
    const before = await bucket.countDocuments({ _id: collected.fileId });
    await RenderJob.updateOne({ _id: collected._id }, { $set: { expiresAt: new Date(0) } });
    const swept = await sweepExpired();

    check('the sweep takes the expired one', swept >= 1, String(swept));
    check('  the row is gone', !(await RenderJob.findById(collected._id)), 'still there');
    check(
      '  and so is the document, rather than being orphaned in GridFS',
      before === 1 && (await bucket.countDocuments({ _id: collected.fileId })) === 0,
      `${before} before, ${await bucket.countDocuments({ _id: collected.fileId })} after`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe render recorded what was in the report, so two can be compared:');
  let secondRenderId = null;
  {
    const first = await RenderRecord.findOne({ renderId: firstRenderId });
    check('the first render carries a snapshot', Boolean(first?.snapshot), 'none');
    check(
      '  itemised, not one hash',
      (first?.snapshot?.findings ?? []).length === 2,
      String(first?.snapshot?.findings?.length)
    );

    /* Now change the report in four distinguishable ways. */
    const live = await Audit.findById(audit._id);
    live.findings[0].cvssv3 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
    live.findings[0].title = 'Stored cross-site scripting in the search box';
    live.findings.splice(1, 1);
    live.findings.push({
      identifier: 3,
      title: 'Session cookie without Secure',
      cvssv3: VECTOR,
      createdBy: lead._id,
    });
    live.sections[0].text = '<p>Rewritten after the client call.</p>';
    await live.save();

    const asked = await post(`/api/audits/${audit._id}/report/jobs`, session);
    const done = await settle(audit._id, asked.body._id, session);
    check('a second report generates', done.status === 'done', `${done.status}: ${done.error}`);
    secondRenderId = done.renderId;

    const { body } = await get(`/api/renders?audit=${audit._id}`, session);
    const newest = body.renders[0];
    const changes = said(newest.contentChangedSincePrevious);

    check(
      'the newest render says what changed in the report',
      changes.length === 4,
      `${changes.length}: ${changes.join(' | ')}`
    );
    check(
      '  the new finding is listed as added',
      changes.includes('added finding "Session cookie without Secure"'),
      changes.join(' | ')
    );
    check(
      '  the removed one as removed',
      changes.includes('removed finding "Directory listing enabled"'),
      changes.join(' | ')
    );
    check(
      '  and the rescored one names the fields, under its new title',
      changes.some((line) => line.startsWith('changed finding "Stored cross-site scripting') &&
        line.includes('title') && line.includes('score')),
      changes.join(' | ')
    );
    check(
      '  the rewritten section too',
      changes.includes('changed section "Executive summary" (text)'),
      changes.join(' | ')
    );
    check(
      '  and it still reports the production differences separately',
      Array.isArray(newest.changedSincePrevious),
      JSON.stringify(newest.changedSincePrevious)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAny two renders, and one render against the engagement as it stands:');
  {
    const compared = await get(
      `/api/renders/compare?a=${firstRenderId}&b=${secondRenderId}`,
      session
    );
    check('two renders compare', compared.status === 200, `${compared.status} ${compared.text.slice(0, 140)}`);
    check(
      '  in time order whichever way round they were named',
      compared.body?.before?.renderId === firstRenderId,
      compared.body?.before?.renderId
    );
    const backwards = await get(
      `/api/renders/compare?a=${secondRenderId}&b=${firstRenderId}`,
      session
    );
    check(
      '  and naming them the other way gives the same answer',
      JSON.stringify(backwards.body?.contentChanged) === JSON.stringify(compared.body?.contentChanged),
      'the two directions disagree'
    );

    /* Edit without generating — the case that makes "compare with the newest render" wrong. */
    const live = await Audit.findById(audit._id);
    live.findings[0].remediation = '<p>Set HttpOnly and Secure, and encode on output.</p>';
    await live.save();

    const since = await get(`/api/renders/${secondRenderId}/since`, session);
    const changes = said(since.body?.contentChanged);
    check(
      'a render compares against live content, not against the newest render',
      changes.length === 1 && changes[0].includes('remediation'),
      changes.join(' | ')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the register can say what the client has not seen:');
  {
    const recorded = await post(`/api/audits/${audit._id}/deliveries`, session, {
      version: '1.0',
      sentAt: new Date().toISOString(),
      channel: 'email',
      recipients: [{ name: 'Marijke de Vries', email: 'marijke@example.invalid' }],
      filename: 'Northwind Shipment Portal.docx',
      fileHash: firstHash,
      kind: 'docx',
    });
    check('a delivery records', recorded.status === 201 || recorded.status === 200, `${recorded.status} ${recorded.text.slice(0, 160)}`);

    const changes = await get(
      `/api/audits/${audit._id}/deliveries/${recorded.body._id}/changes`,
      session
    );
    check('and it can be asked what has changed', changes.status === 200, String(changes.status));
    check('  the delivered file was matched to its render', changes.body?.comparable === true, changes.body?.why);
    check(
      '  and it is the first render, not the newest',
      changes.body?.renderId === firstRenderId,
      changes.body?.renderId
    );
    const said1 = said(changes.body?.changed);
    check(
      '  listing everything since, including the edit made without generating',
      /* Four, not five: the remediation edit was to a finding that had already changed title and
         score, and one finding is one entry however many of its fields moved. */
      said1.length === 4 && said1.some((line) => line.includes('remediation')),
      `${said1.length}: ${said1.join(' | ')}`
    );

    /* The refusals, which matter as much as the answers. */
    const noHash = await post(`/api/audits/${audit._id}/deliveries`, session, {
      version: '0.9',
      sentAt: new Date().toISOString(),
      channel: 'person',
      recipients: [],
      filename: 'draft.docx',
      kind: 'docx',
    });
    check(
      '  (the no-hash delivery recorded, so the next check tests the endpoint)',
      Boolean(noHash.body?._id),
      `${noHash.status} ${noHash.text.slice(0, 140)}`
    );
    const cannot = await get(
      `/api/audits/${audit._id}/deliveries/${noHash.body._id}/changes`,
      session
    );
    check(
      'a delivery with no hash says it cannot tell, rather than "nothing changed"',
      cannot.body?.comparable === false && /hash/i.test(cannot.body?.why ?? ''),
      JSON.stringify(cannot.body)
    );

    const foreign = await post(`/api/audits/${audit._id}/deliveries`, session, {
      version: '0.8',
      sentAt: new Date().toISOString(),
      channel: 'email',
      recipients: [],
      filename: 'somebody-elses.docx',
      fileHash: crypto.randomBytes(32).toString('hex'),
      kind: 'docx',
    });
    const unknown = await get(
      `/api/audits/${audit._id}/deliveries/${foreign.body._id}/changes`,
      session
    );
    check(
      '  and a file this instance never generated says so',
      unknown.body?.comparable === false && /not generated|before renders/i.test(unknown.body?.why ?? ''),
      JSON.stringify(unknown.body)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe diff refuses to guess:');
  {
    const live = await Audit.findById(audit._id);
    const now = reportSnapshot(live);
    check('two identical snapshots produce no changes', snapshotDifferences(now, now).length === 0, '');
    check('a missing snapshot on either side is null, not empty', snapshotDifferences(null, now) === null, '');
    check(
      '  and so is one from a shape this version does not know',
      snapshotDifferences({ ...now, v: 99 }, now) === null,
      ''
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
