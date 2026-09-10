/**
 * The search filters in Mongo now. Prove it did not lose a single result doing it.
 *
 *   npm run test:search
 *
 * `GET /api/search` used to load every engagement the caller could see — whole `findings`,
 * `sections` and `notes` arrays — and then run an HTML parser over every prose field of every one
 * of them looking for a two-character needle. It now asks Mongo which engagements contain the
 * needle first and scores only those.
 *
 * That is a filter standing in front of the scoring, and a filter is a thing that can be wrong in
 * a way nothing reports: a result that is no longer returned looks exactly like a result that was
 * never there. So this file is mostly one assertion made twenty-three ways — **the endpoint returns
 * exactly what the old code would have returned** — with the oracle written out here from the
 * scoring loop's own field list rather than imported, so a mistake in the route cannot be
 * inherited by the thing checking the route.
 *
 * The hard cases are all the same case: phase two scores the *plain text*, phase one has only the
 * stored HTML, and between them sits every tag somebody left in the middle of a phrase and every
 * character an editor stores as an entity. `SQL<em> injection</em>`, `<b>sudo</b>ers`,
 * `Tom &amp; Jerry`, `&lt;script&gt;` — a plain `RegExp(needle)` sent to Mongo misses all four,
 * and each one is a result that would have gone missing with nothing anywhere saying so.
 *
 * And two things that turned out to be wrong while the filter was being written: search wrote its
 * own access clause instead of using the shared one, so it answered out of trashed engagements and
 * out of engagements somebody's membership of had expired, and it never applied the two-factor
 * rule that governs restricted work. Those are the last section, and they are the half worth
 * having.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import createApp from '../app.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';
import { htmlToPlainText } from '../services/ooxml/html-parser.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

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

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-search-test-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** The endpoint, with a limit high enough that nothing is cut off before it can be compared. */
async function search(needle, session) {
  const response = await fetch(
    `${origin}/api/search?q=${encodeURIComponent(needle)}&limit=100`,
    { headers: { Authorization: `Bearer ${session}` } }
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.startsWith('{') ? JSON.parse(text) : null,
    text,
  };
}

/* -------------------------------------------------------------------------- */
/* The oracle: what the old code would have returned                          */
/* -------------------------------------------------------------------------- */

/**
 * The same escaping the route does, written out again on purpose.
 *
 * Importing it would mean a bug in the escaping passes both sides of the comparison.
 */
const plainMatcher = (needle) =>
  new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/** `scoreField`'s test, and nothing else from it: does this field's plain text contain the needle. */
const hits = (value, regex) => {
  const plain = htmlToPlainText(value ?? '').trim();
  return Boolean(plain) && regex.test(plain);
};

/**
 * Every id the pre-filter version of this endpoint would have produced, for one needle.
 *
 * The field lists are the scoring loops', copied: `bestMatch({...})` for the engagement, the
 * finding, the section and the note. Anything here that phase one cannot admit is a result that
 * has gone missing, which is the whole point of the file.
 */
async function oracle(needle, user) {
  const regex = plainMatcher(needle);
  const found = new Set();

  const audits = await Audit.find(visibleAuditFilter(user))
    .select('name reference auditType findings sections notes company classification updatedAt')
    .populate({ path: 'company', select: 'name' });

  for (const audit of audits) {
    /* The two-factor rule, which the old code did not apply — see the last section. */
    if (audit.classification === 'restricted' && !user.totpEnabled) continue;

    const auditFields = [audit.name, audit.reference, audit.auditType, audit.company?.name];
    if (auditFields.some((value) => hits(value, regex))) found.add(`engagement:${audit._id}`);

    for (const finding of audit.findings ?? []) {
      const fields = [
        finding.title,
        finding.description,
        finding.remediation,
        finding.poc,
        finding.observation,
        finding.scope,
      ];
      if (fields.some((value) => hits(value, regex))) found.add(`finding:${finding._id}`);
    }
    for (const section of audit.sections ?? []) {
      if ([section.name, section.text].some((value) => hits(value, regex))) {
        found.add(`section:${section._id}`);
      }
    }
    for (const note of audit.notes ?? []) {
      if ([note.title, note.content].some((value) => hits(value, regex))) {
        found.add(`note:${note._id}`);
      }
    }
  }
  return found;
}

/** What the endpoint said, in the oracle's vocabulary — engagement-derived types only. */
const asIds = (body) =>
  new Set(
    (body?.results ?? [])
      .filter((result) => ['engagement', 'finding', 'section', 'note'].includes(result.type))
      .map((result) => `${result.type}:${result.id}`)
  );

const difference = (a, b) => [...a].filter((entry) => !b.has(entry));

/**
 * One needle, both ways.
 *
 * Three assertions rather than one, because the two ways it can go wrong say different things: a
 * missing id is the filter having lost a result, and an extra id is the filter having admitted
 * something the scoring should have rejected. An empty oracle is the third — a comparison of two
 * empty sets passes without testing anything, so the fixture is asserted as well.
 */
async function compare(label, needle, user, session, { expectEmpty = false } = {}) {
  const expected = await oracle(needle, user);
  const { status, body, text } = await search(needle, session);
  if (status !== 200) {
    check(`${label} — "${needle}"`, false, `${status} ${text.slice(0, 160)}`);
    return;
  }
  const actual = asIds(body);
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);

  if (expectEmpty) {
    check(`${label} — "${needle}" finds nothing`, actual.size === 0, [...actual].join(', '));
    return;
  }
  check(`${label} — "${needle}" has something to find`, expected.size > 0, 'the fixture matches nothing');
  check(
    `  loses nothing (${expected.size} expected)`,
    missing.length === 0,
    `missing ${missing.join(', ')}`
  );
  check(`  and invents nothing`, extra.length === 0, `extra ${extra.join(', ')}`);
}

try {
  await Settings.getSettings();

  const lead = await User.create({
    username: 'search-lead',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'ines@example.invalid',
    password: 'SearchPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const leaver = await User.create({
    username: 'search-leaver',
    email: 'leaver@example.invalid',
    password: 'SearchPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });

  const company = await Company.create({ name: 'Xineedle Holdings', createdBy: lead._id });
  const session = signAccessToken(lead);
  const leaverSession = signAccessToken(leaver);

  /* ------------------------------------------------------------------------ */
  /* The fixture                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * The needle stored as something other than itself.
   *
   * Each of these is a real way an editor writes prose, and each one defeats a plain regex sent to
   * the database. The last two are the opposite check: phase one is allowed to admit a document
   * the scoring then rejects, and the result must still be nothing.
   */
  const STORED = [
    {
      needle: 'heartbleed',
      html: '<p>The service is vulnerable to heartbleed and has not been patched.</p>',
      why: 'plain prose, the case that always worked',
    },
    {
      needle: 'SQL injection',
      html: '<p>A classic SQL<em> injection</em> in the login form.</p>',
      why: 'a tag between the two words',
    },
    {
      needle: 'sudoers',
      html: '<p>The <b>sudo</b>ers file is world writable.</p>',
      why: 'a tag in the middle of a word',
    },
    {
      needle: 'Tom & Jerry',
      html: '<p>Credentials for Tom &amp; Jerry Ltd are reused across the estate.</p>',
      why: 'an ampersand stored as an entity',
    },
    /*
     * The next three are the opposite assertion, and they are here because they surprised me.
     *
     * `matcher` builds the needle with the space as a literal space, so a phrase never matched
     * across a paragraph break, a table cell or a non-breaking space — the parser puts `\n`, `\t`
     * and ` ` there, and none of them is a space to a literal-space regex. That is the
     * behaviour this endpoint has always had; the filter in front of it does not change it.
     *
     * They are asserted rather than left out because the tolerant needle phase one sends *does*
     * admit all three documents, so these are the cases proving an over-admitted document is
     * harmless: it is loaded, scored, rejected, and the answer is the same as it ever was. If
     * `matcher` is ever made whitespace-flexible — a one-line change, and arguably the right one —
     * these three flip to failures and say so.
     */
    {
      needle: 'admin panel',
      html: '<p>The admin</p><p>panel is exposed to the internet.</p>',
      why: 'a phrase across a paragraph break, which never matched',
      expectEmpty: true,
    },
    {
      needle: 'bearer token',
      html: '<table><tr><td>bearer</td><td>token</td></tr></table>',
      why: 'a phrase across two table cells, which never matched',
      expectEmpty: true,
    },
    {
      needle: '<script>',
      html: '<p>The field reflects &lt;script&gt; unescaped.</p>',
      why: 'angle brackets, which are never stored as themselves',
    },
    {
      needle: '10.0.5.0/24',
      html: '<p>The whole of 10.0.5.0/24 answers on 445.</p>',
      why: 'regex metacharacters in the needle',
    },
    {
      needle: 'deep scan',
      html: '<p>A deep&nbsp;scan of the range.</p>',
      why: 'a phrase across a non-breaking space, which never matched',
      expectEmpty: true,
    },
  ];

  /** One distinctive word per searchable field, so a field dropped from the filter is loud. */
  const FIELDS = {
    'finding.title': 'alphaneedle',
    'finding.description': 'betaneedle',
    'finding.remediation': 'gammaneedle',
    'finding.poc': 'deltaneedle',
    'finding.observation': 'epsilonneedle',
    'finding.scope': 'zetaneedle',
    'section.name': 'etaneedle',
    'section.text': 'thetaneedle',
    'note.title': 'iotaneedle',
    'note.content': 'kappaneedle',
    'engagement.name': 'lambdaneedle',
    'engagement.reference': 'muneedle',
    'engagement.auditType': 'nuneedle',
    'company.name': 'xineedle',
  };

  const VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N';

  await Audit.create({
    name: `Northwind portal ${FIELDS['engagement.name']}`,
    reference: `PT-2026-041-${FIELDS['engagement.reference']}`,
    auditType: `Web application ${FIELDS['engagement.auditType']}`,
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    findings: [
      /* The awkwardly-stored ones, one finding each so a lost result names itself. */
      ...STORED.map((entry, index) => ({
        identifier: index + 1,
        title: `Stored case ${index + 1}`,
        description: entry.html,
        cvssv3: VECTOR,
        createdBy: lead._id,
      })),
      {
        identifier: 90,
        title: `A finding called ${FIELDS['finding.title']}`,
        description: `<p>Body mentioning ${FIELDS['finding.description']}.</p>`,
        remediation: `<p>Fix by ${FIELDS['finding.remediation']}.</p>`,
        poc: `<p>Reproduced with ${FIELDS['finding.poc']}.</p>`,
        observation: `<p>The impact is ${FIELDS['finding.observation']}.</p>`,
        scope: `host-${FIELDS['finding.scope']}.example`,
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
    ],
    sections: [
      {
        field: 'summary',
        name: `Executive summary ${FIELDS['section.name']}`,
        text: `<p>Which says ${FIELDS['section.text']}.</p>`,
      },
    ],
    notes: [
      {
        title: `A note called ${FIELDS['note.title']}`,
        content: `<p>Reading ${FIELDS['note.content']}.</p>`,
        author: lead._id,
      },
    ],
  });

  /**
   * Enough engagements with nothing to find that the filter has something to do.
   *
   * Prose rather than empty documents: the cost this change is about is the bytes and the HTML
   * parsing, so noise that is cheap to load would make the measurement flattering and meaningless.
   */
  const NOISE_COUNT = 40;
  /*
   * Marked-up prose, not one long text node.
   *
   * The first version of this was `'...'.repeat(40)` inside a single `<p>`, and it made the parse
   * look almost free — a 2 kB text node is a scan, not a parse. Real write-ups are what this is
   * now: paragraphs, inline code, emphasis and a list, roughly fifty tags per field, which is what
   * `htmlToPlainText` actually has to build a tree out of.
   */
  const filler = (
    '<p>The host answers on <code>443/tcp</code> with a certificate that is <b>valid</b> for the ' +
    'name presented, and the response carries <em>no</em> <code>Strict-Transport-Security</code> ' +
    'header at all.</p>' +
    '<ul><li>Observed on the first pass</li><li>Confirmed on the second</li>' +
    '<li>Unchanged after the change window</li></ul>'
  ).repeat(4);
  await Audit.insertMany(
    Array.from({ length: NOISE_COUNT }, (_, index) => ({
      name: `Filler engagement ${index + 1}`,
      reference: `FILL-${index + 1}`,
      company: company._id,
      creator: lead._id,
      state: 'EDIT',
      findings: Array.from({ length: 20 }, (__, n) => ({
        identifier: n + 1,
        title: `Routine finding ${n + 1}`,
        description: filler,
        remediation: filler,
        poc: filler,
        observation: filler,
        cvssv3: VECTOR,
        createdBy: lead._id,
      })),
    }))
  );

  /* The three engagements nobody should be reading out of. */
  const trashed = await Audit.create({
    name: 'Deleted engagement',
    reference: 'PT-GONE',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    deletedAt: new Date(),
    findings: [
      {
        identifier: 1,
        title: 'A finding that was thrown away, omicronneedle',
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
    ],
  });
  const restricted = await Audit.create({
    name: 'Restricted engagement',
    reference: 'PT-RESTRICTED',
    company: company._id,
    creator: lead._id,
    state: 'EDIT',
    classification: 'restricted',
    findings: [
      {
        identifier: 1,
        title: 'Domain admin obtained, pineedle',
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
    ],
  });
  const expired = await Audit.create({
    name: 'Engagement somebody has left',
    reference: 'PT-EXPIRED',
    company: company._id,
    creator: lead._id,
    collaborators: [leaver._id],
    memberUntil: [{ user: leaver._id, until: '2020-01-01' }],
    state: 'EDIT',
    findings: [
      {
        identifier: 1,
        title: 'Only for the people still on it, rhoneedle',
        cvssv3: VECTOR,
        createdBy: lead._id,
      },
    ],
  });

  /* ------------------------------------------------------------------------ */
  console.log('\nA needle stored as something other than itself is still found:');
  for (const entry of STORED) {
    await compare(entry.why, entry.needle, lead, session, { expectEmpty: entry.expectEmpty });
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nEvery field the scoring reads is a field the filter admits:');
  for (const [field, needle] of Object.entries(FIELDS)) {
    const { body, status, text } = await search(needle, session);
    if (status !== 200) {
      check(field, false, `${status} ${text.slice(0, 140)}`);
      continue;
    }
    const expected = await oracle(needle, lead);
    const actual = asIds(body);
    check(
      `${field} (${needle})`,
      expected.size > 0 && difference(expected, actual).length === 0,
      expected.size === 0 ? 'the fixture matches nothing' : `missing ${difference(expected, actual).join(', ')}`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the filter is actually filtering:');
  {
    const { body } = await search('heartbleed', session);
    const total = await Audit.countDocuments({ deletedAt: null });
    check(
      `one engagement read, not all ${total}`,
      body.scanned === 1,
      `scanned ${body.scanned} of ${total}`
    );
    check('and it is not claiming to be capped', body.capped === false, String(body.capped));

    /*
     * What the old shape cost on this corpus, for the record rather than as a pass/fail.
     *
     * Both halves, because the load was never the expensive half: `scoreField` parses every prose
     * field of every finding into a DOM tree before it tests the regex, so the answer to "xss" was
     * an HTML parse of the firm's entire corpus. Measured rather than asserted — a threshold here
     * would fail on somebody's slower laptop and say nothing about the code.
     */
    const startedLoad = Date.now();
    const everything = await Audit.find(visibleAuditFilter(lead))
      .select('name reference auditType findings sections notes company updatedAt')
      .populate({ path: 'company', select: 'name' })
      .limit(500);
    const loadMs = Date.now() - startedLoad;

    const PROSE = ['title', 'description', 'remediation', 'poc', 'observation', 'scope'];
    let characters = 0;
    const startedParse = Date.now();
    for (const audit of everything) {
      for (const finding of audit.findings ?? []) {
        for (const field of PROSE) {
          characters += (finding[field] ?? '').length;
          htmlToPlainText(finding[field] ?? '');
        }
      }
    }
    const parseMs = Date.now() - startedParse;

    const after = Date.now();
    await search('heartbleed', session);
    const endpointMs = Date.now() - after;

    console.log(
      `        (the old shape, on this corpus: ${everything.length} engagements, ` +
        `${(characters / 1024).toFixed(0)} kB of finding prose — ${loadMs} ms to load, ` +
        `${parseMs} ms to parse it all as HTML. The endpoint now answers in ${endpointMs} ms.)`
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the three engagements it should never have been answering out of:');
  {
    await compare('trashed', 'omicronneedle', lead, session, { expectEmpty: true });
    check(
      '  the trashed engagement is really still there',
      Boolean(await Audit.findById(trashed._id)),
      'the fixture was hard-deleted, so the assertion above proves nothing'
    );

    await compare('restricted, no second factor', 'pineedle', lead, session, { expectEmpty: true });
    lead.totpEnabled = true;
    await lead.save();
    const withTotp = await search('pineedle', signAccessToken(lead));
    check(
      '  and found once two-factor is on',
      asIds(withTotp.body).has(`finding:${restricted.findings[0]._id}`),
      JSON.stringify(withTotp.body?.byType ?? {})
    );
    lead.totpEnabled = false;
    await lead.save();

    const leaverSees = await search('rhoneedle', leaverSession);
    check(
      'membership that has run out finds nothing',
      asIds(leaverSees.body).size === 0,
      [...asIds(leaverSees.body)].join(', ')
    );
    const leadSees = await search('rhoneedle', session);
    check(
      '  but the engagement is still findable by the people on it',
      asIds(leadSees.body).has(`finding:${expired.findings[0]._id}`),
      JSON.stringify(leadSees.body?.byType ?? {})
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd the answer is still the same answer:');
  {
    const { body } = await search('alphaneedle', session);
    const finding = (body.results ?? []).find((result) => result.type === 'finding');
    check('a finding hit still names the field it matched', finding?.matched === 'title', finding?.matched);
    check('  and still carries its severity', finding?.severity === 'High', finding?.severity);

    const excerpted = await search('betaneedle', session);
    const body2 = (excerpted.body.results ?? []).find((result) => result.type === 'finding');
    check(
      '  a body hit still comes with an excerpt',
      typeof body2?.excerpt === 'string' && body2.excerpt.includes('betaneedle'),
      JSON.stringify(body2?.excerpt)
    );
    check('  and names the field', body2?.matched === 'description', body2?.matched);
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
