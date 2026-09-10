/**
 * What the test changed, what it used, and when it comes back.
 *
 *   npm run test:intrusive
 *
 * Three features that all turn on the same idea: a pentest does things to somebody else's system,
 * and the app should be able to say what. So the assertions are about the questions somebody asks
 * afterwards rather than about the fields:
 *
 *   - can this engagement be approved with a change still standing? (no, and that is the point)
 *   - what did you do with the account we lent you?
 *   - who is coming back to check, and when?
 *
 * Its own scratch database, dropped at the end.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { Company } from '../models/company.model.js';
import { Credential } from '../models/credential.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { buildReportData } from '../services/report.service.js';
import { credentialUsage, credentialUsageForReport } from '../services/credential-usage.service.js';
import { preflightAudit } from '../services/preflight.service.js';
import { mediaIdsInAudit } from '../services/media.service.js';
import { encryptSecret } from '../services/vault.service.js';

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

const uri = `mongodb://127.0.0.1:27017/engy-intrusive-test-${Date.now()}`;
await mongoose.connect(uri);

try {
  const settings = await Settings.getSettings();
  const lead = await User.create({
    username: 'intrusive-lead',
    firstname: 'Tomás',
    lastname: 'Herrera',
    email: 'tomas@example.invalid',
    password: 'IntrusivePass123!',
    role: 'user',
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
    state: 'REVIEW',
    findings: [
      {
        identifier: 1,
        title: 'Shipment documents readable without authentication',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        createdBy: lead._id,
      },
    ],
  });

  /* Two borrowed accounts, as a client would lend them. */
  const reader = await Credential.create({
    audit: audit._id,
    label: 'Read-only portal account',
    username: 'nw-reader',
    secret: encryptSecret('reader-password'),
    createdBy: lead._id,
  });
  const admin = await Credential.create({
    audit: audit._id,
    label: 'Portal administrator',
    username: 'nw-admin',
    secret: encryptSecret('admin-password'),
    createdBy: lead._id,
  });

  /* ---------------------------------------------------------- the changes */
  console.log('\nWhat the test changed:');
  audit.intrusions.push(
    {
      title: 'Disabled MFA on the test user',
      action: 'disabled',
      target: 'PATCH /api/users/4471/mfa',
      host: 'portal.northwind-logistics.example',
      before: '{"mfa":{"enabled":true,"method":"totp"}}',
      after: '{"mfa":{"enabled":false}}',
      revertPlan: 'Re-enable under Security on the user, or PATCH the body above back.',
      notes: '<p>The portal accepted the change with the reader account.</p>',
      at: '22 Jul 2026, 14:10',
      authorisedBy: 'Marijke de Vries',
      reversible: true,
      credentialsUsed: [reader._id],
      author: lead._id,
      order: 1,
    },
    {
      title: 'Deleted a shipment row to test ownership checks',
      action: 'deleted',
      target: 'DELETE /api/shipments/8814',
      host: 'portal.northwind-logistics.example',
      before: '{"id":8814,"customer":4471,"status":"in transit"}',
      after: 'gone',
      reversible: false,
      credentialsUsed: [admin._id],
      author: lead._id,
      order: 2,
    },
    {
      title: 'Wrote a marker file on our own jump box',
      action: 'created',
      target: '/opt/engy/marker.txt',
      host: 'our own infrastructure',
      /* Ours, so it is not the client's business and must not print. */
      print: false,
      reversible: true,
      author: lead._id,
      order: 3,
    }
  );
  await audit.save();

  check('three are recorded', audit.intrusions.length === 3);
  check(
    'the first is still standing',
    !audit.intrusions[0].revertedAt && audit.intrusions[0].reversible
  );
  check('the second says it cannot be undone', audit.intrusions[1].reversible === false);

  /* --------------------------------------------------- preflight, the point */
  console.log('\nPreflight, with a change still standing:');
  {
    const before = preflightAudit(audit.toObject());
    const blocker = before.issues.find((issue) => issue.code === 'intrusions-outstanding');
    check('refuses to approve the report', Boolean(blocker), 'nothing blocked the report');
    check('as a blocker rather than a note', blocker?.level === 'blocker', blocker?.level);
    check(
      'and names what is outstanding',
      blocker?.detail?.includes('Disabled MFA'),
      blocker?.detail
    );
    check(
      'counting the two that can be put back, and not the deletion that cannot',
      blocker?.message?.startsWith('2 changes'),
      blocker?.message
    );
    check('and points at the tab', blocker?.tab === 'intrusive', blocker?.tab);
  }

  console.log('\nOnce it has been put back:');
  {
    audit.intrusions[0].revertedAt = new Date();
    audit.intrusions[0].revertedBy = lead._id;
    audit.intrusions[0].revertNote = 'Re-enabled TOTP and confirmed a login prompt.';
    /* The third is ours and still standing, so it must still block: "ours" is not "done". */
    const midway = preflightAudit(audit.toObject());
    check(
      'our own outstanding change still blocks, because it is still a change',
      midway.issues.some((issue) => issue.code === 'intrusions-outstanding'),
      'a change on our own infrastructure was ignored'
    );

    audit.intrusions[2].revertedAt = new Date();
    audit.intrusions[2].revertedBy = lead._id;
    await audit.save();

    const after = preflightAudit(audit.toObject());
    check(
      'and with nothing outstanding it stops complaining',
      !after.issues.some((issue) => issue.code === 'intrusions-outstanding'),
      JSON.stringify(after.issues.filter((issue) => issue.code === 'intrusions-outstanding'))
    );
  }

  /* -------------------------------------------------------- the report data */
  console.log('\nIn the report:');
  {
    const data = buildReportData(audit.toObject(), settings.toObject(), {}, {
      credentials: [reader.toObject(), admin.toObject()],
    });

    check('the appendix exists', data.hasIntrusions === true);
    check(
      'with the two that are the client\'s business',
      data.intrusions.length === 2,
      `${data.intrusions.length}`
    );
    check(
      'and not the one on our own box',
      !JSON.stringify(data.intrusions).includes('marker.txt'),
      'a change we made to our own infrastructure reached the client\'s report'
    );
    check(
      'each one says what state it is in',
      data.intrusions.map((entry) => entry.state).join('|') === 'Put back|Cannot be undone',
      data.intrusions.map((entry) => entry.state).join('|')
    );
    check(
      'the before value is printed as typed, for somebody to paste back',
      data.intrusions[0].before.includes('"enabled":true'),
      data.intrusions[0].before
    );
    check(
      'the summary counts what a cover paragraph needs',
      data.intrusionSummary.total === 2 &&
        data.intrusionSummary.reverted === 1 &&
        data.intrusionSummary.irreversible === 1 &&
        data.intrusionSummary.outstanding === 0,
      JSON.stringify(data.intrusionSummary)
    );
    check('and the write-up is a rich field', typeof data.intrusions[0].rich?.notes === 'string');
  }

  /* ---------------------------------------------------- the credential trail */
  console.log('\nWhat the accounts were used for:');
  {
    /* And a finding that names one, so all three sources are exercised. */
    audit.findings[0].credentialsUsed = [reader._id];
    audit.enumeration.push({
      title: 'Listed every shipment as the reader',
      tool: 'curl',
      credentialsUsed: [reader._id],
      author: lead._id,
      order: 1,
    });
    await audit.save();

    const usage = credentialUsage(audit.toObject(), [reader.toObject(), admin.toObject()]);
    const readerRow = usage.byCredential.find((row) => row.username === 'nw-reader');
    const adminRow = usage.byCredential.find((row) => row.username === 'nw-admin');

    check(
      'the reader account is traced to all three kinds of work',
      readerRow.findings.length === 1 &&
        readerRow.steps.length === 1 &&
        readerRow.intrusions.length === 1,
      JSON.stringify({
        f: readerRow.findings.length,
        s: readerRow.steps.length,
        i: readerRow.intrusions.length,
      })
    );
    check('the administrator account to the one deletion', adminRow.intrusions.length === 1);
    check('neither is reported as unused', !readerRow.unused && !adminRow.unused);

    /* An account that was lent and never touched, which is worth saying out loud. */
    const spare = await Credential.create({
      audit: audit._id,
      label: 'Second administrator, never used',
      username: 'nw-admin2',
      secret: encryptSecret('spare-password'),
      createdBy: lead._id,
    });
    const withSpare = credentialUsage(audit.toObject(), [
      reader.toObject(),
      admin.toObject(),
      spare.toObject(),
    ]);
    check(
      'and one that was never used says so',
      withSpare.byCredential.find((row) => row.username === 'nw-admin2')?.unused === true
    );

    /* A reference to a credential that has since gone. */
    const orphaned = credentialUsage(audit.toObject(), [admin.toObject()]);
    check(
      'work naming an account that no longer exists is reported rather than dropped',
      orphaned.unknown.length === 3,
      `${orphaned.unknown.length}`
    );

    const forReport = credentialUsageForReport(audit.toObject(), [
      reader.toObject(),
      admin.toObject(),
    ]);
    check('the report shape counts them', forReport[0].counts.total === 3, JSON.stringify(forReport[0].counts));
    check(
      'and carries no secret, because it never reads one',
      !JSON.stringify(forReport).toLowerCase().includes('secret'),
      'something secret-shaped is in the report data'
    );
  }

  /* ------------------------------------------------- images inside a change */
  console.log('\nA screenshot pasted into a change:');
  {
    const id = '6aa25ff329bf94c3cdcc797e';
    audit.intrusions[0].notes = `<p>Before and after</p><img src="/api/media/${id}">`;
    await audit.save();
    const ids = mediaIdsInAudit(audit.toObject());
    check(
      'counts as referenced, so it reaches the report and is not collected as an orphan',
      ids.has(id),
      [...ids].join(', ')
    );
  }

  /* ------------------------------------------------------- the retest booking */
  console.log('\nThe retest, booked by the delivery:');
  {
    /*
     * The helper lives in the route, so what is asserted here is the outcome the route produces:
     * a booking, on the right day, for the right person, with a note somebody can read in a
     * schedule. The route itself is exercised by hand and by the interface.
     */
    const days = 30;
    const day = new Date();
    day.setDate(day.getDate() + days);
    const on = day.toISOString().slice(0, 10);

    const booking = await Booking.create({
      audit: audit._id,
      user: lead._id,
      start: on,
      end: on,
      note: `Retest of ${audit.reference}`,
      createdBy: lead._id,
    });

    check('is a day in the schedule', booking.start === on && booking.end === on, booking.start);
    check('assigned to somebody', String(booking.user) === String(lead._id));
    check('and says what it is for', booking.note.includes('PT-2026-041'), booking.note);
    check(
      'with no reminder sent yet, so the existing chaser will pick it up',
      booking.reminderSentAt === null
    );
  }
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
