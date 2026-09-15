/**
 * A methodology out as a file, and back in — into this instance or another one.
 *
 *   npm run test:checklist-io
 *
 * The paste box already takes a list out of a document, and it is the right tool for that. What it
 * cannot do is carry a check's description, and it cannot round-trip: what came out of this app was
 * not something the app could read back. So a methodology curated over two years lived in one
 * installation and was retyped into the next.
 *
 * Two halves are worth asserting.
 *
 * **The round trip.** Export, import, and end up with what you started with — including the
 * descriptions the paste box loses, and including the order, which the file expresses as the order
 * of the array rather than as a number somebody's editor can leave behind after a cut and paste.
 *
 * **What the file refuses to carry.** Ids, slugs, `builtin` and `createdBy` are facts about *this*
 * installation, not about the methodology, and every one of them goes wrong quietly if it travels:
 * a slug is how the seeder recognises a shipped list, so an imported file claiming `slug: "web"`
 * becomes the thing the next seed overwrites; `builtin` is a badge saying "this came with the app";
 * `createdBy` is a user id that means somebody else entirely on the other instance. So the file
 * carries a methodology and the importer supplies the provenance — and this suite plants all four
 * in a file and checks that none of them survives.
 *
 * The reader is deliberately tolerant, in the same way the nmap and phishing importers are: this
 * file is meant to be hand-edited, so it accepts four shapes, says what it understood, and names
 * what it could not use rather than refusing the lot over one bad line.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Checklist } from '../models/checklist.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { FORMAT, VERSION, readFile } from '../services/checklist-io.service.js';

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

const PORT = 4157;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-checklist-io-${Date.now()}`);
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
    headers: response.headers,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'cl-lead',
    email: 'cl-lead@example.invalid',
    password: 'ChecklistPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);

  const original = await Checklist.create({
    name: 'Web application',
    description: 'What we check on every web test',
    slug: 'web',
    builtin: true,
    createdBy: lead._id,
    checks: [
      { title: 'Session cookie flags', description: 'Secure, HttpOnly and SameSite.', category: 'Authentication', order: 0 },
      { title: 'Password reset tokens', description: 'Single use, and they expire.', category: 'Authentication', order: 1 },
      { title: 'Directory listing', description: '', category: 'Configuration', order: 2 },
    ],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA checklist comes out as a file:');
  let file = null;
  {
    const got = await call('GET', `/api/checklists/${original._id}/export`, null, session);
    check('it downloads', got.status === 200, got.text.slice(0, 140));
    check(
      '  as a file rather than a page',
      /attachment/.test(got.headers.get('content-disposition') ?? ''),
      got.headers.get('content-disposition')
    );
    check(
      '  named after itself',
      /web-application\.checklist\.json/.test(got.headers.get('content-disposition') ?? ''),
      got.headers.get('content-disposition')
    );

    file = got.body;
    check('  saying what it is', file?.format === FORMAT, file?.format);
    check('  and which version', file?.version === VERSION, String(file?.version));
    check('  with the checklist in it', file?.checklists?.length === 1, String(file?.checklists?.length));
    check('  and all three checks', file.checklists[0].checks.length === 3, String(file.checklists[0].checks.length));
    check(
      '  descriptions included — the thing a pasted list loses',
      file.checklists[0].checks[0].description === 'Secure, HttpOnly and SameSite.',
      file.checklists[0].checks[0].description
    );
    check(
      '  and the order is the array order',
      file.checklists[0].checks.map((entry) => entry.title)[2] === 'Directory listing',
      JSON.stringify(file.checklists[0].checks.map((entry) => entry.title))
    );
    /* A file people edit should not carry a number their editor can leave behind. */
    check('  with no order numbers in it', !('order' in file.checklists[0].checks[0]), JSON.stringify(file.checklists[0].checks[0]));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd what it refuses to carry is the point:');
  {
    const raw = JSON.stringify(file);
    check('no ids', !raw.includes(String(original._id)), 'an id is in the file');
    check('  no slug', !raw.includes('"slug"'), 'a slug is in the file');
    check('  no builtin flag', !raw.includes('"builtin"'), 'the builtin flag is in the file');
    check('  and nobody else’s user id', !raw.includes(String(lead._id)), 'a user id is in the file');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nIt reads back as what it was:');
  {
    const brought = await call('POST', '/api/checklists/import', { data: file }, session);
    check('it imports', brought.status === 201, brought.text.slice(0, 160));
    check('  as one checklist', brought.body?.created?.length === 1, JSON.stringify(brought.body?.created));
    check('  with every check', brought.body?.created?.[0]?.checks === 3, String(brought.body?.created?.[0]?.checks));

    const copy = await Checklist.findById(brought.body.created[0]._id);
    check('  named as it was', copy.name === 'Web application', copy.name);
    check('  described as it was', copy.description === 'What we check on every web test', copy.description);
    check(
      '  with the descriptions intact',
      copy.checks[0].description === 'Secure, HttpOnly and SameSite.',
      copy.checks[0].description
    );
    check(
      '  in the same order',
      copy.checks.map((entry) => entry.title).join('|') ===
        'Session cookie flags|Password reset tokens|Directory listing',
      copy.checks.map((entry) => entry.title).join('|')
    );
    check('  and categories kept', copy.checks[2].category === 'Configuration', copy.checks[2].category);

    /* The provenance is this instance's, whatever the file said. */
    check('  it is not a built-in', copy.builtin === false, String(copy.builtin));
    check('  it has no slug', copy.slug === null, String(copy.slug));
    check('  and it was made by whoever imported it', String(copy.createdBy) === String(lead._id), String(copy.createdBy));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA file cannot make itself a built-in, or steal a slug:');
  {
    /*
     * The failure this prevents is quiet: a slug is how the seeder recognises a shipped
     * methodology, so a file claiming `slug: "web"` would become the thing the next seed
     * overwrites — and the team's own list would vanish on an upgrade with nothing to explain it.
     */
    const hostile = {
      format: FORMAT,
      version: 1,
      checklists: [
        {
          name: 'Definitely official',
          slug: 'web',
          builtin: true,
          _id: '000000000000000000000001',
          createdBy: '000000000000000000000002',
          checks: [{ title: 'A check', _id: '000000000000000000000003' }],
        },
      ],
    };

    /*
     * Both layers, separately.
     *
     * The reader drops these fields and the route hardcodes them, which means each covers the
     * other and a check on the imported row alone passes with either one removed. That is a
     * comfortable place to be and a useless test, so the reader is asked directly here and the
     * route is asked below — break one and exactly one set of checks fails.
     */
    const parsed = readFile(hostile).checklists[0];
    check('the reader keeps none of it', !('slug' in parsed) && !('builtin' in parsed), JSON.stringify(Object.keys(parsed)));
    check('  nor the ids', !('_id' in parsed) && !('createdBy' in parsed), JSON.stringify(Object.keys(parsed)));
    check(
      '  nor on the check',
      !('_id' in parsed.checks[0]),
      JSON.stringify(Object.keys(parsed.checks[0]))
    );

    const brought = await call('POST', '/api/checklists/import', { data: hostile }, session);
    check('it imports', brought.status === 201, brought.text.slice(0, 160));

    const made = await Checklist.findById(brought.body.created[0]._id);
    check('  but not as a built-in', made.builtin === false, String(made.builtin));
    check('  and without the slug it asked for', made.slug === null, String(made.slug));
    check('  made by the importer, not the file', String(made.createdBy) === String(lead._id), String(made.createdBy));
    check(
      '  and the original built-in is untouched',
      (await Checklist.findById(original._id)).slug === 'web',
      'the seeded checklist lost its slug'
    );
    check(
      '  the check did not keep its id either',
      String(made.checks[0]._id) !== '000000000000000000000003',
      String(made.checks[0]._id)
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nOr it can go into a checklist you already have:');
  {
    const into = await Checklist.create({ name: 'Mine', createdBy: lead._id, checks: [] });
    const brought = await call(
      'POST',
      '/api/checklists/import',
      { data: file, into: String(into._id) },
      session
    );
    check('it merges', brought.status === 200, brought.text.slice(0, 160));
    check('  adding three', brought.body?.added === 3, String(brought.body?.added));
    check('  and creating nothing', brought.body?.created?.length === 0, JSON.stringify(brought.body?.created));

    /* Again, and nothing should happen: the same file twice is the same methodology twice. */
    const again = await call(
      'POST',
      '/api/checklists/import',
      { data: file, into: String(into._id) },
      session
    );
    check('the same file again adds nothing', again.body?.added === 0, String(again.body?.added));
    check('  and says it skipped them', again.body?.skipped === 3, String(again.body?.skipped));

    const after = await Checklist.findById(into._id);
    check('  leaving three checks, not six', after.checks.length === 3, String(after.checks.length));
    check(
      '  numbered densely',
      after.checks.map((entry) => entry.order).join(',') === '0,1,2',
      after.checks.map((entry) => entry.order).join(',')
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd it reads what a person is likely to have written:');
  {
    const shapes = [
      ['the file this app writes', { format: FORMAT, version: 1, checklists: [{ name: 'A', checks: ['One'] }] }, 'file'],
      ['a bare list of checklists', [{ name: 'A', checks: ['One'] }], 'checklists'],
      ['one checklist on its own', { name: 'A', checks: ['One'] }, 'checklist'],
      ['a bare list of checks', ['One', 'Two'], 'checks'],
      ['checks as objects', [{ title: 'One' }, { title: 'Two' }], 'checks'],
      /* Half the tools in this trade call it `name`, and one calls the group `group`. */
      ['a check called `name`', [{ name: 'One', group: 'Auth' }], 'checks'],
    ];

    for (const [what, data, shape] of shapes) {
      const result = readFile(data);
      check(
        `${what} is understood`,
        result.shape === shape && result.checklists.length > 0,
        `${result.shape}, ${result.checklists.length} lists`
      );
    }

    const named = readFile([{ name: 'One', group: 'Auth' }]);
    check('  and the alternative field names are read', named.checklists[0].checks[0].category === 'Auth', JSON.stringify(named.checklists[0].checks[0]));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd says what it could not use, rather than refusing the lot:');
  {
    const messy = {
      format: FORMAT,
      version: 1,
      checklists: [
        {
          name: 'Mixed',
          checks: [
            { title: 'Good one' },
            { description: 'no title here' },
            '',
            42,
            { title: 'Another good one' },
          ],
        },
      ],
    };

    const result = readFile(messy);
    check('the good ones are read', result.checklists[0].checks.length === 2, String(result.checklists[0].checks.length));
    check('  and the bad ones are named', result.problems.length === 3, JSON.stringify(result.problems));
    check('  by position', result.problems[0].includes('check 2'), result.problems[0]);

    const brought = await call('POST', '/api/checklists/import', { data: messy }, session);
    check('  the import still goes through', brought.status === 201, brought.text.slice(0, 140));
    check('  carrying the problems back', (brought.body?.problems ?? []).length === 3, JSON.stringify(brought.body?.problems));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd refuses what it genuinely cannot read:');
  {
    const notJson = await call('POST', '/api/checklists/import', { data: '{ nope' }, session);
    check('a file that is not JSON', notJson.status === 400, String(notJson.status));
    check('  and says so', /not JSON/i.test(notJson.body?.error ?? ''), notJson.body?.error);

    const empty = await call('POST', '/api/checklists/import', { data: [] }, session);
    check('a file with nothing in it', empty.status === 400, String(empty.status));

    const wrongThing = await call('POST', '/api/checklists/import', { data: { format: 'something.else', checklists: [] } }, session);
    check('  and one that is a different kind of file', wrongThing.status === 400, String(wrongThing.status));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the format shown in the import dialog is a real one:');
  {
    /*
     * The dialog prints two examples so somebody with a methodology in a spreadsheet knows what to
     * write. An example is a promise, and this is the one kind of documentation that can be checked
     * rather than reviewed: it is either something the reader accepts or it is not.
     *
     * Read out of the component rather than duplicated here, because a copy would agree with
     * itself forever while the dialog drifted.
     */
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../../../client/src/components/checklists/ChecklistImportModal.jsx', import.meta.url),
      'utf8'
    );

    const shown = [...source.matchAll(/^const (FULL|MINIMAL) = `([\s\S]*?)`;$/gm)];
    check(`both examples were found (${shown.length})`, shown.length === 2, 'the dialog no longer shows them');

    for (const [, name, code] of shown) {
      const result = readFile(code);
      check(
        `the ${name.toLowerCase()} example parses`,
        result.checklists.length > 0 && result.problems.length === 0,
        `${result.checklists.length} lists, problems: ${result.problems.join('; ')}`
      );
      check(
        `  and has checks in it`,
        (result.checklists[0]?.checks ?? []).length > 0,
        JSON.stringify(result.checklists[0])
      );
    }

    /* And the fuller one really does carry the things it claims to. */
    const full = readFile(shown.find(([, name]) => name === 'FULL')[2]).checklists[0];
    check('the full example carries a description', Boolean(full.checks[0].description), JSON.stringify(full.checks[0]));
    check('  and a category', Boolean(full.checks[0].category), JSON.stringify(full.checks[0]));
    check('  and names the format this app writes', full.name === 'Web application', full.name);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd everything needs an account that may write:');
  {
    const anonymous = await call('POST', '/api/checklists/import', { data: file }, null);
    check('importing needs one', anonymous.status === 401, String(anonymous.status));

    const readonly = await User.create({
      username: 'cl-readonly',
      email: 'cl-readonly@example.invalid',
      password: 'ChecklistPass123!',
      role: 'readonly',
      roles: ['readonly'],
      enabled: true,
      approvedAt: new Date(),
    });
    const refused = await call('POST', '/api/checklists/import', { data: file }, signAccessToken(readonly));
    check('  and a read-only account cannot', refused.status === 403, String(refused.status));

    /* Reading is not writing: a read-only account may still take a copy. */
    const got = await call('GET', '/api/checklists/export', null, signAccessToken(readonly));
    check('  but may still export', got.status === 200, String(got.status));
    check('    getting every checklist', (got.body?.checklists ?? []).length >= 2, String(got.body?.checklists?.length));
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
