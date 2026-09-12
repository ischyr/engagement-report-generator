/**
 * What this instance loads to answer a question, and what it keeps afterwards.
 *
 *   npm run test:housekeeping
 *
 * Two changes that are not the same feature but are the same worry: an instance that has been used
 * for three years should not be slower or heavier than one used for three months, and both of these
 * were.
 *
 * **The dashboard read every engagement, including the finished ones.** Its projection was careful;
 * its *selection* was not. Everything on that page which walks a checklist or looks for a finding
 * with no evidence begins by skipping approved engagements, so most of what it loaded travelled the
 * wire to meet a `continue`. It is two reads now — the full projection for live work, six fields
 * for finished work — and the assertions here are all about the numbers that still legitimately
 * count approved engagements, because those are what a careless version of this change breaks. My
 * first description of it was "move the filters into the query", which would have broken four of
 * them.
 *
 * **Notifications never expired.** A per-user feed, read once, kept forever. They have two windows
 * now, and the interesting case is the one that predates the field: a TTL index ignores a document
 * that has no such date, so without a backfill the change would apply to new installs and to
 * nobody else — the opposite of where the problem is.
 */
import crypto from 'node:crypto';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { Company } from '../models/company.model.js';
import { Notification, READ_TTL_MS, UNREAD_TTL_MS } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { dashboardFor } from '../services/dashboard.service.js';
import { backfillNotificationExpiry } from '../services/notification-expiry.service.js';

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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-housekeeping-${Date.now()}`);

const day = (offset) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

try {
  await Settings.getSettings();

  const ines = await User.create({
    username: 'hk-ines',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'hk-ines@example.invalid',
    password: 'HousePass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const company = await Company.create({ name: 'Northwind', createdBy: ines._id });

  const CRITICAL = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const HIGH = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N';

  /* Still going on: one critical with no evidence, one check assigned and not done. */
  const live = await Audit.create({
    name: 'Northwind portal',
    reference: 'PT-LIVE',
    company: company._id,
    creator: ines._id,
    state: 'EDIT',
    date_end: day(3),
    findings: [
      { identifier: 1, title: 'Live critical', cvssv3: CRITICAL, createdBy: ines._id, evidenceCount: 0 },
    ],
    testChecks: [{ title: 'TLS configuration', createdBy: ines._id, assignedTo: ines._id }],
  });

  /*
   * Finished, and still counted. Recurring, so it is the next occurrence; with a finding, so it
   * is in the severity totals; with a check and an evidence-less finding, neither of which must
   * turn up as somebody's work.
   */
  const done = await Audit.create({
    name: 'Contoso, delivered',
    reference: 'PT-DONE',
    company: company._id,
    creator: ines._id,
    state: 'APPROVED',
    repeat: { months: 12, nextDue: day(30) },
    findings: [
      { identifier: 1, title: 'Finished high', cvssv3: HIGH, createdBy: ines._id, evidenceCount: 0 },
    ],
    testChecks: [{ title: 'Never ticked', createdBy: ines._id, assignedTo: ines._id }],
  });

  /* A booking on the finished one, which must still resolve to a name. */
  await Booking.create({
    user: ines._id,
    audit: done._id,
    start: day(1),
    end: day(2),
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nThe dashboard still counts the work that is finished:');
  {
    const board = await dashboardFor(ines);

    check('both engagements are in the totals', board.totals.engagements === 2, String(board.totals.engagements));
    check('  and only one of them is open', board.totals.open === 1, String(board.totals.open));
    check(
      '  the severity counts include the finished one',
      board.totals.findings === 2 &&
        board.totals.severityCounts.critical === 1 &&
        board.totals.severityCounts.high === 1,
      JSON.stringify(board.totals.severityCounts)
    );
    check(
      '  and so does the serious-and-unfixed figure',
      board.totals.openSerious === 2,
      String(board.totals.openSerious)
    );

    check(
      'a finished engagement can still be the next occurrence',
      (board.due ?? []).some((row) => row.audit.reference === 'PT-DONE'),
      JSON.stringify((board.due ?? []).map((row) => row.audit.reference))
    );
    check(
      '  named properly, from a projection that had to keep the name',
      (board.due ?? [])[0]?.audit?.name === 'Contoso, delivered',
      (board.due ?? [])[0]?.audit?.name
    );

    check(
      'a booking on a finished engagement still resolves',
      (board.mine?.bookings ?? []).some((row) => row.audit.reference === 'PT-DONE'),
      JSON.stringify((board.mine?.bookings ?? []).map((row) => row.audit.reference))
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd does not offer finished work as something to do:');
  {
    const board = await dashboardFor(ines);

    check(
      'the live check is mine to do',
      (board.mine?.checks ?? []).some((row) => row.title === 'TLS configuration'),
      JSON.stringify((board.mine?.checks ?? []).map((row) => row.title))
    );
    check(
      '  and the finished one is not',
      !(board.mine?.checks ?? []).some((row) => row.title === 'Never ticked'),
      JSON.stringify((board.mine?.checks ?? []).map((row) => row.title))
    );
    check(
      'the live finding with no evidence is listed',
      (board.mine?.findings ?? []).some(
        (row) => row.title === 'Live critical'
      ),
      JSON.stringify(board.mine)
    );
    check(
      '  and the finished one is not',
      !(board.mine?.findings ?? []).some(
        (row) => row.title === 'Finished high'
      ),
      JSON.stringify(board.mine)
    );
    check(
      'nothing finished is asking for attention',
      !(board.attention ?? []).some((row) => row.audit.reference === 'PT-DONE'),
      JSON.stringify((board.attention ?? []).map((row) => row.audit.reference))
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA notification now has an end:');
  {
    const fresh = await Notification.create({
      user: ines._id,
      type: 'mention',
      message: 'You were mentioned',
    });
    const life = fresh.expiresAt - fresh.createdAt;
    check(
      'an unread one is kept for six months',
      Math.abs(life - UNREAD_TTL_MS) < 5000,
      `${Math.round(life / 86_400_000)} days`
    );

    fresh.read = true;
    fresh.readAt = new Date();
    fresh.expiresAt = new Date(Date.now() + READ_TTL_MS);
    await fresh.save();
    const afterReading = (await Notification.findById(fresh._id)).expiresAt - Date.now();
    check(
      'and a month once it has been read',
      Math.abs(afterReading - READ_TTL_MS) < 5000,
      `${Math.round(afterReading / 86_400_000)} days`
    );
    check('  which is shorter than the first', READ_TTL_MS < UNREAD_TTL_MS, '');

    /* The index is what actually removes them; a field nothing sweeps is a field. */
    const indexes = await Notification.collection.indexes();
    const ttl = indexes.find((entry) => entry.expireAfterSeconds !== undefined);
    check('there is a TTL index behind it', Boolean(ttl), JSON.stringify(indexes.map((i) => i.name)));
    check(
      '  on the date itself, not on a fixed age',
      ttl?.key?.expiresAt === 1 && ttl?.expireAfterSeconds === 0,
      JSON.stringify(ttl)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the ones written before it had one are given it:');
  {
    /*
     * Inserted straight through the driver, so Mongoose's default cannot fill the field in — which
     * is exactly the shape of every notification an established install already holds.
     */
    const old = new Date(Date.now() - 400 * 86_400_000);
    const { insertedIds } = await Notification.collection.insertMany([
      { user: ines._id, type: 'mention', message: 'ancient unread', read: false, createdAt: old, updatedAt: old },
      {
        user: ines._id,
        type: 'mention',
        message: 'ancient read',
        read: true,
        readAt: old,
        createdAt: old,
        updatedAt: old,
      },
    ]);

    const before = await Notification.countDocuments({ expiresAt: { $exists: false } });
    check('two rows have no expiry', before === 2, String(before));

    const moved = await backfillNotificationExpiry();
    check('the backfill takes both', moved === 2, String(moved));
    check(
      '  and none are left without one',
      (await Notification.countDocuments({ expiresAt: { $exists: false } })) === 0,
      'some still have none'
    );

    /*
     * Dated from when each was created, not from now — otherwise a backfill would hand a
     * four-hundred-day-old notification another six months, which is the opposite of the point.
     */
    const unread = await Notification.findById(insertedIds[0]);
    const read = await Notification.findById(insertedIds[1]);
    check(
      'the old unread one is already past its date',
      unread.expiresAt < new Date(),
      `expires ${unread.expiresAt.toISOString()}`
    );
    check(
      '  and so is the old read one',
      read.expiresAt < new Date(),
      `expires ${read.expiresAt.toISOString()}`
    );
    check(
      '  each measured from its own moment, not from now',
      Math.abs(unread.expiresAt - (old.getTime() + UNREAD_TTL_MS)) < 5000 &&
        Math.abs(read.expiresAt - (old.getTime() + READ_TTL_MS)) < 5000,
      `${unread.expiresAt.toISOString()} / ${read.expiresAt.toISOString()}`
    );

    check(
      'and running it again does nothing',
      (await backfillNotificationExpiry()) === 0,
      'it matched rows a second time'
    );
  }
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the suite itself stopped — ${error.stack}`);
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
