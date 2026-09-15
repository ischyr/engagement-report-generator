/**
 * A client's whole history on one link, and the four things it must never show.
 *
 *   npm run test:portfolio
 *
 * This is the widest disclosure in the application. A findings link forwarded to the wrong person
 * exposes one engagement; this exposes which engagements a client has had, when, and how they
 * went — the shape of their relationship with the firm. So the assertions worth having are not
 * that it works. They are the four walls, each of which is one filter in `portfolioView` and each
 * of which would fail silently:
 *
 *   1. work in progress carries no numbers
 *   2. restricted engagements do not appear at all
 *   3. no finding text, ever
 *   4. nothing trashed
 *
 * And the fifth, which is structural rather than a filter: there is no route that writes through a
 * link of this kind. Every write in `share.routes.js` resolves an engagement from the link, and a
 * client link names a company instead — so this suite points each of them at one and checks that
 * none of them finds anything to write to.
 *
 * The scope rule is asserted at the model, because it is the one that decides reach: exactly one
 * of `audit` and `company`, chosen by `kind`. A row with neither is a token scoped to nothing,
 * which for something that decides what an outsider may see is the same as scoped to everything.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { ShareLink } from '../models/share-link.model.js';
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

const PORT = 4155;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-portfolio-${Date.now()}`);
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

const VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N';

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'pf-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'pf-lead@example.invalid',
    password: 'PortfolioPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const northwind = await Company.create({ name: 'Northwind', createdBy: lead._id });
  const other = await Company.create({ name: 'Someone Else', createdBy: lead._id });

  const makeAudit = async (attributes) =>
    Audit.create({
      company: northwind._id,
      creator: lead._id,
      ...attributes,
      findings: (attributes.findings ?? []).map((finding, index) => ({
        identifier: index + 1,
        cvssv3: VECTOR,
        createdBy: lead._id,
        ...finding,
      })),
    });

  /* Reported last year, one finding claimed fixed and one not. */
  await makeAudit({
    name: 'Portal test 2025',
    reference: 'PT-2025-011',
    auditType: 'Web application',
    state: 'APPROVED',
    date_start: '2025-03-01',
    findings: [
      { title: 'SECRET-TITLE-ONE', clientClaim: { status: 'fixed', at: new Date(), by: 'Dana' } },
      { title: 'SECRET-TITLE-TWO' },
    ],
  });

  /* Still being written. Its findings must not be counted anywhere. */
  await makeAudit({
    name: 'Portal test 2026',
    reference: 'PT-2026-041',
    auditType: 'Web application',
    state: 'EDIT',
    date_start: '2026-03-01',
    findings: [{ title: 'UNREPORTED-TITLE' }, { title: 'ALSO-UNREPORTED' }, { title: 'AND-A-THIRD' }],
  });

  /* Restricted, and therefore not the client's business through a URL. */
  await makeAudit({
    name: 'RESTRICTED-ENGAGEMENT-NAME',
    reference: 'PT-2026-RED',
    state: 'APPROVED',
    classification: 'restricted',
    date_start: '2026-01-01',
    findings: [{ title: 'RESTRICTED-FINDING' }],
  });

  /* Deleted, and therefore gone rather than archived in public. */
  const trashed = await makeAudit({
    name: 'TRASHED-ENGAGEMENT-NAME',
    reference: 'PT-GONE',
    state: 'APPROVED',
    date_start: '2024-01-01',
    findings: [{ title: 'TRASHED-FINDING' }],
  });
  trashed.deletedAt = new Date();
  await trashed.save();

  /* Somebody else's work entirely. */
  await Audit.create({
    name: 'ANOTHER-CLIENTS-WORK',
    reference: 'PT-OTHER',
    company: other._id,
    creator: lead._id,
    state: 'APPROVED',
    findings: [{ identifier: 1, title: 'NOT-THEIRS', cvssv3: VECTOR, createdBy: lead._id }],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA client link is made against a client, not an engagement:');
  let token = '';
  {
    const made = await call('POST', `/api/share/link/company/${northwind._id}`, { label: 'Dana' }, session);
    check('it is made', made.status === 201, made.text.slice(0, 160));
    check('  of the right kind', made.body?.kind === 'client', made.body?.kind);
    check('  with a URL', String(made.body?.path ?? '').startsWith('/shared/'), made.body?.path);
    token = made.body.token;

    const row = await ShareLink.findById(made.body._id);
    check('  scoped to the company', String(row.company) === String(northwind._id), String(row.company));
    check('  and to no engagement', row.audit === null, String(row.audit));
    /* Read-only by construction, not by a flag somebody could flip on the way in. */
    check('  read-only', row.allowUpdates === false && row.allowEvidence === false, '');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nIt shows the client their own work:');
  let seen = null;
  {
    const answer = await call('GET', `/api/share/${token}`);
    check('the page loads', answer.status === 200, answer.text.slice(0, 160));
    seen = answer.body;
    check('  named for the client', seen?.client === 'Northwind', seen?.client);
    check('  as a client view', seen?.kind === 'client', seen?.kind);

    /* Two: the reported one and the one in progress. Not the restricted, trashed or other one. */
    check('  two engagements', seen?.engagements?.length === 2, JSON.stringify(seen?.engagements?.map((e) => e.name)));
    check('  one of them reported', seen?.totals?.delivered === 1, String(seen?.totals?.delivered));
    check('  and one finding outstanding', seen?.totals?.outstanding === 1, String(seen?.totals?.outstanding));

    const reported = seen.engagements.find((entry) => entry.delivered);
    check('  the reported one carries counts', reported?.findings === 2, String(reported?.findings));
    check('    and says what is open', reported?.open === 1, String(reported?.open));
    check('    by severity', (reported?.bySeverity ?? []).some((band) => band.count > 0), JSON.stringify(reported?.bySeverity));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWall one — work in progress carries no numbers:');
  {
    const draft = seen.engagements.find((entry) => !entry.delivered);
    check('the unfinished one is listed', Boolean(draft), JSON.stringify(seen.engagements.map((e) => e.name)));
    check('  by name', draft?.name === 'Portal test 2026', draft?.name);
    /*
     * The important half. Counting findings on a report the client has not been given tells them
     * a result the team has not finished deciding — and on a red team, before they are meant to
     * know it is running at all.
     */
    check('  with no count', draft?.findings === null, String(draft?.findings));
    check('  nothing open', draft?.open === null, String(draft?.open));
    check('  and no severities', draft?.bySeverity === null, JSON.stringify(draft?.bySeverity));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWall two — restricted work does not appear:');
  {
    const raw = JSON.stringify(seen);
    check('not by name', !raw.includes('RESTRICTED-ENGAGEMENT-NAME'), 'the name is in the answer');
    check('  not by reference', !raw.includes('PT-2026-RED'), 'the reference is in the answer');
    check('  and not in the totals', seen.totals.engagements === 2, String(seen.totals.engagements));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWall three — no finding text, of any kind:');
  {
    const raw = JSON.stringify(seen);
    for (const secret of [
      'SECRET-TITLE-ONE',
      'SECRET-TITLE-TWO',
      'UNREPORTED-TITLE',
      'ALSO-UNREPORTED',
      'AND-A-THIRD',
      'RESTRICTED-FINDING',
    ]) {
      check(`  ${secret} is not in it`, !raw.includes(secret), 'a finding title reached the client');
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nWall four — deleted work is gone, and so is everybody else’s:');
  {
    const raw = JSON.stringify(seen);
    check('nothing trashed', !raw.includes('TRASHED-ENGAGEMENT-NAME'), 'a deleted engagement is listed');
    check('  nor its findings', !raw.includes('TRASHED-FINDING'), 'a deleted finding reached the client');
    check('another client’s work is absent', !raw.includes('ANOTHER-CLIENTS-WORK'), 'another client is listed');
    check('  and their findings', !raw.includes('NOT-THEIRS'), 'another client’s finding reached this one');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd nothing can be written through one:');
  {
    /*
     * Structural rather than a permission. Every write resolves an engagement from the link, and
     * this link names a company — so each of these fails for want of something to write to. The
     * check is that all four agree about it.
     */
    const finding = '000000000000000000000000';
    const writes = [
      ['a claim', 'POST', `/api/share/${token}/findings/${finding}`, { fixed: true }],
      ['a question about a finding', 'POST', `/api/share/${token}/findings/${finding}/question`, { text: 'Hello there' }],
      ['a general question', 'POST', `/api/share/${token}/question`, { text: 'Hello there' }],
      ['asking to reopen', 'POST', `/api/share/${token}/reopen`, {}],
    ];
    for (const [what, method, path, body] of writes) {
      const refused = await call(method, path, body);
      /*
       * 403 exactly, not "some kind of error". A 500 is a crash, and a crash counts as a refusal
       * only by accident — which is how the first version of this passed while the reopen route
       * was reading `link.audit._id` off a null.
       */
      check(
        `${what} is refused cleanly`,
        refused.status === 403,
        `${refused.status} ${refused.text.slice(0, 80)}`
      );
      check(
        '  and says which link would do it',
        /that engagement/i.test(refused.body?.error ?? ''),
        refused.body?.error
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd a link belongs to exactly one thing:');
  {
    const both = new ShareLink({
      kind: 'client',
      company: northwind._id,
      audit: (await Audit.findOne({ company: northwind._id }))._id,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    let refused = false;
    try {
      await both.validate();
    } catch {
      refused = true;
    }
    check('a client link with an engagement too is refused', refused, 'both were accepted');

    const neither = new ShareLink({
      kind: 'client',
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    let alsoRefused = false;
    try {
      await neither.validate();
    } catch {
      alsoRefused = true;
    }
    /* Scoped to nothing is, for a disclosure decision, the same as scoped to everything. */
    check('  and one scoped to nothing is too', alsoRefused, 'a link with no scope was accepted');

    const engagementWithCompany = new ShareLink({
      kind: 'findings',
      company: northwind._id,
      tokenHash: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    let third = false;
    try {
      await engagementWithCompany.validate();
    } catch {
      third = true;
    }
    check('  and a findings link on a company is refused', third, 'it was accepted');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd you cannot publish a client you cannot see:');
  {
    const stranger = await User.create({
      username: 'pf-stranger',
      email: 'pf-stranger@example.invalid',
      password: 'PortfolioPass123!',
      role: 'user',
      roles: ['user'],
      enabled: true,
      approvedAt: new Date(),
    });
    const theirs = signAccessToken(stranger);
    const refused = await call('POST', `/api/share/link/company/${northwind._id}`, {}, theirs);
    check('somebody with no sight of the client is refused', refused.status === 404, String(refused.status));

    const anonymous = await call('POST', `/api/share/link/company/${northwind._id}`, {}, null);
    check('  and so is nobody at all', anonymous.status === 401, String(anonymous.status));
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
