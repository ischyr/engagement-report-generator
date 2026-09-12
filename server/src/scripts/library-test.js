/**
 * The library list stops carrying what nobody draws, and the entry still has it.
 *
 *   npm run test:library
 *
 * `GET /vulnerabilities` answered with every entry in full — each locale's description, impact and
 * remediation, screenshots and all, up to two thousand of them — so that a table of titles could be
 * drawn. Three callers did it: the library page, the picker inside a finding, and the dashboard,
 * which fetched the whole library to show how many entries are in it.
 *
 * The list carries a stored `snippet` now and the bodies stay in the database. That is a change
 * with two ways to go quietly wrong, and both are asserted here:
 *
 *   1. **A write path that forgets the snippet.** It is computed by `withSnippets` at four call
 *      sites — create, update, import-insert, import-update — because summarising a 500-entry
 *      library on every request measured at 1.18 seconds. A fifth writer that forgets would leave
 *      entries listing with a blank line that reads exactly like a description nobody wrote. So
 *      every one of those paths is exercised and its stored snippet read back.
 *
 *   2. **An editor that saves what the list gave it.** The dialog is seeded from the row, and a row
 *      no longer has prose in it — so a save from a form that had not finished loading would write
 *      three empty fields over somebody's write-up. The client guards it by disabling the button;
 *      what is asserted here is the half that makes the guard possible, that `GET /:id` still
 *      answers with everything.
 *
 * The last section is the one that matters most: the bodies are still *there*, still exported, and
 * still findable by a search. An optimisation that quietly loses text is not an optimisation.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { backfillLibrarySnippets } from '../services/library-migration.service.js';

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

const PORT = 4133;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-library-${Date.now()}`);
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

/** A word that exists only deep inside a description, where no row will ever carry it. */
const BURIED = 'zzdeeplyburiedzz';

const DESCRIPTION =
  '<p>The <strong>session cookie</strong> is issued without the <code>Secure</code> attribute, so ' +
  'a browser will send it over plain HTTP.</p>' +
  '<p>An attacker on the same network can therefore read it from a single unencrypted request. ' +
  `Observed against the staging load balancer (${BURIED}).</p>`;

const entryPayload = (title, extra = {}) => ({
  cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
  category: 'Web',
  details: [
    {
      locale: 'en',
      title,
      vulnType: 'Session management',
      description: DESCRIPTION,
      observation: '<p>Session theft on a shared network.</p>',
      remediation: '<p>Set Secure, HttpOnly and SameSite on the session cookie.</p>',
      references: ['https://example.invalid/cookies'],
    },
    {
      locale: 'fr',
      title: `${title} (fr)`,
      vulnType: 'Gestion de session',
      description: '<p>Le cookie de session est émis sans attribut Secure.</p>',
      observation: '',
      remediation: '',
      references: [],
    },
  ],
  ...extra,
});

try {
  await Settings.getSettings();

  const author = await User.create({
    username: 'lib-author',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'lib-author@example.invalid',
    password: 'LibraryPass123!',
    role: 'admin',
    roles: ['admin'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(author);

  /* ------------------------------------------------------------------------ */
  console.log('\nAn entry is written, and summarised on the way in:');
  let created = null;
  {
    const made = await call('POST', '/api/vulnerabilities', entryPayload('Cookie without Secure'), session);
    check('it is created', made.status === 201, made.text.slice(0, 160));
    created = made.body;

    const stored = await Vulnerability.findById(created._id).lean();
    check(
      'the snippet is stored, as text rather than markup',
      stored.details[0].snippet.startsWith('The session cookie is issued without'),
      JSON.stringify(stored.details[0].snippet?.slice(0, 60))
    );
    check(
      '  and each locale has its own',
      stored.details[1].snippet.startsWith('Le cookie de session'),
      JSON.stringify(stored.details[1].snippet?.slice(0, 40))
    );
    check(
      '  bounded, whatever the description weighs',
      stored.details.every((detail) => detail.snippet.length <= 201),
      JSON.stringify(stored.details.map((d) => d.snippet.length))
    );
    check(
      'and the prose is still the prose',
      stored.details[0].description === DESCRIPTION,
      `${stored.details[0].description?.length} chars`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe list carries what a row draws, and nothing else:');
  {
    const list = await call('GET', '/api/vulnerabilities', null, session);
    check('it answers', list.status === 200, String(list.status));
    const row = list.body[0];
    check(
      'no description, impact or remediation on the wire',
      row.details.every(
        (detail) =>
          detail.description === undefined &&
          detail.observation === undefined &&
          detail.remediation === undefined
      ),
      JSON.stringify(Object.keys(row.details[0]))
    );
    check(
      'no markup, and nothing past the first line',
      !list.text.includes('<strong>') &&
        !list.text.includes('<p>') &&
        /* Past the 200-character cut, and in the remediation, which has no snippet at all. */
        !list.text.includes(BURIED) &&
        !list.text.includes('HttpOnly'),
      list.text.slice(0, 160)
    );
    check('but the snippet is there', Boolean(row.details[0].snippet), JSON.stringify(row.details[0]));
    check(
      'and every locale keeps its title, for the picker',
      row.details.length === 2 && row.details[1].title.endsWith('(fr)'),
      JSON.stringify(row.details.map((d) => d.title))
    );
    check(
      'the score is worked out once, by the server',
      row.severity === 'High' && typeof row.cvssScore === 'number',
      JSON.stringify([row.severity, row.cvssScore])
    );

    /* The escape hatch, for a caller that really does want everything. */
    const full = await call('GET', '/api/vulnerabilities?full=1', null, session);
    check(
      '?full=1 still answers with the bodies',
      full.body[0].details[0].description === DESCRIPTION,
      String(full.body[0].details[0].description).slice(0, 60)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nOne entry, in full, is a route of its own — which is what lets the editor open:');
  {
    const one = await call('GET', `/api/vulnerabilities/${created._id}`, null, session);
    check('it answers', one.status === 200, String(one.status));
    check(
      'with every field the dialog edits',
      one.body.details[0].description === DESCRIPTION &&
        one.body.details[0].observation.includes('Session theft') &&
        one.body.details[0].remediation.includes('HttpOnly') &&
        one.body.details[0].references.length === 1,
      JSON.stringify(Object.keys(one.body.details[0]))
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAn edit rewrites the summary, an unrelated edit leaves it alone:');
  {
    const edited = await call(
      'PUT',
      `/api/vulnerabilities/${created._id}`,
      entryPayload('Cookie without Secure', {
        details: [
          {
            locale: 'en',
            title: 'Cookie without Secure',
            vulnType: 'Session management',
            description: '<p>Rewritten entirely, with <em>different</em> words.</p>',
            observation: '',
            remediation: '',
            references: [],
          },
        ],
      }),
      session
    );
    check('the edit lands', edited.status === 200, edited.text.slice(0, 140));

    const stored = await Vulnerability.findById(created._id).lean();
    check(
      'the stored line follows the new text',
      stored.details[0].snippet === 'Rewritten entirely, with different words.',
      JSON.stringify(stored.details[0].snippet)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA bundle comes in summarised, both by insert and by update:');
  {
    const bundle = {
      format: 'engy-vulnerability-library',
      version: 1,
      entries: [entryPayload('Imported: verbose error messages')],
    };
    const first = await call('POST', '/api/vulnerabilities/import', bundle, session);
    check('it imports', first.status === 201 && first.body.added === 1, first.text.slice(0, 140));

    const inserted = await Vulnerability.findOne({ 'details.title': /verbose error/i }).lean();
    check(
      'the inserted entry has its line',
      inserted.details[0].snippet.startsWith('The session cookie'),
      JSON.stringify(inserted.details[0].snippet?.slice(0, 40))
    );

    /* The same bundle again, with different prose and `mode: update` — the other write path. */
    const changed = entryPayload('Imported: verbose error messages');
    changed.details[0].description = '<p>Updated through the import path.</p>';
    const second = await call(
      'POST',
      '/api/vulnerabilities/import',
      { ...bundle, entries: [changed], mode: 'update' },
      session
    );
    check('the second pass updates rather than duplicates', second.body.updated === 1, second.text.slice(0, 140));

    const after = await Vulnerability.findOne({ 'details.title': /verbose error/i }).lean();
    check(
      'and the update wrote a new line too',
      after.details[0].snippet === 'Updated through the import path.',
      JSON.stringify(after.details[0].snippet)
    );
    check(
      '  and left the prose intact',
      after.details[0].description === '<p>Updated through the import path.</p>',
      String(after.details[0].description)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nEntries written before there was a snippet get one at boot:');
  {
    /* Straight to the collection, the way a library restored from a backup arrives. */
    const legacy = await Vulnerability.collection.insertOne({
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      category: 'Legacy',
      status: 0,
      details: [
        {
          locale: 'en',
          title: 'Written before the change',
          vulnType: '',
          description: '<p>An <b>old</b> entry, stored without a summary.</p>',
          observation: '',
          remediation: '',
          references: [],
          customFields: [],
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const before = await call('GET', '/api/vulnerabilities', null, session);
    const row = before.body.find((entry) => entry._id === String(legacy.insertedId));
    check(
      'it lists with no line at all until then',
      !row.details[0].snippet,
      JSON.stringify(row.details[0])
    );

    const count = await backfillLibrarySnippets();
    check('the migration finds exactly the one', count === 1, String(count));

    const after = await call('GET', '/api/vulnerabilities', null, session);
    const fixed = after.body.find((entry) => entry._id === String(legacy.insertedId));
    check(
      'and now it has its line',
      fixed.details[0].snippet === 'An old entry, stored without a summary.',
      JSON.stringify(fixed.details[0].snippet)
    );
    check('a second run finds nothing to do', (await backfillLibrarySnippets()) === 0, '');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the text is still findable, which is the whole point of keeping it:');
  {
    /*
     * A fresh entry, because everything written above has had its description rewritten since —
     * by the edit and by the import's update pass. The first version of this section searched for
     * a word none of them contained any more and read the empty answer as a broken search.
     */
    const planted = await call(
      'POST',
      '/api/vulnerabilities',
      entryPayload('Cookie without Secure, on staging'),
      session
    );
    check('the entry to find is there', planted.status === 201, planted.text.slice(0, 120));

    const deep = await call(`GET`, `/api/vulnerabilities?search=${BURIED}`, null, session);
    check(
      'a word only in a description still finds its entry',
      deep.status === 200 && deep.body.length === 1,
      `${deep.body?.length} matched`
    );
    check(
      '  and the answer is still a list, not the bodies',
      deep.body.every((entry) => entry.details.every((detail) => detail.description === undefined)),
      JSON.stringify(deep.body[0]?.details?.[0] ?? {})
    );

    const miss = await call('GET', '/api/vulnerabilities?search=nothingmatchesthis', null, session);
    check('and a word in nothing finds nothing', miss.body.length === 0, String(miss.body?.length));

    const exported = await call('GET', '/api/vulnerabilities/export', null, session);
    check(
      'the export still carries every word',
      exported.text.includes(BURIED) && exported.text.includes('<strong>session cookie</strong>'),
      `${exported.text.length} bytes`
    );
    check(
      '  and does not carry the derived line, which belongs to an instance',
      !exported.text.includes('"snippet"'),
      exported.text.slice(0, 120)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThe dashboard asks for a number and is given a number:');
  {
    const count = await call('GET', '/api/vulnerabilities/count', null, session);
    const list = await call('GET', '/api/vulnerabilities', null, session);
    check(
      'the count matches the list',
      count.status === 200 && count.body.count === list.body.length,
      JSON.stringify([count.body, list.body.length])
    );
    check(
      '  and weighs a few dozen bytes rather than a library',
      count.text.length < 40 && count.text.length * 50 < list.text.length,
      `${count.text.length} vs ${list.text.length} bytes`
    );
    check(
      '  and "count" is not read as an id',
      !count.text.includes('not found'),
      count.text.slice(0, 80)
    );
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
