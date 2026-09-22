/**
 * What the Clients & data page is told about itself.
 *
 *   npm run test:data-summary
 *
 * Two things this can get wrong, and both look like working:
 *
 *   - **scope.** A count is a way of asking a question, and "how many clients does this firm have"
 *     is one a consultant with two engagements is not entitled to ask. The list endpoints are
 *     scoped; a summary that counted everything would leak the answer the scoping exists to keep.
 *   - **the gaps.** The rail marks a collection as having something missing, and the page filters
 *     to exactly those rows. If the count and the filter disagree, the filter hides a row the
 *     count promised — which reads as the page being broken rather than the data being fine.
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken } from '../middleware/auth.js';
import { User } from '../models/user.model.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Client } from '../models/client.model.js';

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

const call = async (token, path) => {
  const response = await fetch(`${origin}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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

/* Anything a previous run left behind. A suite that exits on a failure never reaches its own
   tidying, so clearing at the start is the cleanup that always runs. */
await Client.deleteMany({ lastname: /^zz-Summary/ });
await Audit.deleteMany({ name: /^zz-Summary-/ });
await Company.deleteMany({ name: /^zz-Summary/ });
await User.deleteMany({ username: /^zz-summary-/ });

const stamp = Date.now();
const makeUser = async (name, roles = ['user']) =>
  User.create({
    username: `zz-summary-${name}-${stamp}`,
    email: `zz-summary-${name}-${stamp}@example.test`,
    password: 'Testing-12345!',
    firstname: name,
    lastname: 'Tester',
    roles,
    approvedAt: new Date(),
  });

const admin = await makeUser('admin', ['admin']);
const insider = await makeUser('insider');
const outsider = await makeUser('outsider');

/* Two clients: one with a contact and an engagement, one with neither. */
const withContact = await Company.create({ name: `zz-Summary Full ${stamp}` });
const bare = await Company.create({ name: `zz-Summary Bare ${stamp}` });

await Client.create({
  company: withContact._id,
  firstname: 'Reachable',
  lastname: `zz-Summary-${stamp}`,
  email: 'reachable@example.test',
});
/* A contact belonging to nobody, which is the gap that can actually happen — the email field is
   required and unique, so 'no email' is a state the data model forbids. */
const orphanContact = await Client.create({
  firstname: 'Orphan',
  lastname: `zz-Summary-${stamp}`,
  email: `zz-summary-orphan-${stamp}@example.test`,
  createdBy: admin._id,
});

const audit = await Audit.create({
  name: `zz-Summary-${stamp}`,
  company: withContact._id,
  creator: insider._id,
});

/* ----------------------------------------------------------------- the counts --- */

console.log('What it counts:');

const asAdmin = await call(signAccessToken(admin), '/api/data/summary');
check('it answers', asAdmin.status === 200, String(asAdmin.status));

const counts = asAdmin.body?.counts ?? {};
check(
  'every collection on the page has a count',
  [
    'companies',
    'clients',
    'audit-types',
    'sections',
    'vulnerability-types',
    'vulnerability-categories',
    'languages',
    'custom-fields',
  ].every((key) => Number.isFinite(counts[key])),
  JSON.stringify(counts)
);
check(
  'the clients it created are in the count',
  counts.companies >= 2,
  String(counts.companies)
);

const per = asAdmin.body?.perCompany ?? {};
check(
  'a client with an engagement is shown holding one',
  per[String(withContact._id)]?.engagements === 1,
  JSON.stringify(per[String(withContact._id)])
);
check(
  'and the contacts on it are counted too',
  per[String(withContact._id)]?.contacts === 1,
  JSON.stringify(per[String(withContact._id)])
);
check(
  'a client with nothing is reported as having nothing, not left out',
  per[String(bare._id)]?.engagements === 0 && per[String(bare._id)]?.contacts === 0,
  JSON.stringify(per[String(bare._id)])
);

/* ------------------------------------------------------------------ the gaps --- */

console.log('\nWhat it says is missing:');

check(
  'a client with no contact is counted as a gap',
  (asAdmin.body?.gaps?.companies?.count ?? 0) >= 1,
  JSON.stringify(asAdmin.body?.gaps?.companies)
);
check(
  'and a contact attached to no client is counted as one too',
  (asAdmin.body?.gaps?.clients?.count ?? 0) >= 1,
  JSON.stringify(asAdmin.body?.gaps?.clients)
);
check(
  'each gap says what it is, so the page need not invent the words',
  /contact/i.test(asAdmin.body?.gaps?.companies?.label ?? '') &&
    /client/i.test(asAdmin.body?.gaps?.clients?.label ?? ''),
  JSON.stringify(asAdmin.body?.gaps)
);

/*
 * The count and the page's filter have to mean the same thing, or the filter hides a row the count
 * promised. The page calls a company a gap when `perCompany[...].contacts` is zero — so that is
 * asserted here against the same numbers rather than against the fixture.
 */
const gapsByRule = Object.values(per).filter((row) => row.contacts === 0).length;
check(
  'the gap count agrees with the rule the page filters by',
  gapsByRule === asAdmin.body.gaps.companies.count,
  `${gapsByRule} by the rule, ${asAdmin.body.gaps.companies.count} reported`
);

/* ----------------------------------------------------------------- the scope --- */

console.log('\nWho is allowed to know:');

const asOutsider = await call(signAccessToken(outsider), '/api/data/summary');
check('somebody with no engagements is answered', asOutsider.status === 200);
check(
  'but is not told how many clients the firm has',
  (asOutsider.body?.counts?.companies ?? 0) < counts.companies,
  `${asOutsider.body?.counts?.companies} vs ${counts.companies}`
);
/* Contacts are scoped separately from companies — by `visibleClientFilter`, which also lets
 * somebody see one they created themselves — so the contact count needs its own check. Without it,
 * dropping the scope from that query went unnoticed. */
check(
  'nor how many contacts the firm has',
  (asOutsider.body?.counts?.clients ?? 0) < counts.clients,
  `${asOutsider.body?.counts?.clients} vs ${counts.clients}`
);
check(
  'and sees no per-client numbers for a client they cannot open',
  !asOutsider.body?.perCompany?.[String(withContact._id)],
  JSON.stringify(asOutsider.body?.perCompany)
);

const asInsider = await call(signAccessToken(insider), '/api/data/summary');
check(
  'somebody on an engagement sees that client',
  Boolean(asInsider.body?.perCompany?.[String(withContact._id)]),
  JSON.stringify(Object.keys(asInsider.body?.perCompany ?? {}))
);
check(
  'the taxonomies are the same for everybody — they are not anybody’s secret',
  asInsider.body?.counts?.languages === counts.languages
);
check('signed out, it is not answered at all', (await call(null, '/api/data/summary')).status === 401);

/* --------------------------------------------------------------- tidy up ------ */

await Client.deleteMany({ lastname: /^zz-Summary/ });
await Audit.deleteOne({ _id: audit._id });
await Company.deleteMany({ _id: { $in: [withContact._id, bare._id] } });
await User.deleteMany({ _id: { $in: [admin._id, insider._id, outsider._id] } });
void orphanContact;

server.close();
await disconnectDatabase();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
