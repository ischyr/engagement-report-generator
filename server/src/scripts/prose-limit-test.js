/**
 * A ceiling on prose, and the two things it must not break.
 *
 *   npm run test:prose-limit
 *
 * The engagement is one MongoDB document with a hard 16MB limit. Three collections have already
 * been moved out to stay under it — enumeration bodies, phishing targets, evidence — each with the
 * same sentence in its comment: reaching the ceiling does not make a page slow, it makes the next
 * save refuse, mid-operation, with the work still on screen.
 *
 * And the fields most likely to take a very large paste had no limit at all. A finding's
 * description, impact, remediation, proof of concept and affected assets; a note's content; a
 * section's text — nothing in the schema, nothing in the model — while `express.json` accepts
 * sixty megabytes and enumeration output, the field actually *designed* for tool dumps, had been
 * capped at two hundred thousand characters all along.
 *
 * So the cap is the same number, and this file is mostly about what it must not cost:
 *
 *   1. **A real write-up still fits.** Several thousand words with screenshots in it. If a cap
 *      makes an ordinary finding unsaveable it is not a fix, it is a different fault.
 *   2. **Work already written stays writable.** The cap is on the door — the zod schema — and
 *      deliberately not on the model, because a `maxlength` there would validate the whole
 *      document on every save and lock somebody out of an engagement that already holds an
 *      over-long field. A limit invented afterwards must not make existing work illegal.
 *
 * And the third thing, which is what the operator actually experiences: a save the database
 * refuses for size used to be a 500 and "Internal server error" — the least useful answer to
 * somebody who has just lost a paragraph.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
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

const PORT = 4163;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-prose-${Date.now()}`);
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

/**
 * A write-up of the size a real one is.
 *
 * Four thousand words of prose, a table, a code block and six screenshots — which are `/api/media`
 * links, because the editor uploads images rather than inlining them. That decision is the whole
 * reason a cap on prose is safe, so the fixture is built the way the editor builds one.
 */
const realWriteUp = () => {
  const paragraph =
    '<p>The application accepts the session identifier from a query parameter as well as from the ' +
    'cookie, and does not rotate it on authentication. An attacker who can induce a victim to ' +
    'follow a crafted link therefore fixes the session identifier in advance and, once the victim ' +
    'signs in, holds an authenticated session.</p>';
  const shots = Array.from(
    { length: 6 },
    (_, index) =>
      `<figure class="engy-figure"><img src="/api/media/${'a'.repeat(24)}" alt="step ${index + 1}">` +
      `<figcaption>Step ${index + 1}</figcaption></figure>`
  ).join('');
  const table =
    '<table><tr><th>Host</th><th>Result</th></tr>' +
    Array.from({ length: 40 }, (_, i) => `<tr><td>host-${i}.acme.example</td><td>vulnerable</td></tr>`).join('') +
    '</table>';
  return paragraph.repeat(60) + shots + table;
};

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'prose-lead',
    email: 'prose-lead@example.invalid',
    password: 'ProsePass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const company = await Company.create({ name: 'Acme', createdBy: lead._id });
  const audit = await Audit.create({
    name: 'Acme portal',
    reference: 'PT-2026-076',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA write-up of the size a real one is still saves:');
  {
    const body = realWriteUp();
    check(`the fixture is ${(body.length / 1024).toFixed(0)} kB of HTML`, body.length > 20_000, String(body.length));

    const made = await call(
      'POST',
      `/api/audits/${audit._id}/findings`,
      {
        title: 'Session fixation',
        description: body,
        observation: body,
        remediation: body,
        poc: body,
        scope: 'acme.example',
        cvssv3: VECTOR,
      },
      session
    );
    check('it is accepted', made.status === 201, made.text.slice(0, 160));

    const after = await Audit.findById(audit._id);
    check('  and stored whole', after.findings[0].description.length === body.length, String(after.findings[0].description.length));
    check(
      '  with the screenshots as links, not bytes',
      after.findings[0].description.includes('/api/media/') && !after.findings[0].description.includes('data:image'),
      'the fixture inlined an image'
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd a pasted log is refused, at the door, with something to do about it:');
  {
    const log = 'x'.repeat(250_000);

    for (const field of ['description', 'observation', 'remediation', 'poc', 'scope']) {
      const refused = await call(
        'POST',
        `/api/audits/${audit._id}/findings`,
        { title: 'Too much', [field]: log, cvssv3: VECTOR },
        session
      );
      check(`${field} is refused`, refused.status === 422, `${refused.status} ${refused.text.slice(0, 80)}`);
      /*
       * The message has to be actionable. "String must contain at most 200000 character(s)" is
       * accurate and useless to somebody who has just pasted a scan into the wrong box.
       */
      check(
        `  and says where it belongs`,
        /enumeration step/i.test(JSON.stringify(refused.body?.details ?? '')),
        JSON.stringify(refused.body?.details)
      );
    }

    const note = await call(
      'POST',
      `/api/audits/${audit._id}/notes`,
      { title: 'Too much', content: log },
      session
    );
    check('a note is refused too', note.status === 422, String(note.status));

    const section = await call(
      'POST',
      `/api/audits/${audit._id}/sections`,
      { field: 'summary', name: 'Executive summary', text: log },
      session
    );
    check('and a section', section.status === 422, `${section.status} ${section.text.slice(0, 80)}`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nJust under the line goes through:');
  {
    /*
     * The boundary, from the side that must work. A cap that is off by one rejects the longest
     * legitimate write-up in the instance and nobody finds out until somebody loses one.
     */
    const { PROSE_MAX } = await import('../routes/audits.routes.js');
    check(`the cap is ${PROSE_MAX} characters`, PROSE_MAX === 200_000, String(PROSE_MAX));

    const exact = await call(
      'POST',
      `/api/audits/${audit._id}/findings`,
      { title: 'Exactly at the line', description: 'y'.repeat(PROSE_MAX), cvssv3: VECTOR },
      session
    );
    check('exactly at the cap is accepted', exact.status === 201, `${exact.status} ${exact.text.slice(0, 80)}`);

    const over = await call(
      'POST',
      `/api/audits/${audit._id}/findings`,
      { title: 'One over', description: 'y'.repeat(PROSE_MAX + 1), cvssv3: VECTOR },
      session
    );
    check('  one character over is not', over.status === 422, String(over.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd work written before the cap existed stays writable:');
  {
    /*
     * The reason the cap is on the door and not on the model.
     *
     * Mongoose validates the whole document on save, so a `maxlength` on these fields would make
     * every subsequent write to an engagement that already held an over-long one fail — locking an
     * operator out of their own work to enforce a rule invented afterwards. Written straight to the
     * database here, the way an older version of this app would have left it.
     */
    const old = await Audit.create({
      name: 'Written before the cap',
      reference: 'PT-OLD',
      company: company._id,
      creator: lead._id,
      state: 'EDIT',
      findings: [
        {
          identifier: 1,
          title: 'A finding with an enormous proof of concept',
          poc: 'z'.repeat(400_000),
          cvssv3: VECTOR,
          createdBy: lead._id,
        },
      ],
    });
    check('it was stored', old.findings[0].poc.length === 400_000, String(old.findings[0].poc.length));

    /* And the engagement is not now frozen: an unrelated edit still saves. */
    old.name = 'Renamed after the cap arrived';
    let saved = true;
    try {
      await old.save();
    } catch {
      saved = false;
    }
    check('  and the engagement still saves', saved, 'the model refuses its own existing data');

    const renamed = await call('PUT', `/api/audits/${old._id}`, { name: 'Renamed through the API' }, session);
    check('  including through the API', renamed.status === 200, `${renamed.status} ${renamed.text.slice(0, 80)}`);

    const reread = await Audit.findById(old._id);
    check('  with the long field untouched', reread.findings[0].poc.length === 400_000, String(reread.findings[0].poc.length));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd a document the database refuses says what to do:');
  {
    /*
     * Past the door, the ceiling is still there — the cap is per field, and enough fields add up.
     * Reaching it used to be a 500 and "Internal server error", which describes the server's
     * feelings rather than what somebody who has just lost a paragraph should do next.
     *
     * Driven at the error handler directly: manufacturing a genuine 16MB document through the API
     * would take eighty valid requests and prove nothing the handler does not.
     */
    const { errorHandler } = await import('../middleware/error.js');

    for (const error of [
      Object.assign(new Error('BSONObjectTooLarge: object to insert too large'), { code: 10334 }),
      Object.assign(new Error('Resulting document after update is larger than 16777216'), { code: 17419 }),
      new Error('BSONObjectTooLarge'),
    ]) {
      let status = 0;
      let body = null;
      errorHandler(
        error,
        { method: 'PUT', originalUrl: '/api/audits/x', id: 'test' },
        {
          status(code) {
            status = code;
            return this;
          },
          json(payload) {
            body = payload;
            return this;
          },
        },
        () => {}
      );

      check(`${error.code ?? 'by message'} answers 413, not 500`, status === 413, String(status));
      check('  saying nothing was saved', /nothing was saved/i.test(body?.error ?? ''), body?.error);
      check(
        '  and where the large things go',
        /enumeration steps/i.test(body?.error ?? ''),
        body?.error
      );
    }
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
