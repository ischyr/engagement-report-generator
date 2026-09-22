/**
 * The scripting API's evidence upload.
 *
 *   npm run test:evidence-api
 *
 * The one thing `/api/v1` could not do: a script could record that nmap ran and what it printed,
 * and could not attach the picture of the admin panel it found. The route file's own header had
 * named it as wanted since the API was written.
 *
 * Run against a real server over real HTTP rather than by calling the handler, because everything
 * this could break is *between* a caller and the handler — multipart parsing, the scope check, the
 * bearer header, the type sniff. A test that imported the function would prove none of them.
 *
 * It lands in the evidence bin rather than in a finding, and that is the shape being asserted as
 * much as the upload: a script captures while the work is happening and has no opinion about which
 * write-up the picture belongs to.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { mintApiToken } from '../services/api-tokens.service.js';
import { auditEvidenceBin } from '../services/media.service.js';
import { encodePng } from '../utils/png.js';
import log from '../utils/logger.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

await connectDatabase();
const app = createApp();
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const made = { audits: [], users: [] };
const shot = path.join(os.tmpdir(), `zz-evidence-${Date.now()}.png`);

/**
 * One multipart upload, as a caller would make it.
 *
 * `type` defaults to what `curl -F "file=@shot.png"` sends, which is the type worked out from the
 * extension. Passing `''` is the other honest shape — a script that sends bytes and says nothing
 * about them — and the route has to accept both.
 */
const upload = async (auditId, token, { bytes, name = 'zz-evidence.png', type = 'image/png' } = {}) => {
  const form = new FormData();
  if (bytes !== null) {
    form.append('file', new Blob([bytes ?? fs.readFileSync(shot)], type ? { type } : {}), name);
  }
  const response = await fetch(`${base}/api/v1/engagements/${auditId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* A non-JSON error page; the status is the useful part. */
  }
  return { status: response.status, body };
};

try {
  await User.deleteOne({ username: 'zz-evidence-api' });
  const user = await User.create({
    username: 'zz-evidence-api',
    email: 'zz-evidence-api@probe.test',
    password: 'Passw0rd!probe',
    role: 'user',
    totpEnrolmentRequired: false,
    approvedAt: new Date(),
  });
  made.users.push(user._id);

  const audit = await Audit.create({ name: 'zz evidence-api probe', creator: user._id });
  const other = await Audit.create({ name: 'zz evidence-api elsewhere', creator: user._id });
  made.audits.push(audit._id, other._id);

  const issue = async (label, scopes, audits) =>
    (await mintApiToken({ owner: user, label, scopes, audits, days: 1 })).token;

  const full = await issue('zz full', ['enumeration:write', 'evidence:write'], [audit._id]);
  const noEvidence = await issue('zz limited', ['enumeration:write'], [audit._id]);
  const elsewhere = await issue('zz elsewhere', ['evidence:write'], [other._id]);

  fs.writeFileSync(shot, encodePng(Buffer.alloc(16 * 16 * 4, 120), 16, 16));

  log.info('A screenshot, from a script:');

  const first = await upload(audit._id, full);
  check('it is accepted', first.status === 201, `${first.status} ${JSON.stringify(first.body)}`);
  check(
    'and comes back with the URL a write-up references it by',
    /^\/api\/media\/[0-9a-f]{24}$/.test(first.body?.evidence?.url ?? ''),
    first.body?.evidence?.url
  );
  check('with its size', first.body?.evidence?.bytes > 0, `${first.body?.evidence?.bytes}`);
  check('and its dimensions', first.body?.evidence?.width === 16, `${first.body?.evidence?.width}`);
  check(
    'a first upload is not reported as a duplicate',
    first.body?.evidence?.deduplicated === false,
    `${first.body?.evidence?.deduplicated}`
  );

  log.info('');
  log.info('Where it lands:');

  const bin = await auditEvidenceBin(audit._id);
  check(
    'in the evidence bin, not in a finding',
    bin.some((row) => String(row.id ?? row._id) === String(first.body.evidence.id)),
    JSON.stringify(bin.map((row) => String(row.id ?? row._id)))
  );
  const stored = await Audit.findById(audit._id);
  check(
    'and nothing was written into the engagement itself',
    (stored.findings ?? []).length === 0,
    `${(stored.findings ?? []).length} finding(s)`
  );

  log.info('');
  log.info('The same bytes again:');

  const again = await upload(audit._id, full);
  check(
    'this engagement is told it already had them',
    again.body?.evidence?.deduplicated === true,
    `${again.body?.evidence?.deduplicated}`
  );
  check(
    'and gets the same object rather than a second copy',
    String(again.body?.evidence?.id) === String(first.body?.evidence?.id)
  );

  /*
   * A different engagement uploading identical bytes must not be told they were already here —
   * that answer is a way to ask whether the instance holds a given file somewhere you cannot see.
   */
  const crossed = await upload(other._id, elsewhere);
  check(
    'another engagement is not told the instance already had them',
    crossed.body?.evidence?.deduplicated === false,
    `${crossed.body?.evidence?.deduplicated}`
  );

  log.info('');
  log.info('What it refuses:');

  const noScope = await upload(audit._id, noEvidence);
  check('a token without the scope', noScope.status === 403, `${noScope.status}`);

  const wrongAudit = await upload(audit._id, elsewhere);
  check(
    'a token issued for a different engagement',
    wrongAudit.status === 403 || wrongAudit.status === 404,
    `${wrongAudit.status}`
  );

  const script = await upload(audit._id, full, {
    bytes: Buffer.from('#!/bin/sh\necho hi\n'),
    name: 'payload.sh',
    type: 'application/x-sh',
  });
  check('a shell script is not evidence', script.status === 400, `${script.status}`);

  /*
   * A script that declares nothing is accepted and then judged on its bytes.
   *
   * Which is the principle this service is built on, and which a filter reading the declared type
   * was quietly contradicting for exactly the callers this endpoint is for.
   */
  const undeclared = await upload(audit._id, full, { type: '', name: 'piped.png' });
  check(
    'bytes with no declared type are sniffed rather than refused',
    undeclared.status === 201,
    `${undeclared.status} ${JSON.stringify(undeclared.body)}`
  );
  const undeclaredScript = await upload(audit._id, full, {
    bytes: Buffer.from('#!/bin/sh\necho hi\n'),
    name: 'piped.sh',
    type: '',
  });
  check(
    'and undeclared bytes that are not an image are still refused',
    undeclaredScript.status === 400,
    `${undeclaredScript.status}`
  );

  /* Announced as a PNG, still a shell script: the content decides, not the header. */
  const disguised = await fetch(`${base}/api/v1/engagements/${audit._id}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${full}` },
    body: (() => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([Buffer.from('#!/bin/sh\necho hi\n')], { type: 'image/png' }),
        'innocent.png'
      );
      return form;
    })(),
  });
  check(
    'and neither is one announced as an image',
    disguised.status === 400,
    `${disguised.status}`
  );

  const empty = await upload(audit._id, full, { bytes: null });
  check('a request with no file says which field to use', empty.status === 400, `${empty.status}`);

  log.info('');
  log.info('And it is advertised:');

  const index = await (
    await fetch(`${base}/api/v1/`, { headers: { Authorization: `Bearer ${full}` } })
  ).json();
  check(
    'the self-describing index lists the route',
    index.endpoints.some((row) => row.path.endsWith('/evidence') && row.method === 'POST'),
    'the index is out of step with the routes'
  );
  check(
    'with the scope it needs',
    index.endpoints.find((row) => row.path.endsWith('/evidence'))?.scope === 'evidence:write'
  );
  check(
    'and the scope is one a token can be issued for',
    index.scopes.some((row) => row.name === 'evidence:write'),
    JSON.stringify(index.scopes.map((row) => row.name))
  );
} finally {
  fs.rmSync(shot, { force: true });
  await Audit.deleteMany({ _id: { $in: made.audits } });
  await User.deleteMany({ _id: { $in: made.users } });
  await mongoose.connection.db
    .collection('media.files')
    .deleteMany({ filename: /^zz-evidence|^innocent|^payload/ })
    .catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
}

log.info('');
log.info(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
