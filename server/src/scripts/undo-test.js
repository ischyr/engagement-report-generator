/**
 * A delete that offers itself back, including for things that belong to nobody's engagement.
 *
 *   npm run test:undo
 *
 * Eleven engagement tabs already had this — a note, a credential, a test check — and the mechanism
 * was good. What it could not cover was anything the `Recycled` row's required `audit` field ruled
 * out, which is why a scratchpad note and a row of hours were still behind "are you sure?" instead.
 *
 * So `audit` became optional and an `owner` joined it, and the interesting assertions are all about
 * that seam: does an owned entry go back, does it go back *only* to its owner, and does an entry
 * that belongs to an engagement still refuse to be restored through the owner door. A scoping
 * mistake here would not look like a bug — it would look like undo working.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Recycled } from '../models/recycled.model.js';
import { Scratch } from '../models/scratch.model.js';
import { Settings } from '../models/settings.model.js';
import { TimeEntry } from '../models/time-entry.model.js';
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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-undo-test-${Date.now()}`);
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
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

try {
  await Settings.getSettings();

  const ines = await User.create({
    username: 'undo-ines',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'undo-ines@example.invalid',
    password: 'UndoPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const marijke = await User.create({
    username: 'undo-marijke',
    email: 'undo-marijke@example.invalid',
    password: 'UndoPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const hers = signAccessToken(ines);
  const theirs = signAccessToken(marijke);

  const company = await Company.create({ name: 'Northwind', createdBy: ines._id });
  const audit = await Audit.create({
    name: 'Northwind portal',
    reference: 'PT-1',
    company: company._id,
    creator: ines._id,
    state: 'EDIT',
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA row of hours comes back, with its own id:');
  {
    const made = await call('POST', '/api/time', hers, {
      audit: String(audit._id),
      day: '2026-09-01',
      hours: 6.5,
      note: 'Enumeration and the first two findings',
    });
    check('an entry is logged', made.status === 201 || made.status === 200, `${made.status} ${made.text.slice(0, 160)}`);
    const id = made.body?._id;

    const removed = await call('DELETE', `/api/time/${id}`, hers);
    check('deleting it succeeds', removed.status === 200, String(removed.status));
    check('  and offers a way back', Boolean(removed.body?.undo?.id), JSON.stringify(removed.body?.undo));
    check('  naming what it was', /6\.5h/.test(removed.body?.undo?.label ?? ''), removed.body?.undo?.label);
    check('  it really is gone', !(await TimeEntry.findById(id)), 'still there');

    const back = await call('POST', `/api/audits/${audit._id}/undo/${removed.body.undo.id}`, hers);
    check('the undo restores it', back.status === 200, `${back.status} ${back.text.slice(0, 160)}`);

    const restored = await TimeEntry.findById(id);
    check('  under the same id, not as a copy', Boolean(restored), 'a new row instead');
    check('  with the hours it had', restored?.hours === 6.5, String(restored?.hours));
    check('  and still against its engagement', String(restored?.audit) === String(audit._id), String(restored?.audit));

    const twice = await call('POST', `/api/audits/${audit._id}/undo/${removed.body.undo.id}`, hers);
    check('and the offer is spent — it cannot be taken twice', twice.status === 404, String(twice.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd so does a note that belongs to a person rather than a job:');
  let notesUndo = null;
  {
    const made = await call('POST', '/api/scratch', hers, {
      title: 'The payload that worked',
      body: 'curl -H "X-Forwarded-For: 127.0.0.1"',
    });
    check('a note is written', made.status === 201 || made.status === 200, `${made.status} ${made.text.slice(0, 160)}`);
    const id = made.body?._id;

    const removed = await call('DELETE', `/api/scratch/${id}`, hers);
    check('deleting it succeeds', removed.status === 200, String(removed.status));
    check('  and offers a way back, with no engagement in sight', Boolean(removed.body?.undo?.id), JSON.stringify(removed.body?.undo));
    check('  named after the note', removed.body?.undo?.label === 'The payload that worked', removed.body?.undo?.label);
    check('  it really is gone', !(await Scratch.findById(id)), 'still there');
    notesUndo = removed.body.undo.id;

    const entry = await Recycled.findById(notesUndo);
    check('  remembered against its owner, not an engagement', String(entry?.owner) === String(ines._id) && entry?.audit === null, `owner ${entry?.owner}, audit ${entry?.audit}`);

    /* The scoping assertion this whole change turns on. */
    const stranger = await call('POST', `/api/scratch/undo/${notesUndo}`, theirs);
    check('somebody else cannot put it back', stranger.status === 404, `${stranger.status} ${stranger.text.slice(0, 120)}`);
    check('  and is told nothing about whether it exists', /nothing left to put back/i.test(stranger.text), stranger.text.slice(0, 160));

    const back = await call('POST', `/api/scratch/undo/${notesUndo}`, hers);
    check('its owner can', back.status === 200, `${back.status} ${back.text.slice(0, 160)}`);

    const restored = await Scratch.findById(id);
    check('  under the same id', Boolean(restored), 'a new row instead');
    check('  with its text', restored?.title === 'The payload that worked', restored?.title);
    check('  and still theirs', String(restored?.user) === String(ines._id), String(restored?.user));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe two doors do not open each other:');
  {
    /* An engagement's row, offered to the owner door. */
    const made = await call('POST', '/api/time', hers, {
      audit: String(audit._id),
      day: '2026-09-02',
      hours: 2,
    });
    const removed = await call('DELETE', `/api/time/${made.body._id}`, hers);
    const wrongDoor = await call('POST', `/api/scratch/undo/${removed.body.undo.id}`, hers);
    check(
      'an engagement’s row cannot be restored through the owner route',
      wrongDoor.status === 404,
      `${wrongDoor.status} ${wrongDoor.text.slice(0, 140)}`
    );
    check(
      '  and it is still there to be restored properly',
      Boolean(await Recycled.findById(removed.body.undo.id)),
      'the failed attempt consumed it'
    );
    const rightDoor = await call('POST', `/api/audits/${audit._id}/undo/${removed.body.undo.id}`, hers);
    check('  which it then is', rightDoor.status === 200, String(rightDoor.status));

    /* And a person's note offered to the engagement door. */
    const note = await call('POST', '/api/scratch', hers, { title: 'Another', body: 'x' });
    const gone = await call('DELETE', `/api/scratch/${note.body._id}`, hers);
    const viaAudit = await call('POST', `/api/audits/${audit._id}/undo/${gone.body.undo.id}`, hers);
    check(
      'a personal note cannot be restored through an engagement',
      viaAudit.status === 404,
      `${viaAudit.status} ${viaAudit.text.slice(0, 140)}`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the window is a window:');
  {
    const note = await call('POST', '/api/scratch', hers, { title: 'Expiring', body: 'x' });
    const gone = await call('DELETE', `/api/scratch/${note.body._id}`, hers);

    const entry = await Recycled.findById(gone.body.undo.id);
    const minutes = Math.round((entry.expiresAt - entry.createdAt) / 60000);
    check('an offer expires ten minutes after it is made', minutes === 10, `${minutes} minutes`);

    await Recycled.deleteOne({ _id: entry._id });
    const late = await call('POST', `/api/scratch/undo/${gone.body.undo.id}`, hers);
    check('  and says so plainly once it has', late.status === 404 && /few minutes/i.test(late.text), late.text.slice(0, 160));
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
