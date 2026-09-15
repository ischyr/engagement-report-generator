/**
 * Output pasted with nowhere to put it, and the one rule that makes that safe.
 *
 *   npm run test:unfiled
 *
 * The workbench is a document: a step lives under a heading, in the order it happened, with a title
 * that says what it was for. That is the right shape for writing up and the wrong one for the
 * moment the output exists — mid-operation, three terminals open, wanting it saved before it
 * scrolls away. Made to choose a parent and a title first, people paste into a text file instead
 * and the app never sees the run.
 *
 * So a step can arrive unfiled. The rule that makes that safe is a single one, and it is the whole
 * subject of this file:
 *
 *   **An unfiled paste never leaves the building.**
 *
 * It is raw output nobody has read back, under a title taken from its own first line. Printed, it
 * is a wall of nmap in the middle of a chapter; exported, it is the same in a spreadsheet a client
 * opens. `enumerationHeldBack` is the one place that decides, and it decides for the report, the
 * export and the tab together — there is a comment on it recording the time those three disagreed
 * and a child of an internal section went out in a file. So the assertions here are pointed at
 * that function and at the three readers that trust it.
 *
 * The second half is the escape from the tray: filing is one write that clears the flag and gives
 * the step a place, after which it prints like anything else. A paste that could not be filed
 * would be a worse trap than one that could not be made.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { Audit, enumerationHeldBack } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { titleFromOutput } from '../services/enumeration-paste.service.js';

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

const PORT = 4159;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-unfiled-${Date.now()}`);
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

const NMAP = `Starting Nmap 7.94 ( https://nmap.org ) at 2026-09-15 14:02 CEST
Nmap scan report for api.acme.example (203.0.113.10)
Host is up (0.021s latency).
PORT    STATE SERVICE
443/tcp open  https
Nmap done: 1 IP address (1 host up) scanned in 4.21 seconds`;

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'unf-lead',
    email: 'unf-lead@example.invalid',
    password: 'UnfiledPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const session = signAccessToken(lead);
  const company = await Company.create({ name: 'Acme', createdBy: lead._id });

  const audit = await Audit.create({
    name: 'Acme perimeter',
    reference: 'PT-2026-070',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    kind: 'redteam',
  });

  /* A section for things to be filed under. */
  const section = await call(
    'POST',
    `/api/audits/${audit._id}/enumeration`,
    { title: 'Reconnaissance' },
    session
  );

  /* ------------------------------------------------------------------------ */
  console.log('\nA paste is saved with nothing else asked for:');
  let pasteId = '';
  {
    const made = await call(
      'POST',
      `/api/audits/${audit._id}/enumeration`,
      { output: NMAP, unfiled: true, parent: null },
      session
    );
    check('it is taken', made.status === 201, made.text.slice(0, 160));

    const after = await Audit.findById(audit._id);
    const step = (after.enumeration ?? []).find((entry) => entry.unfiled);
    pasteId = String(step?._id ?? '');
    check('  and it is unfiled', Boolean(step), 'nothing was marked unfiled');
    check('  with no parent', step.parent === null, String(step.parent));

    /*
     * Named from its own first line. Not asked for: a dialog that wanted a title would put back
     * the decision the tray exists to defer.
     */
    check('  named from the output', step.title.startsWith('Starting Nmap 7.94'), step.title);
    check('  and the tool recognised', step.tool === 'nmap', step.tool);
    check('  with the output kept', step.outputLines === 6, String(step.outputLines));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd it never leaves the building:');
  {
    const after = await Audit.findById(audit._id);

    /*
     * The single definition. Three readers trust it — the report, the export and the tab — and
     * there is a comment on it recording the time they disagreed.
     */
    const held = enumerationHeldBack(after);
    check('held back, by the one function that decides', held.has(pasteId), [...held].join(','));
    check('  and the filed section is not', !held.has(String(section.body._id ?? section.body.step?._id ?? '')), '');

    /* The report's own view of the chapter. */
    const data = await call('GET', `/api/audits/${audit._id}/report-data`, null, session);
    const raw = JSON.stringify(data.body ?? {});
    check('the report data does not carry it', !raw.includes('Starting Nmap 7.94'), 'the paste is in the report data');
    check('  nor the host it found', !raw.includes('api.acme.example'), 'output reached the report data');
    /* And it is counted as held back rather than silently missing. */
    check(
      '  but it is counted as held back',
      (data.body?.enumerationSummary?.internal ?? 0) >= 1,
      JSON.stringify(data.body?.enumerationSummary)
    );

    /* The spreadsheet export, which is the reader that got this wrong once before. */
    const sheet = await call('GET', `/api/audits/${audit._id}/enumeration.csv`, null, session);
    if (sheet.status === 200) {
      check('the export does not carry it either', !sheet.text.includes('Starting Nmap 7.94'), 'the paste is in the export');
    } else {
      /* Not every instance offers that route; say so rather than passing quietly. */
      check(`the export route answered ${sheet.status}`, sheet.status === 404, String(sheet.status));
    }
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd neither does a step somebody marked internal:');
  {
    /*
     * This section exists because writing the one above found a real leak, and it was not about
     * unfiled steps at all.
     *
     * The report's operation timeline was handed `audit.enumeration` whole. Every other reader
     * filtered through `enumerationHeldBack` — whose comment says three readers have to agree, and
     * records the time they disagreed and a child of an internal section went out in a file — and
     * the timeline was a fourth that never had. So a step marked internal, held back from every
     * other part of the report, printed its title, its tool and its target in the one place nobody
     * thought to check.
     *
     * The assertion is on `internal` rather than `unfiled` deliberately. Unfiled is new and could
     * be removed tomorrow; internal is the old promise — "recorded, but not for the client" — and
     * it is the one that had been quietly broken.
     */
    const made = await call(
      'POST',
      `/api/audits/${audit._id}/enumeration`,
      {
        title: 'HELD-BACK-TITLE',
        tool: 'HELD-BACK-TOOL',
        target: 'HELD-BACK-TARGET',
        output: 'the credential that worked',
        internal: true,
      },
      session
    );
    check('an internal step is made', made.status === 201, made.text.slice(0, 140));

    const data = await call('GET', `/api/audits/${audit._id}/report-data`, null, session);
    const raw = JSON.stringify(data.body ?? {});
    for (const secret of ['HELD-BACK-TITLE', 'HELD-BACK-TOOL', 'HELD-BACK-TARGET']) {
      check(`  ${secret} is nowhere in the report`, !raw.includes(secret), 'it reached the report');
    }

    /* Named, because the timeline is where it was getting out. */
    const timeline = JSON.stringify(data.body?.timeline ?? []);
    check('  and the timeline in particular has none of it', !/HELD-BACK/.test(timeline), timeline.slice(0, 200));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nPreflight says so before anybody signs off:');
  {
    const flight = await call('GET', `/api/audits/${audit._id}/preflight`, null, session);
    const issue = (flight.body?.issues ?? []).find((entry) => entry.code === 'enumeration-unfiled');
    check('it is raised', Boolean(issue), JSON.stringify((flight.body?.issues ?? []).map((i) => i.code)));
    /*
     * A warning, not a blocker. An unfiled paste is not a fault — it is a note to self nobody has
     * dealt with, and there are honest reasons to sign off with one. It must be said, not refused.
     */
    check('  as a warning rather than a blocker', issue?.level === 'warning', issue?.level);
    check('  naming what to do with it', /file them|delete/i.test(issue?.detail ?? ''), issue?.detail);
    check('  and pointing at the tab', issue?.tab === 'enumeration', issue?.tab);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nFiling it is one write, and then it prints:');
  {
    const parentId = String(section.body._id ?? section.body.step?._id ?? '');
    check('there is a section to file it under', parentId.length === 24, parentId);

    /*
     * Two writes, and deliberately so. The step patch omits `parent` — moving a step is its own
     * operation, with its own rules about cycles and ordering, and `enumeration-order` is where
     * those live. Filing is therefore "stop being unfiled" and "go here", and a route that did
     * both would be a second place that knows how to move a step.
     */
    const filed = await call(
      'PUT',
      `/api/audits/${audit._id}/enumeration/${pasteId}`,
      { unfiled: false },
      session
    );
    check('it stops being unfiled', filed.status === 200, filed.text.slice(0, 160));

    const moved = await call(
      'PUT',
      `/api/audits/${audit._id}/enumeration-order`,
      { order: [{ id: pasteId, parent: parentId }] },
      session
    );
    check('  and it moves into the tree', moved.status === 200, moved.text.slice(0, 160));

    const after = await Audit.findById(audit._id);
    const step = (after.enumeration ?? []).find((entry) => String(entry._id) === pasteId);
    check('  it is no longer unfiled', step.unfiled === false, String(step.unfiled));
    check('  and it has a place', String(step.parent) === parentId, String(step.parent));
    check('  and is no longer held back', !enumerationHeldBack(after).has(pasteId), 'still held');

    const data = await call('GET', `/api/audits/${audit._id}/report-data`, null, session);
    check(
      '  the report carries it now',
      JSON.stringify(data.body ?? {}).includes('Starting Nmap 7.94'),
      'the filed step is still missing from the report'
    );

    const flight = await call('GET', `/api/audits/${audit._id}/preflight`, null, session);
    check(
      '  and preflight stops mentioning it',
      !(flight.body?.issues ?? []).some((entry) => entry.code === 'enumeration-unfiled'),
      'preflight still says there is one'
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nA step somebody sat down to make is untouched by any of this:');
  {
    /*
     * The title derivation is deliberately only for a paste. On the ordinary path "Untitled step"
     * is a prompt to name it, not a gap to fill in, and a step that renamed itself from whatever
     * was pasted into it later would be the wrong kind of helpful.
     */
    const ordinary = await call(
      'POST',
      `/api/audits/${audit._id}/enumeration`,
      { output: NMAP },
      session
    );
    check('it is created', ordinary.status === 201, ordinary.text.slice(0, 140));

    const after = await Audit.findById(audit._id);
    const step = (after.enumeration ?? []).at(-1);
    check('  keeping the default title', step.title === 'Untitled step', step.title);
    check('  and it is filed from the start', step.unfiled === false, String(step.unfiled));
    check('  so it prints', !enumerationHeldBack(after).has(String(step._id)), 'it was held back');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the name comes off the output, whatever the output is:');
  {
    const cases = [
      ['nmap announcing itself', NMAP, /^Starting Nmap 7\.94/, 'nmap'],
      ['httpx', '[INF] Current httpx version v1.6.0\nhttps://acme.example [200]', /httpx/, 'httpx'],
      ['gobuster', 'Gobuster v3.6\n/admin (Status: 301)', /Gobuster/, 'gobuster'],
      /* A banner is not always the first line — it is often after a rule of dashes. */
      ['a tool named below the rule', '=====\n  nuclei v3.1.0\n[info] templates loaded', /nuclei/, 'nuclei'],
      ['something nobody recognises', 'total 48\ndrwxr-xr-x 2 root root', /^total 48/, ''],
    ];

    for (const [what, output, titlePattern, tool] of cases) {
      const named = titleFromOutput(output);
      check(`${what} is named`, titlePattern.test(named.title), named.title);
      check(`  and its tool is ${tool || 'left blank'}`, named.tool === tool, named.tool);
    }

    /* Leading noise is skipped rather than becoming the title. */
    const noisy = titleFromOutput('\n\n-------------\nStarting Nmap 7.94\n');
    check('a rule of dashes is not a title', noisy.title === 'Starting Nmap 7.94', noisy.title);

    /* Nothing usable still produces something that sorts and does not lie. */
    const empty = titleFromOutput('   \n\n  ', new Date('2026-09-15T14:02:00Z'));
    check('an empty paste gets a dated name', empty.title === 'Pasted 2026-09-15 14:02', empty.title);

    const long = titleFromOutput('x'.repeat(400));
    check('  and a very long line is cut', long.title.length <= 120 && long.title.endsWith('…'), String(long.title.length));
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
