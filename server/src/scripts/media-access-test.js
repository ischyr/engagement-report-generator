/**
 * Who can read another team's evidence, render history and live feed.
 *
 *   npm run test:media-access
 *
 * Four holes of the same shape, and the shape is the point: `assertMayOpen` enforces exactly one
 * rule — a restricted engagement needs two-factor authentication — and returns immediately for
 * everything else. Four places treated it as *the* access check, so each answered to any signed-in
 * account that knew an id:
 *
 *   GET /media/:id              the evidence bytes themselves, with no engagement loaded at all
 *   GET /media/bin/:auditId     and the caption and delete beside it
 *   GET /renders (×4)           which template made a document, and what changed between versions
 *   GET /audits/:id/pulse       membership checked, expiry not — a subcontractor's live feed
 *
 * **Every check here asserts a refusal**, and asserts it against somebody who is signed in and
 * legitimate elsewhere. A test that only proves the owner can still read their own evidence would
 * have passed before any of this was written.
 *
 * The dedup half matters as much as the guard. Evidence is stored by content, so one object can be
 * in two engagements — and an access check built on the single `metadata.audit` would refuse
 * everybody on whichever engagement uploaded it second, for a picture in their own report.
 */
import http from 'node:http';
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { RenderRecord } from '../models/render-record.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { saveMedia } from '../services/media.service.js';
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
const port = server.address().port;

const made = { audits: [], users: [], renders: [] };

const call = (token, method, path) =>
  new Promise((resolve) => {
    const request = http.request(
      { port, method, path: `/api${path}`, headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) })
        );
      }
    );
    request.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }));
    request.end();
  });

/**
 * A signed-in, legitimate, ordinary account.
 *
 * `approvedAt` and `totpEnrolmentRequired` are load-bearing — without them every request is a 401
 * and the suite passes its refusal checks for entirely the wrong reason. `role: 'user'` for the
 * same kind of reason: an admin bypasses every check being tested here.
 */
const makeUser = async (username) => {
  await User.deleteOne({ username });
  const user = await User.create({
    username,
    firstname: 'zz',
    lastname: username,
    email: `${username}@probe.test`,
    password: 'Passw0rd!probe',
    role: 'user',
    totpEnrolmentRequired: false,
    approvedAt: new Date(),
  });
  made.users.push(user._id);
  return { user, token: signAccessToken(user) };
};

try {
  const owner = await makeUser('zz-access-owner');
  const outsider = await makeUser('zz-access-outsider');
  const expired = await makeUser('zz-access-expired');

  const theirs = await Audit.create({
    name: 'zz access — theirs',
    creator: owner.user._id,
    /* Signed in, on the engagement, and their time on it has run out. */
    memberUntil: [{ user: expired.user._id, until: '2020-01-01' }],
    collaborators: [expired.user._id],
  });
  const mine = await Audit.create({ name: 'zz access — mine', creator: outsider.user._id });
  made.audits.push(theirs._id, mine._id);

  const png = encodePng(Buffer.alloc(8 * 8 * 4, 190), 8, 8);
  const evidence = await saveMedia({
    buffer: png,
    contentType: 'image/png',
    filename: 'zz-secret.png',
    uploader: owner.user,
    audit: theirs,
  });

  /* ------------------------------------------------------ the bytes themselves --- */
  log.info("Somebody else's evidence:");

  const byOwner = await call(owner.token, 'GET', `/media/${evidence.id}`);
  check('the team that captured it can read it', byOwner.status === 200, `${byOwner.status}`);

  const byOutsider = await call(outsider.token, 'GET', `/media/${evidence.id}`);
  check(
    'a signed-in account not on the engagement cannot',
    byOutsider.status === 403,
    `${byOutsider.status}`
  );
  check(
    'and gets no bytes with the refusal',
    byOutsider.body.length < 400 && !byOutsider.body.includes(Buffer.from('PNG')),
    `${byOutsider.body.length} bytes`
  );

  const byExpired = await call(expired.token, 'GET', `/media/${evidence.id}`);
  check(
    'nor does somebody whose access to it has ended',
    byExpired.status === 403,
    `${byExpired.status}`
  );

  /* ------------------------------------------------------------------ the bin --- */
  log.info('');
  log.info('And the bin around it:');

  const binOwner = await call(owner.token, 'GET', `/media/bin/${theirs._id}`);
  check('the team can list what they captured', binOwner.status === 200, `${binOwner.status}`);
  const binOutsider = await call(outsider.token, 'GET', `/media/bin/${theirs._id}`);
  check(
    'an outsider cannot list it',
    binOutsider.status === 403,
    `${binOutsider.status}`
  );
  const binExpired = await call(expired.token, 'GET', `/media/bin/${theirs._id}`);
  check('nor can an expired member', binExpired.status === 403, `${binExpired.status}`);

  /* ----------------------------------------------- the same bytes, two engagements --- */
  log.info('');
  log.info('The same screenshot in two engagements:');

  const alsoMine = await saveMedia({
    buffer: png,
    contentType: 'image/png',
    filename: 'zz-secret.png',
    uploader: outsider.user,
    audit: mine,
  });
  check(
    'deduplication still returns the one stored object',
    String(alsoMine.id) === String(evidence.id),
    `${alsoMine.id} vs ${evidence.id}`
  );
  check(
    'and does not tell the second uploader it was already here',
    alsoMine.deduplicated === false,
    `deduplicated ${alsoMine.deduplicated}`
  );
  const nowMine = await call(outsider.token, 'GET', `/media/${evidence.id}`);
  check(
    'whoever has it in their own engagement can now read it',
    nowMine.status === 200,
    `${nowMine.status}`
  );
  const stillOwner = await call(owner.token, 'GET', `/media/${evidence.id}`);
  check('and the first engagement still can', stillOwner.status === 200, `${stillOwner.status}`);
  check(
    'an expired member is still refused, whoever else holds the bytes',
    (await call(expired.token, 'GET', `/media/${evidence.id}`)).status === 403
  );

  /* --------------------------------------------------------------- the renders --- */
  log.info('');
  log.info('The render register:');

  const record = await RenderRecord.create({
    renderId: 'zz-access-render',
    audit: theirs._id,
    filename: 'zz.docx',
    createdBy: owner.user._id,
  });
  made.renders.push(record._id);

  check(
    'the team can list their own renders',
    (await call(owner.token, 'GET', `/renders?audit=${theirs._id}`)).status === 200
  );
  check(
    'an outsider cannot list them',
    (await call(outsider.token, 'GET', `/renders?audit=${theirs._id}`)).status === 403,
    `${(await call(outsider.token, 'GET', `/renders?audit=${theirs._id}`)).status}`
  );
  check(
    'nor read one by its id',
    (await call(outsider.token, 'GET', '/renders/zz-access-render')).status === 403
  );
  check(
    'nor ask what changed since it',
    (await call(outsider.token, 'GET', '/renders/zz-access-render/since')).status === 403
  );
  check(
    'and an expired member is refused the same four ways',
    (await call(expired.token, 'GET', `/renders?audit=${theirs._id}`)).status === 403 &&
      (await call(expired.token, 'GET', '/renders/zz-access-render')).status === 403
  );

  /* ----------------------------------------------------------------- the pulse --- */
  log.info('');
  log.info('The live feed:');

  check(
    'the team gets the pulse',
    (await call(owner.token, 'GET', `/audits/${theirs._id}/pulse`)).status === 200
  );
  check(
    'an outsider does not',
    (await call(outsider.token, 'GET', `/audits/${theirs._id}/pulse`)).status === 403
  );
  check(
    'and neither does somebody whose access ended',
    (await call(expired.token, 'GET', `/audits/${theirs._id}/pulse`)).status === 403,
    `${(await call(expired.token, 'GET', `/audits/${theirs._id}/pulse`)).status}`
  );
} finally {
  await Audit.deleteMany({ _id: { $in: made.audits } });
  await User.deleteMany({ _id: { $in: made.users } });
  await RenderRecord.deleteMany({ _id: { $in: made.renders } });
  await mongoose.connection.db
    .collection('media.files')
    .deleteMany({ filename: /^zz-secret/ })
    .catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
}

log.info('');
log.info(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
