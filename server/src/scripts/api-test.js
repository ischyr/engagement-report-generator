/**
 * The versioned API, driven over a socket the way a script would drive it.
 *
 *   npm run test:api
 *
 * Through `createApp()` and real HTTP rather than by calling the services, because almost
 * everything worth asserting here is a property of the *edge*: which credential a route accepts,
 * which scope it demands, whether a field that should never be published is published anyway.
 * Calling `v1Finding()` directly would prove none of that — it would prove that the function I
 * wrote does what I wrote it to do.
 *
 * The assertions are shaped as the promises the API makes, so a failure names a broken promise
 * rather than a changed line:
 *
 *   - a token reaches /api/v1 and nothing else; a session reaches everything else and not /api/v1
 *   - a token cannot outgrow its owner, its scopes, or the engagements it names
 *   - restricted engagements are not reachable by automation at all
 *   - no response carries a field v1 did not promise — checked against the documents, not a list
 *   - the secret exists in exactly one response and is unrecoverable afterwards
 *
 * Its own scratch database, dropped at the end.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
import { ApiToken, TOKEN_PREFIX, hashToken } from '../models/api-token.model.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { mintApiToken } from '../services/api-tokens.service.js';
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

const uri = `mongodb://127.0.0.1:27017/engy-api-test-${Date.now()}`;
await mongoose.connect(uri);

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** One request, with the status and the parsed body — both, because both get asserted. */
async function call(method, path, { token, session, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers.Authorization = `Bearer ${session}`;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'api-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ines@example.invalid',
    password: 'ApiTestPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const outsider = await User.create({
    username: 'api-outsider',
    email: 'outsider@example.invalid',
    password: 'ApiTestPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const boss = await User.create({
    username: 'api-admin',
    email: 'boss@example.invalid',
    password: 'ApiTestPass123!',
    role: 'admin',
    roles: ['admin'],
    enabled: true,
    approvedAt: new Date(),
  });

  const company = await Company.create({ name: 'Northwind Logistics', createdBy: lead._id });

  const audit = await Audit.create({
    name: 'Northwind Shipment Portal',
    reference: 'PT-2026-041',
    company: company._id,
    creator: lead._id,
    collaborators: [lead._id],
    state: 'EDIT',
    findings: [
      {
        identifier: 1,
        title: 'Shipment documents readable without authentication',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
        /* Internal by design — the assertions below check none of this is published. */
        tags: ['internal-only'],
        comments: [{ author: lead._id, body: 'Ask Marijke whether this is the live bucket.' }],
        clientClaim: { status: 'fixed', note: 'We rotated the keys.', at: new Date() },
      },
    ],
  });

  /* A second engagement the lead is on, to prove a bound token cannot reach it. */
  const other = await Audit.create({
    name: 'Northwind Payments',
    reference: 'PT-2026-042',
    company: company._id,
    creator: lead._id,
    collaborators: [lead._id],
    state: 'EDIT',
  });

  /* And one nobody's token may touch. */
  const secret = await Audit.create({
    name: 'Northwind Board Systems',
    reference: 'PT-2026-043',
    company: company._id,
    creator: lead._id,
    collaborators: [lead._id],
    classification: 'restricted',
    state: 'EDIT',
  });

  const { token: readToken } = await mintApiToken({
    owner: lead,
    label: 'CI read',
    scopes: ['engagements:read', 'findings:read', 'enumeration:read'],
    audits: [audit._id],
    days: 30,
  });
  const { token: writeToken } = await mintApiToken({
    owner: lead,
    label: 'Scanner',
    scopes: ['findings:write', 'enumeration:write', 'findings:read'],
    audits: [audit._id],
    days: 30,
  });
  const { token: wideToken } = await mintApiToken({
    owner: lead,
    label: 'Everything the lead is on',
    scopes: ['engagements:read'],
    audits: [],
    days: 30,
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nThe two credentials do not swap places:');
  {
    const session = signAccessToken(lead);

    const withSession = await call('GET', '/api/v1/engagements', { session });
    check('a browser session is refused by /api/v1', withSession.status === 401, withSession.status);
    check(
      'and told which credential it wanted',
      /API token/i.test(withSession.body?.error ?? ''),
      withSession.body?.error
    );

    const withToken = await call('GET', '/api/audits', { token: readToken });
    check("an API token is refused by the app's own routes", withToken.status === 401, withToken.status);
    check(
      'and is told where it does work',
      /\/api\/v1/.test(withToken.body?.error ?? ''),
      withToken.body?.error
    );

    const nonsense = await call('GET', '/api/v1/engagements', { token: 'not-a-token-at-all' });
    check('an unrecognisable string is refused', nonsense.status === 401, nonsense.status);
    check(
      'and told what a token looks like',
      (nonsense.body?.error ?? '').includes(TOKEN_PREFIX),
      nonsense.body?.error
    );

    const none = await call('GET', '/api/v1/engagements');
    check('no credential at all is refused', none.status === 401, none.status);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA token says what it is:');
  {
    const { status, body } = await call('GET', '/api/v1/whoami', { token: readToken });
    check('whoami answers without any scope', status === 200, status);
    check('names the token', body?.token?.label === 'CI read', body?.token?.label);
    check('names who it acts as', body?.actingAs?.username === 'api-lead', body?.actingAs?.username);
    check('says how long it has', Boolean(body?.token?.expiresAt), body?.token?.expiresAt);
    check(
      'and never carries the secret',
      !JSON.stringify(body).includes(TOKEN_PREFIX.slice(0, 4) + 'x') &&
        !/[A-Za-z0-9_-]{40}/.test(JSON.stringify(body ?? {})),
      'something 40 characters long came back'
    );

    const index = await call('GET', '/api/v1', { token: readToken });
    check('the root lists the endpoints', (index.body?.endpoints ?? []).length >= 8);
    check('and says which version it is', index.body?.version === 'v1', index.body?.version);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nScopes are demanded per route:');
  {
    const write = await call('POST', `/api/v1/engagements/${audit._id}/findings`, {
      token: readToken,
      body: { title: 'Should never exist' },
    });
    check('a read token cannot write a finding', write.status === 403, write.status);
    check(
      'and is told which scope it lacks',
      (write.body?.error ?? '').includes('findings:write'),
      write.body?.error
    );

    const read = await call('GET', `/api/v1/engagements/${audit._id}`, { token: writeToken });
    check(
      'a token without engagements:read cannot read the engagement',
      read.status === 403,
      read.status
    );

    const steps = await call('GET', `/api/v1/engagements/${audit._id}/enumeration`, {
      token: writeToken,
    });
    check(
      'and enumeration:write does not confer enumeration:read',
      steps.status === 403,
      steps.status
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA token cannot reach past what it names:');
  {
    const bound = await call('GET', `/api/v1/engagements/${other._id}`, { token: readToken });
    check('an engagement the token does not name is refused', bound.status === 403, bound.status);
    check(
      'and says so rather than pretending it is missing',
      /not for that engagement/i.test(bound.body?.error ?? ''),
      bound.body?.error
    );

    const list = await call('GET', '/api/v1/engagements', { token: readToken });
    check('the list holds only the named engagement', list.body?.total === 1, list.body?.total);
    check(
      'and it is the right one',
      list.body?.engagements?.[0]?.reference === 'PT-2026-041',
      list.body?.engagements?.[0]?.reference
    );

    const wide = await call('GET', '/api/v1/engagements', { token: wideToken });
    check(
      'a token naming no engagements sees the ones its owner is on',
      wide.body?.total === 2,
      `${wide.body?.total} — restricted work must not be among them`
    );
    check(
      'and the restricted one is not among them',
      !(wide.body?.engagements ?? []).some((row) => row.reference === 'PT-2026-043'),
      JSON.stringify(wide.body?.engagements?.map((row) => row.reference))
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nRestricted work is not reachable by a script at all:');
  {
    const direct = await call('GET', `/api/v1/engagements/${secret._id}`, { token: wideToken });
    check('asking for it directly is refused', direct.status === 403, direct.status);
    check(
      'and the reason names two-factor authentication',
      /two-factor/i.test(direct.body?.error ?? ''),
      direct.body?.error
    );

    /*
     * The point of this one: the lead *can* open that engagement in the browser if they have
     * paired an authenticator. The refusal is about the credential, not the person — so a token
     * of theirs is refused whether or not they have.
     */
    await User.updateOne({ _id: lead._id }, { $set: { totpEnabled: true } });
    const withTotp = await call('GET', `/api/v1/engagements/${secret._id}`, { token: wideToken });
    check('even when its owner has an authenticator paired', withTotp.status === 403, withTotp.status);
    await User.updateOne({ _id: lead._id }, { $set: { totpEnabled: false } });
  }

  /* ------------------------------------------------------------------------ */
  console.log("\nAn admin's token does not inherit the whole instance:");
  {
    const { token } = await mintApiToken({
      owner: boss,
      label: "The boss's token",
      scopes: ['engagements:read'],
      audits: [],
      days: 30,
    });
    const list = await call('GET', '/api/v1/engagements', { token });
    check('it reaches nothing it was not put on', list.body?.total === 0, list.body?.total);

    const one = await call('GET', `/api/v1/engagements/${audit._id}`, { token });
    check('nor one engagement by id', one.status === 403, one.status);
    check(
      'and the reason is membership, not the scope',
      /not on that engagement/i.test(one.body?.error ?? ''),
      one.body?.error
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log("\nA token cannot outlive its owner's access:");
  {
    const { token } = await mintApiToken({
      owner: outsider,
      label: "An outsider's token",
      scopes: ['engagements:read'],
      audits: [],
      days: 30,
    });
    const before = await call('GET', `/api/v1/engagements/${audit._id}`, { token });
    check('somebody not on the engagement is refused', before.status === 403, before.status);

    /* Now put them on it, and the same token starts working — access is read live, not baked in. */
    await Audit.updateOne({ _id: audit._id }, { $addToSet: { collaborators: outsider._id } });
    const during = await call('GET', `/api/v1/engagements/${audit._id}`, { token });
    check('adding them to it makes the same token work', during.status === 200, during.status);

    /* And taking them off stops it again, with no token change. */
    await Audit.updateOne({ _id: audit._id }, { $pull: { collaborators: outsider._id } });
    const after = await call('GET', `/api/v1/engagements/${audit._id}`, { token });
    check('and taking them off stops it', after.status === 403, after.status);

    /* A disabled account's tokens stop working, which is the lever an admin actually has. */
    await User.updateOne({ _id: outsider._id }, { $set: { enabled: false } });
    const disabled = await call('GET', '/api/v1/engagements', { token });
    check('disabling the account stops its tokens', disabled.status === 401, disabled.status);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWhat a read publishes, and what it does not:');
  {
    const { status, body } = await call('GET', `/api/v1/engagements/${audit._id}/findings`, {
      token: readToken,
    });
    check('the findings come back', status === 200 && body?.findings?.length === 1, status);

    const finding = body.findings[0];
    check('with the severity computed from the vector', finding.severity === 'High', finding.severity);
    check('and the identifier the report prints', finding.identifier === 1, finding.identifier);

    /*
     * The assertion this file exists for.
     *
     * Not "these three fields are absent" — that list would go stale the moment somebody adds a
     * fourth internal field, which is exactly how a leak happens. Instead: every key on the stored
     * document that v1 has not agreed to publish must be missing from the response. A new internal
     * field is caught by this without anybody remembering to add it.
     */
    const detail = await call('GET', `/api/v1/engagements/${audit._id}/findings/${finding.id}`, {
      token: readToken,
    });
    const PROMISED = new Set([
      'id',
      'identifier',
      'title',
      'type',
      'category',
      'severity',
      'cvss',
      'overridden',
      'overrideReason',
      'remediationStatus',
      'assignedTo',
      'description',
      'observation',
      'remediation',
      'poc',
      'scope',
      'references',
      'priority',
      'remediationComplexity',
      'createdAt',
      'updatedAt',
    ]);
    const published = Object.keys(detail.body?.finding ?? {});
    const unpromised = published.filter((key) => !PROMISED.has(key));
    check(
      'a finding publishes only the fields v1 promised',
      unpromised.length === 0,
      `unpromised: ${unpromised.join(', ')}`
    );

    const serialised = JSON.stringify(detail.body);
    check(
      'so the internal comment is not in it',
      !serialised.includes('Marijke'),
      'an internal comment was published'
    );
    check(
      "nor the client's own account of the fix",
      !serialised.includes('rotated the keys'),
      'a client claim was published'
    );
    check('nor the internal tag', !serialised.includes('internal-only'), 'a tag was published');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWriting, and what the log says about it:');
  {
    const created = await call('POST', `/api/v1/engagements/${audit._id}/findings`, {
      token: writeToken,
      body: {
        title: 'Directory listing enabled on the document host',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
        description: 'Filed by the scanner.',
      },
    });
    check('a write token creates a finding', created.status === 201, created.status);
    check(
      'and the server allocates its number',
      created.body?.finding?.identifier === 2,
      created.body?.finding?.identifier
    );

    /* An identifier a caller tried to choose is not honoured — it is not in the schema at all. */
    const forced = await call('POST', `/api/v1/engagements/${audit._id}/findings`, {
      token: writeToken,
      body: { title: 'Tried to pick its own number', identifier: 99 },
    });
    check(
      'a caller cannot choose the number',
      forced.body?.finding?.identifier === 3,
      forced.body?.finding?.identifier
    );

    const patched = await call(
      'PATCH',
      `/api/v1/engagements/${audit._id}/findings/${created.body.finding.id}`,
      { token: writeToken, body: { remediationStatus: 'fixed' } }
    );
    check('and can update one', patched.body?.finding?.remediationStatus === 'fixed', patched.status);

    const { Activity } = await import('../models/activity.model.js');
    const entries = await Activity.find({ audit: audit._id }).sort({ createdAt: -1 }).lean();
    const machine = entries.find((entry) => entry.meta?.via === 'api-token');
    check('the activity log marks it as a token write', Boolean(machine), 'no entry marked via api-token');
    check(
      'and the sentence names the token rather than pretending a person did it',
      (machine?.summary ?? '').includes('Scanner'),
      machine?.summary
    );

    const step = await call('POST', `/api/v1/engagements/${audit._id}/enumeration`, {
      token: writeToken,
      body: {
        title: 'Service sweep',
        tool: 'nmap',
        command: 'nmap -sV portal.example',
        output: '443/tcp open  https nginx 1.24.0\n8080/tcp open  http-proxy',
      },
    });
    check('an enumeration step can be filed', step.status === 201, step.status);
    check('with its output stored', step.body?.step?.output?.includes('nginx'), step.body?.step?.output);

    const list = await call('GET', `/api/v1/engagements/${audit._id}/enumeration`, {
      token: readToken,
    });
    check(
      'and the list leaves the output behind',
      list.body?.steps?.[0] && !('output' in list.body.steps[0]),
      Object.keys(list.body?.steps?.[0] ?? {}).join(', ')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAn approved engagement is frozen for scripts too:');
  {
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'APPROVED' } });
    const write = await call('POST', `/api/v1/engagements/${audit._id}/findings`, {
      token: writeToken,
      body: { title: 'After sign-off' },
    });
    check('writing to it is refused', write.status === 403, write.status);
    check(
      'and the reason is the one the app gives a person',
      /approved and locked/i.test(write.body?.error ?? ''),
      write.body?.error
    );
    await Audit.updateOne({ _id: audit._id }, { $set: { state: 'EDIT' } });
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThere is no way to delete anything:');
  {
    const findings = await call('DELETE', `/api/v1/engagements/${audit._id}/findings/x`, {
      token: writeToken,
    });
    check('no delete route for a finding', findings.status === 404, findings.status);
    const engagement = await call('DELETE', `/api/v1/engagements/${audit._id}`, {
      token: writeToken,
    });
    check('nor for an engagement', engagement.status === 404, engagement.status);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe secret exists once:');
  {
    const session = signAccessToken(lead);
    const minted = await call('POST', '/api/auth/tokens', {
      session,
      body: { label: 'Made through the API', scopes: ['engagements:read'], days: 10 },
    });
    check('minting answers with the secret', minted.status === 201, minted.status);
    const value = minted.body?.token ?? '';
    check('which begins with the searchable prefix', value.startsWith(TOKEN_PREFIX), value.slice(0, 8));
    check('and works immediately', (await call('GET', '/api/v1/whoami', { token: value })).status === 200);

    const listed = await call('GET', '/api/auth/tokens', { session });
    const row = (listed.body?.tokens ?? []).find((one) => one.label === 'Made through the API');
    check('the list shows it', Boolean(row), 'not in the list');
    check('as live', row?.state === 'live', row?.state);
    check(
      'with only a preview, never the secret',
      row?.preview?.length < value.length && value.startsWith(row?.preview ?? 'x'),
      `${row?.preview} vs ${value.length} characters`
    );
    check(
      'and nothing in the list is usable as a credential',
      !JSON.stringify(listed.body.tokens).includes(value),
      'the secret came back in the list'
    );

    const stored = await ApiToken.findOne({ tokenHash: hashToken(value) });
    check('the database holds a hash of it', Boolean(stored), 'no row matched the hash');
    check(
      'and no field on the row is the secret',
      !JSON.stringify(stored.toObject()).includes(value.slice(TOKEN_PREFIX.length)),
      'the secret is stored somewhere on the row'
    );

    /* Revoking it stops it, and the row stays visible so somebody can see why. */
    await call('DELETE', `/api/auth/tokens/${row.id}`, { session });
    const after = await call('GET', '/api/v1/whoami', { token: value });
    check('revoking stops it', after.status === 401, after.status);
    check('and says it was revoked', /revoked/i.test(after.body?.error ?? ''), after.body?.error);

    const stillListed = await call('GET', '/api/auth/tokens', { session });
    check(
      'while the row remains, so the failure is explicable',
      (stillListed.body?.tokens ?? []).some((one) => one.id === row.id && one.state === 'revoked')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nMinting refuses what it should:');
  {
    const session = signAccessToken(lead);

    const noScopes = await call('POST', '/api/auth/tokens', {
      session,
      body: { label: 'Nothing at all', scopes: [] },
    });
    check('a token with no scopes', noScopes.status === 422, noScopes.status);

    const restricted = await call('POST', '/api/auth/tokens', {
      session,
      body: { label: 'For the board work', scopes: ['engagements:read'], engagements: [String(secret._id)] },
    });
    check('a token for a restricted engagement', restricted.status === 400, restricted.status);
    check(
      'with the reason',
      /restricted/i.test(restricted.body?.error ?? ''),
      restricted.body?.error
    );

    const notMine = await call('POST', '/api/auth/tokens', {
      session,
      body: {
        label: "Somebody else's work",
        scopes: ['engagements:read'],
        engagements: [String(new mongoose.Types.ObjectId())],
      },
    });
    check('a token for an engagement you are not on', notMine.status === 400, notMine.status);

    const tooLong = await call('POST', '/api/auth/tokens', {
      session,
      body: { label: 'Forever', scopes: ['engagements:read'], days: 4000 },
    });
    check('a lifetime beyond the ceiling', tooLong.status === 422, tooLong.status);

    /* A read-only account cannot mint a credential that writes — the role would be undone. */
    const readonly = await User.create({
      username: 'api-readonly',
      email: 'readonly@example.invalid',
      password: 'ApiTestPass123!',
      role: 'readonly',
      roles: ['readonly'],
      enabled: true,
      approvedAt: new Date(),
    });
    const byReadonly = await call('POST', '/api/auth/tokens', {
      session: signAccessToken(readonly),
      body: { label: 'Sneaking a write', scopes: ['findings:write'] },
    });
    check('a read-only account cannot mint a write token', byReadonly.status === 403, byReadonly.status);
    const readByReadonly = await call('POST', '/api/auth/tokens', {
      session: signAccessToken(readonly),
      body: { label: 'Reading is fine', scopes: ['findings:read'] },
    });
    check('but may mint a read one', readByReadonly.status === 201, readByReadonly.status);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd one button ends them all:');
  {
    const session = signAccessToken(lead);
    const before = await call('GET', '/api/auth/tokens', { session });
    const live = (before.body?.tokens ?? []).filter((one) => one.state === 'live').length;
    check('there are live tokens to end', live > 0, live);

    const all = await call('POST', '/api/auth/tokens/revoke-all', { session });
    check('revoke-all reports how many', all.body?.revoked === live, `${all.body?.revoked} of ${live}`);

    const stopped = await call('GET', '/api/v1/whoami', { token: readToken });
    check('and the read token has stopped', stopped.status === 401, stopped.status);

    const after = await call('GET', '/api/auth/tokens', { session });
    check(
      'with nothing live left',
      (after.body?.tokens ?? []).every((one) => one.state !== 'live')
    );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
