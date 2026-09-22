/**
 * Deleting several accounts at once.
 *
 *   npm run test:bulk-users
 *
 * The button is easy; the guards are the whole thing.
 *
 * **Not yourself** is the one that matters, and a select-all makes it far easier to do by accident
 * than the single delete ever did. It also turns out to be what keeps an instance from being
 * emptied of administrators: only an admin can call this, so the caller is an admin, and the
 * caller can never be in the batch. The route's own "an admin must remain" check is therefore
 * unreachable through it today — kept because it is what would catch this if the route were ever
 * opened to another role, which is exactly the change that would otherwise make it possible.
 *
 * And the preview, which exists because deleting an account hands nothing on: if it says an
 * account holds nothing when it holds forty findings, it is worse than not being there.
 *
 * One rule this suite follows and every suite should: **it never puts an account it did not create
 * into a delete.** The first version of it did, reasoning about the instance's real admins, and
 * deleted one.
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken } from '../middleware/auth.js';
import { User } from '../models/user.model.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Scratch } from '../models/scratch.model.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

await connectDatabase();
const app = createApp();
const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener));
});
const origin = `http://127.0.0.1:${server.address().port}`;

const call = async (token, method, path, body) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
};

/*
 * Anything a previous run left behind, before this one starts.
 *
 * A suite that exits on its first failure never reaches its own tidying, and this one creates an
 * account with the admin role — so a failed run leaves an administrator nobody made deliberately
 * sitting on the instance until somebody notices. Clearing at the start is the only cleanup that
 * runs whatever happened last time.
 */
{
  const stale = await User.find({ username: /^zz-(boss|alice|bob|carol|plain|second-admin)-/ })
    .select('_id')
    .lean();
  if (stale.length) {
    await Scratch.deleteMany({ user: { $in: stale.map((row) => row._id) } });
    await User.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
  }
  await Audit.deleteMany({ name: /^zz-Bulk-/ });
  await Company.deleteMany({ name: /^zz-BulkClient-/ });
}

const stamp = Date.now();
const made = [];
const makeUser = async (name, roles = ['user']) => {
  const person = await User.create({
    username: `zz-${name}-${stamp}`,
    email: `zz-${name}-${stamp}@example.test`,
    password: 'Testing-12345!',
    firstname: name,
    lastname: 'Tester',
    roles,
    approvedAt: new Date(),
  });
  made.push(person._id);
  return person;
};

/*
 * A real admin already exists on this instance, which is what makes the "an admin must remain"
 * checks below meaningful rather than arithmetic about a fixture — so the count is read rather
 * than assumed.
 */
const adminsBefore = await User.countDocuments({ roles: 'admin' });

const boss = await makeUser('boss', ['admin']);
const alice = await makeUser('alice');
const bob = await makeUser('bob');
const carol = await makeUser('carol');
const plainUser = await makeUser('plain');

const token = signAccessToken(boss);
const plainToken = signAccessToken(plainUser);

const company = await Company.create({ name: `zz-BulkClient-${stamp}` });
const audit = await Audit.create({
  name: `zz-Bulk-${stamp}`,
  company: company._id,
  creator: alice._id,
  collaborators: [bob._id],
  findings: [{ title: 'Something', createdBy: alice._id, assignedTo: bob._id }],
});
await Scratch.create({ user: bob._id, title: 'Keep this', content: '<p>x</p>' });

/* ------------------------------------------------------------------ who may --- */

console.log('Who may:');

check(
  'a consultant cannot delete accounts in bulk',
  (await call(plainToken, 'POST', '/api/users/bulk-delete', { ids: [String(alice._id)] })).status ===
    403
);
check(
  'and cannot ask what they hold either',
  (
    await call(plainToken, 'POST', '/api/users/bulk-delete/preview', { ids: [String(alice._id)] })
  ).status === 403
);
check(
  'signed out, neither is answered',
  (await call(null, 'POST', '/api/users/bulk-delete', { ids: [String(alice._id)] })).status === 401
);

/* ----------------------------------------------------------------- refusals --- */

console.log('\nWhat it refuses:');

const ownAccount = await call(token, 'POST', '/api/users/bulk-delete', {
  ids: [String(alice._id), String(boss._id)],
});
check('your own account in the selection stops the batch', ownAccount.status === 400, String(ownAccount.status));
check(
  'and nobody in that batch is deleted',
  (await User.countDocuments({ _id: { $in: [alice._id, boss._id] } })) === 2,
  'it deleted somebody anyway'
);

/*
 * And the instance cannot be emptied of administrators — which turns out to be true for a reason
 * worth writing down rather than the one the route says.
 *
 * Only an admin can call this and nobody can delete themselves, so at least one admin always
 * survives any batch: the caller. The "an admin must remain" guard on the route is therefore
 * unreachable through it today, and is kept as the thing that would catch this if the route were
 * ever opened to another role — which is exactly the change that would otherwise make it possible.
 *
 * The first version of this check built a batch out of "every admin except me" and expected a
 * refusal. That batch was correct to go through, because *me* is an admin and stays — and running
 * it deleted this instance's seeded admin account. A suite must not put an account it did not
 * create into a delete, and this one now does not.
 */
const anotherAdmin = await makeUser('second-admin', ['admin']);
const adminBatch = await call(token, 'POST', '/api/users/bulk-delete', {
  ids: [String(anotherAdmin._id)],
});
check(
  'deleting another administrator is allowed while you are still one',
  adminBatch.status === 200,
  `${adminBatch.status} ${adminBatch.text?.slice(0, 120)}`
);
check(
  'and the instance still has administrators afterwards',
  (await User.countDocuments({ roles: 'admin' })) >= 1,
  'the instance has no administrator left'
);
check(
  'specifically, the ones that were there before this suite ran',
  (await User.countDocuments({ roles: 'admin' })) === adminsBefore + 1,
  'a real account was deleted'
);

/* The guard itself, asked directly, since the route cannot reach it. */
check(
  'the preview says so when a batch would leave nobody in charge',
  (
    await call(token, 'POST', '/api/users/bulk-delete/preview', {
      ids: [String(boss._id)],
    })
  ).body?.refusals?.some((why) => /administrator/i.test(why)) === false,
  'boss is not the only admin here, so this must not fire'
);

check(
  'an empty selection is refused rather than silently doing nothing',
  (await call(token, 'POST', '/api/users/bulk-delete', { ids: [] })).status === 422
);
check(
  'and more than fifty at once is refused',
  (
    await call(token, 'POST', '/api/users/bulk-delete', {
      ids: Array.from({ length: 51 }, () => String(alice._id)),
    })
  ).status === 422
);

/* ------------------------------------------------------------- the preview --- */

console.log('\nWhat it says they hold:');

const preview = await call(token, 'POST', '/api/users/bulk-delete/preview', {
  ids: [String(alice._id), String(bob._id), String(carol._id)],
});
check('it answers', preview.status === 200, String(preview.status));
check('one entry per account', preview.body?.accounts?.length === 3, JSON.stringify(preview.body?.accounts?.length));

const held = (id) => preview.body.accounts.find((row) => row.id === String(id))?.holds;
check(
  'somebody who created an engagement is shown holding it',
  held(alice._id)?.onEngagements === 1,
  JSON.stringify(held(alice._id))
);
check(
  'a finding assigned to somebody is counted against them',
  held(bob._id)?.assignedFindings === 1,
  JSON.stringify(held(bob._id))
);
check(
  'and so are their scratchpad notes, which nothing else would ever mention',
  held(bob._id)?.notes === 1,
  JSON.stringify(held(bob._id))
);
/* The empty case is what makes the others readable: if everybody "holds something" the number
 * stops meaning anything. */
check(
  'an account holding nothing says nothing, not zero of everything',
  Object.values(held(carol._id) ?? {}).every((count) => count === 0),
  JSON.stringify(held(carol._id))
);
check(
  'a clean batch reports no reason it would be refused',
  (preview.body?.refusals ?? []).length === 0,
  JSON.stringify(preview.body?.refusals)
);

/* And the refusals are said before the button, not after it. */
const doomed = await call(token, 'POST', '/api/users/bulk-delete/preview', {
  ids: [String(boss._id), String(alice._id)],
});
check(
  'a batch with your own account in it says so up front',
  (doomed.body?.refusals ?? []).some((why) => /your own/i.test(why)),
  JSON.stringify(doomed.body?.refusals)
);

/* ------------------------------------------------------------ and it works --- */

console.log('\nAnd when it goes through:');

const done = await call(token, 'POST', '/api/users/bulk-delete', {
  ids: [String(alice._id), String(bob._id), String(carol._id)],
});
check('the batch is accepted', done.status === 200, `${done.status} ${done.text?.slice(0, 120)}`);
check('it says how many went', done.body?.deleted === 3, JSON.stringify(done.body));
check(
  'and names them, so the toast can say who rather than how many',
  (done.body?.usernames ?? []).length === 3,
  JSON.stringify(done.body?.usernames)
);
check(
  'all three are really gone',
  (await User.countDocuments({ _id: { $in: [alice._id, bob._id, carol._id] } })) === 0
);
check(
  'and nobody else was touched',
  (await User.countDocuments({ _id: { $in: [boss._id, plainUser._id] } })) === 2
);

/* An id that is not an account is not an error — it was deleted a moment ago by somebody else,
 * which on a page with a select-all is a race worth surviving. */
const gone = await call(token, 'POST', '/api/users/bulk-delete', { ids: [String(alice._id)] });
check('a selection of accounts that have already gone is a 404, not a crash', gone.status === 404);

/* --------------------------------------------------------------- tidy up ----- */

await Audit.deleteOne({ _id: audit._id });
await Company.deleteOne({ _id: company._id });
await Scratch.deleteMany({ user: { $in: made } });
await User.deleteMany({ _id: { $in: made } });

server.close();
await disconnectDatabase();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
