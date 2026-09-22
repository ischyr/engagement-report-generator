/**
 * A second opinion on one finding, and the days nobody logged.
 *
 *   npm run test:opinion
 *
 * Two flows that exist because the app already knew the answer and never asked the question.
 *
 *   180  "can somebody look at this one" — a state on the finding, not a chat message
 *   181  the days you worked on something and never said how long for
 *
 * The failure worth guarding against in 180 is a question that reaches nobody, or reaches
 * everybody when it was addressed to one person. Both leave the app looking like it worked. So
 * most of what is below is about *who is told* and *whose inbox it lands in* rather than about
 * the field being written.
 *
 * And in 181, the failure is a prompt that is wrong: asking somebody to log a day they already
 * logged is how a prompt gets ignored, and then the one that mattered is ignored too.
 */
import mongoose from 'mongoose';

import env from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken } from '../middleware/auth.js';
import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { Company } from '../models/company.model.js';
import { Notification } from '../models/notification.model.js';
import { Activity, ACTIONS } from '../models/activity.model.js';
import { TimeEntry } from '../models/time-entry.model.js';

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

/** A request against the app, as somebody. */
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

const stamp = Date.now();
const makeUser = async (name, roles = ['user']) =>
  User.create({
    username: `zz-${name}-${stamp}`,
    email: `zz-${name}-${stamp}@example.test`,
    password: 'Testing-12345!',
    firstname: name,
    lastname: 'Tester',
    roles,
    approvedAt: new Date(),
  });

const asker = await makeUser('asker');
const reviewer = await makeUser('reviewer');
const bystander = await makeUser('bystander');
const outsider = await makeUser('outsider');

const tokens = new Map(
  [asker, reviewer, bystander, outsider].map((person) => [person, signAccessToken(person)])
);
const as = (person) => tokens.get(person);

const company = await Company.create({ name: `zz-Client-${stamp}` });
const audit = await Audit.create({
  name: `zz-Opinion-${stamp}`,
  company: company._id,
  creator: asker._id,
  collaborators: [reviewer._id, bystander._id],
  findings: [
    { title: 'Session fixation', cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', createdBy: asker._id },
    { title: 'Verbose errors', cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', createdBy: asker._id },
  ],
});
const findingId = String(audit.findings[0]._id);
const base = `/api/audits/${audit._id}/findings/${findingId}/second-opinion`;

/* ------------------------------------------------------------------ asking ------ */

console.log('Asking:');

const openAsk = await call(as(asker), 'POST', base, { question: 'Is 9.8 defensible here?' });
check('anybody on the engagement can ask', openAsk.status === 201, `${openAsk.status} ${openAsk.text?.slice(0, 120)}`);

const afterAsk = await Audit.findById(audit._id);
const stored = afterAsk.findings.id(findingId).secondOpinion;
check('the question is on the finding', stored?.question === 'Is 9.8 defensible here?');
check('and it is outstanding', Boolean(stored?.askedAt) && !stored?.answeredAt);
check('addressed to nobody in particular', !stored?.of);

/* Unaddressed means everybody but the asker — "whoever is free" is half of why anybody asks. */
const told = await Notification.find({ type: 'second-opinion-asked', audit: audit._id }).lean();
check(
  'everybody else on the engagement is told',
  new Set(told.map((n) => String(n.user))).size === 2,
  told.map((n) => String(n.user)).join(',')
);
check(
  'and the asker is not told about their own question',
  !told.some((n) => String(n.user) === String(asker._id))
);
check(
  'somebody who is not on the engagement is not told',
  !told.some((n) => String(n.user) === String(outsider._id))
);
check(
  'the question is in the bell, not just a link to it',
  told[0]?.message?.includes('Is 9.8 defensible here?'),
  told[0]?.message
);

const logged = await Activity.find({ audit: audit._id, action: ACTIONS.OPINION_ASKED }).lean();
check('it is in the engagement log', logged.length === 1);

/* ------------------------------------------------------- asked of one person ---- */

console.log('\nAsked of one person:');

await Notification.deleteMany({ audit: audit._id });
const namedAsk = await call(as(asker), 'POST', base, {
  question: 'Does this match what you saw last year?',
  of: String(reviewer._id),
});
check('it can be aimed at somebody', namedAsk.status === 201, String(namedAsk.status));

const namedTold = await Notification.find({ type: 'second-opinion-asked', audit: audit._id }).lean();
check('only that person is told', namedTold.length === 1, String(namedTold.length));
check('and it is the right one', String(namedTold[0]?.user) === String(reviewer._id));

/* Asking again replaces rather than stacks: there is one thing outstanding or there is nothing. */
const replaced = await Audit.findById(audit._id);
check(
  'asking again replaces the question rather than stacking one',
  replaced.findings.id(findingId).secondOpinion.question ===
    'Does this match what you saw last year?'
);

/* ------------------------------------------------------------------ the inbox --- */

console.log('\nWhose inbox it lands in:');

const reviewerInbox = await call(as(reviewer), 'GET', '/api/inbox');
check(
  'the person it was asked of sees it',
  (reviewerInbox.body?.opinions ?? []).some((row) => String(row.findingId) === findingId),
  JSON.stringify(reviewerInbox.body?.counts)
);
check(
  'and it says it was aimed at them',
  reviewerInbox.body?.opinions?.[0]?.addressed === true
);

const bystanderInbox = await call(as(bystander), 'GET', '/api/inbox');
check(
  'somebody it was not asked of does not see it',
  !(bystanderInbox.body?.opinions ?? []).some((row) => String(row.findingId) === findingId),
  JSON.stringify(bystanderInbox.body?.opinions)
);

const askerInbox = await call(as(asker), 'GET', '/api/inbox');
check(
  'and the asker is not waiting on themselves',
  !(askerInbox.body?.opinions ?? []).some((row) => String(row.findingId) === findingId)
);

/* ---------------------------------------------------------------- answering ----- */

console.log('\nAnswering:');

const answered = await call(as(reviewer), 'PUT', base, {
  answer: 'AC:L is generous — it needs a valid session, so AC:H and it lands at 6.8.',
});
check('the answer is accepted', answered.status === 200, `${answered.status} ${answered.text?.slice(0, 120)}`);
check(
  'and lands as a comment on the finding, where the reasoning belongs',
  (answered.body?.comments ?? []).some((c) => c.body.includes('AC:H and it lands at 6.8')),
  JSON.stringify((answered.body?.comments ?? []).map((c) => c.body?.slice(0, 30)))
);

const settled = await Audit.findById(audit._id);
const closed = settled.findings.id(findingId).secondOpinion;
check('it is no longer outstanding', Boolean(closed.answeredAt));
check('and says who answered', String(closed.answeredBy) === String(reviewer._id));

check(
  'the asker is told somebody answered',
  (await Notification.countDocuments({
    type: 'second-opinion-given',
    user: asker._id,
  })) === 1
);

const goneFromInbox = await call(as(reviewer), 'GET', '/api/inbox');
check(
  'and it leaves the inbox',
  !(goneFromInbox.body?.opinions ?? []).some((row) => String(row.findingId) === findingId)
);

/* Arriving late at a stale inbox row must not overwrite the answer that is already there. */
check(
  'answering something already answered is refused',
  (await call(as(reviewer), 'PUT', base, { answer: 'again' })).status === 400
);
check(
  'and so is answering a finding nobody asked about',
  (
    await call(
      as(reviewer),
      'PUT',
      `/api/audits/${audit._id}/findings/${audit.findings[1]._id}/second-opinion`,
      { answer: 'unasked' }
    )
  ).status === 400
);

/* ------------------------------------------------------------------ withdrawing --- */

console.log('\nTaking it back:');

await call(as(asker), 'POST', base, { question: 'Never mind this one' });
const withdrawn = await call(as(asker), 'PUT', base, {});
check('the asker can withdraw it', withdrawn.body?.withdrawn === true, JSON.stringify(withdrawn.body));
const afterWithdraw = await Audit.findById(audit._id);
check(
  'and it is outstanding on nobody',
  !afterWithdraw.findings.id(findingId).secondOpinion.askedAt
);
check(
  'withdrawing is logged as itself, not as an answer',
  (await Activity.countDocuments({ audit: audit._id, action: ACTIONS.OPINION_WITHDRAWN })) === 1
);

/* Somebody else clearing it without writing anything is an answer, not a withdrawal: they looked. */
await call(as(asker), 'POST', base, { question: 'Sanity check?' });
const shrugged = await call(as(reviewer), 'PUT', base, {});
check(
  'somebody else clearing it counts as having looked',
  shrugged.body?.withdrawn === false,
  JSON.stringify(shrugged.body)
);

/* ------------------------------------------------ the rest of the inbox --------- */

/*
 * The other sections, because narrowing which engagements the inbox reads can drop any of them.
 *
 * Every arm of that query is one section's supply, and an arm quietly removed produces an empty
 * list rather than an error — somebody's review or somebody's checks simply stop arriving, which
 * is the kind of failure nobody reports because it looks like having nothing to do.
 */
console.log('\nThe rest of what is waiting on you:');

/* Re-read: the routes above have saved this engagement a dozen times, so the copy created
   at the top of the file is many versions behind and Mongoose rightly refuses it. */
const fresh = await Audit.findById(audit._id);
/* And with no question outstanding, so the only reason this engagement is read at all is the
   review and the checks — otherwise the opinion arm carries it and dropping either of the others
   would go unnoticed. */
for (const finding of fresh.findings) finding.secondOpinion = undefined;
fresh.reviewers = [reviewer._id];
fresh.state = 'REVIEW';
fresh.testChecks = [
  { title: 'Check the session cookie flags', createdBy: asker._id, assignedTo: reviewer._id },
  { title: 'Someone should try the upload form', createdBy: reviewer._id },
];
await fresh.save();

/*
 * Two more, each qualifying for exactly one reason.
 *
 * The engagement above is both a review and a pile of checks, so removing either reason from the
 * query still leaves it arriving by the other — and a section that empties because its arm was
 * dropped would look identical to a section with nothing in it. One engagement per arm is the only
 * fixture that can tell those apart.
 */
const reviewOnly = await Audit.create({
  name: `zz-ReviewOnly-${stamp}`,
  company: company._id,
  creator: asker._id,
  reviewers: [reviewer._id],
  state: 'REVIEW',
});
const checksOnly = await Audit.create({
  name: `zz-ChecksOnly-${stamp}`,
  company: company._id,
  creator: asker._id,
  collaborators: [reviewer._id],
  testChecks: [{ title: 'Only a check', createdBy: asker._id, assignedTo: reviewer._id }],
});

const full = await call(as(reviewer), 'GET', '/api/inbox');
check(
  'an engagement that is only a review still reaches the inbox',
  (full.body?.reviews ?? []).some((row) => String(row.auditId) === String(reviewOnly._id)),
  JSON.stringify((full.body?.reviews ?? []).map((r) => r.name))
);
check(
  'and one that is only a check does too',
  (full.body?.assigned ?? []).some((row) => row.title === 'Only a check'),
  JSON.stringify((full.body?.assigned ?? []).map((r) => r.title))
);
check(
  'a review you are a reviewer on is listed',
  (full.body?.reviews ?? []).some((row) => String(row.auditId) === String(audit._id)),
  JSON.stringify(full.body?.counts)
);
check(
  'a check somebody gave you is listed',
  (full.body?.assigned ?? []).some((row) => row.title === 'Check the session cookie flags'),
  JSON.stringify(full.body?.assigned)
);
check(
  'and a check you gave out that nobody has done is listed apart from it',
  (full.body?.checks ?? []).some((row) => row.title === 'Someone should try the upload form'),
  JSON.stringify(full.body?.checks)
);
/* The row is built from six projected fields; a missing one shows up as a blank in the list. */
check(
  'a listed check carries the words the page prints',
  (full.body?.assigned ?? []).every((row) => row.title && row.checkId && row.createdAt),
  JSON.stringify(full.body?.assigned)
);

const tidy = await Audit.findById(audit._id);
tidy.state = 'EDIT';
tidy.reviewers = [];
tidy.testChecks = [];
await tidy.save();

/* -------------------------------------------------------- 181: unlogged days ----- */

console.log('\nThe days nobody logged:');

const today = new Date();
const dayString = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

/* The asker has been busy on this engagement all through the checks above, which is exactly the
 * evidence the prompt reads — so there is no fixture to build here beyond asking. */
const gapsBefore = await call(as(asker), 'GET', '/api/time/unlogged');
check('the endpoint answers', gapsBefore.status === 200, String(gapsBefore.status));
check(
  'a day you worked and did not log is reported',
  (gapsBefore.body?.gaps ?? []).some(
    (gap) => String(gap.auditId) === String(audit._id) && gap.day === dayString(today)
  ),
  JSON.stringify(gapsBefore.body?.gaps)
);
check(
  'and it says how much you did, so the busiest day is answerable first',
  (gapsBefore.body?.gaps ?? []).every((gap) => gap.actions > 0)
);

/* Somebody ON the engagement who did nothing is asked nothing — the outsider would prove
 * nothing here, because the engagement is invisible to them anyway. A prompt that fires on an idle week is a prompt
 * people learn to close. */
const idle = await call(as(bystander), 'GET', '/api/time/unlogged');
check('somebody who did nothing is asked nothing', (idle.body?.gaps ?? []).length === 0);

await TimeEntry.create({
  user: asker._id,
  audit: audit._id,
  day: dayString(today),
  hours: 6,
});
const gapsAfter = await call(as(asker), 'GET', '/api/time/unlogged');
check(
  'once the hours are logged it stops asking',
  !(gapsAfter.body?.gaps ?? []).some(
    (gap) => String(gap.auditId) === String(audit._id) && gap.day === dayString(today)
  ),
  JSON.stringify(gapsAfter.body?.gaps)
);

/* ------------------------------------------------------------------- refusals --- */

console.log('\nWho may:');

/* 403 rather than 404: the engagement is visible, the person is simply not on it — which is
 * what `loadAudit` says about every route under `/audits/:id`. */
check(
  'somebody not on the engagement cannot ask about its findings',
  (await call(as(outsider), 'POST', base, { question: 'hello' })).status === 403
);
check(
  'and cannot see the question in their inbox',
  !((await call(as(outsider), 'GET', '/api/inbox')).body?.opinions ?? []).length
);

/* --------------------------------------------------------------------- tidy up --- */

await Audit.deleteMany({ _id: { $in: [audit._id, reviewOnly._id, checksOnly._id] } });
await Company.deleteOne({ _id: company._id });
await Notification.deleteMany({ audit: audit._id });
await Activity.deleteMany({ audit: audit._id });
await TimeEntry.deleteMany({ audit: audit._id });
await User.deleteMany({ _id: { $in: [asker._id, reviewer._id, bystander._id, outsider._id] } });

server.close();
await disconnectDatabase();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
