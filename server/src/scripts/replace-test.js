/**
 * Checks renaming one thing everywhere it appears.
 *
 *   npm run test:replace
 *
 * This is the only feature in the app that writes to forty fields on one click, and the only one
 * whose mistake is invisible: a substitution that ate a tag leaves a write-up that renders as
 * nonsense three weeks later, and a substitution that reached into tool output leaves a report that
 * is quietly false. So the checks here are less about the happy path than about the two promises
 * `replace.service.js` makes — text between tags and nowhere else, and output never.
 */
import {
  findEverywhere,
  replaceEverywhere,
  replaceInHtml,
  replaceInText,
} from '../services/replace.service.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const literal = (needle, flags = 'g') =>
  new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

const OLD = 'api.acme.example';
const NEW = 'api.northwind.test';

/* -------------------------------------------------------------------------- */
console.log('The HTML surgery:');

{
  const { text, count } = replaceInHtml(
    `<p>Reach <strong>${OLD}</strong> on 443.</p>`,
    literal(OLD),
    NEW
  );
  check('text between tags is replaced', text === `<p>Reach <strong>${NEW}</strong> on 443.</p>`, text);
  check('and counted once', count === 1, `${count}`);
}

{
  /* The needle is inside a stored image path, an alt and the prose. Only the prose may move. */
  const html = `<p><img src="/api/media/apiaaaaaaaaaaaaaaaaaaaaa" alt="api"> the api is exposed</p>`;
  const { text, count } = replaceInHtml(html, literal('api'), 'API');
  check(
    'an attribute is never touched, so a stored picture cannot be repointed',
    text === `<p><img src="/api/media/apiaaaaaaaaaaaaaaaaaaaaa" alt="api"> the API is exposed</p>`,
    text
  );
  check('and the attribute hits are not counted either', count === 1, `${count}`);
}

{
  const { text, count } = replaceInHtml(`<p>api<strong>.acme</strong></p>`, literal('api.acme'), 'x');
  check('a needle spanning a tag boundary is not a match', count === 0 && text.includes('<strong>'));
}

{
  const { text } = replaceInHtml(`<p>a &amp; b ${OLD}</p>`, literal(OLD), NEW);
  check('entities survive', text === `<p>a &amp; b ${NEW}</p>`, text);
}

{
  const { count } = replaceInHtml(`<p>api-acme-example</p>`, literal(OLD), NEW);
  check('the needle is literal, so a dot is a dot and not any character', count === 0, `${count}`);
}

{
  const { text, count } = replaceInHtml(`<p>API.ACME.EXAMPLE and ${OLD}</p>`, literal(OLD, 'gi'), NEW);
  check('case can be ignored when asked', count === 2 && !/ACME/.test(text), text);
}

{
  const { count } = replaceInHtml(`<p>API.ACME.EXAMPLE and ${OLD}</p>`, literal(OLD), NEW);
  check('and is not by default', count === 1, `${count}`);
}

{
  const { text, count } = replaceInText(`Weak TLS on ${OLD}`, literal(OLD), NEW);
  check('a plain field is replaced whole', text === `Weak TLS on ${NEW}` && count === 1, text);
}

{
  /* A replacement containing the needle must not be reapplied to its own output. */
  const { text, count } = replaceInText('acme', literal('acme'), 'acme-prod');
  check('the replacement is not itself rescanned', text === 'acme-prod' && count === 1, text);
}

{
  const { text, count } = replaceInHtml(undefined, literal(OLD), NEW);
  check('an empty field is not a crash', text === '' && count === 0);
}

/* -------------------------------------------------------------------------- */
console.log('\nFinding it everywhere:');

const me = { _id: 'u1', username: 'alice' };
const her = { _id: 'u2', username: 'bob' };

const engagement = () => ({
  findings: [
    {
      _id: 'f1',
      identifier: 3,
      title: `Weak TLS on ${OLD}`,
      description: `<p>The host ${OLD} negotiates TLS 1.0.</p>`,
      scope: `<p>${OLD}:443</p>`,
      poc: `<p><img src="/api/media/aaaaaaaaaaaaaaaaaaaaaaaa" alt="${OLD}"></p>`,
      observation: '<p>Nothing here.</p>',
      remediation: `<p>Reconfigure ${OLD}, then retest.</p>`,
    },
    {
      _id: 'f2',
      title: 'An unrelated finding',
      description: '<p>Somewhere else entirely.</p>',
      lockedBy: her,
      /* Held by somebody else *and* carrying the needle: this is the one that must be skipped. */
      remediation: `<p>Also mentions ${OLD}.</p>`,
    },
    {
      _id: 'f3',
      title: 'Held, but unaffected',
      description: '<p>No needle in here.</p>',
      lockedBy: her,
    },
  ],
  sections: [
    { _id: 's1', field: 'summary', name: 'Executive summary', text: `<p>We tested ${OLD}.</p>` },
  ],
  notes: [{ _id: 'n1', title: 'Day two', content: `<p>${OLD} looked promising.</p>` }],
  enumeration: [
    {
      _id: 'e1',
      title: `Scanning ${OLD}`,
      summary: `${OLD} exposes 443`,
      /* Both of these carry the needle and neither may ever be rewritten. */
      command: `nmap -sV ${OLD}`,
      output: `Nmap scan report for ${OLD}\n443/tcp open  https`,
    },
  ],
  /* Structured scope, with its own editor. Renaming prose must not silently rewrite it. */
  scope: { hosts: [{ host: OLD, ports: [443] }] },
});

const bodies = () => [{ step: { _id: 'e1' }, content: `<p>The TLS on ${OLD} is old.</p>` }];

{
  const audit = engagement();
  const { hits, total } = findEverywhere(audit, bodies(), { find: OLD });
  const where = hits.map((hit) => hit.where);

  check('a finding title is found', where.includes('finding.title'));
  check(
    'and its prose fields, each named separately',
    ['description', 'scope', 'poc', 'observation', 'remediation'].filter((field) =>
      where.includes(`finding.${field}`)
    ).length === 3,
    where.join()
  );
  check('a section is found', where.includes('section.text'));
  check('a note is found', where.includes('note.content'));
  check('a step title and its one-line summary are found', where.filter((w) => w.startsWith('step.')).length === 3, where.join());
  check('an enumeration write-up is found', where.includes('step.content'));

  check(
    'the command is never offered',
    !hits.some((hit) => hit.where.includes('command') || /nmap/.test(hit.excerpts.join())),
    hits.map((h) => h.where).join()
  );
  check(
    'the output is never offered',
    !hits.some((hit) => /Nmap scan report/.test(hit.excerpts.join()))
  );
  check(
    'the scope list is never offered',
    !hits.some((hit) => hit.where.startsWith('scope'))
  );

  check(
    'a hit only inside an attribute is not a hit at all',
    !where.includes('finding.poc'),
    where.join()
  );
  check('the total is the sum of the counts', total === hits.reduce((sum, h) => sum + h.count, 0));
  check('the total counts every occurrence, not every field', total === 10, `${total}`);

  const titled = hits.find((hit) => hit.where === 'finding.title');
  check('a hit names its finding the way the operator sees it', titled.label.startsWith('#3 Weak TLS'), titled.label);
  check('and carries the id, so the UI can link to it', titled.findingId === 'f1');
  check('a hit shows the text around it', hits[1].excerpts[0].includes(OLD), hits[1].excerpts[0]);
  check(
    'the excerpt is prose, not markup',
    !hits.some((hit) => hit.excerpts.join().includes('<p>')),
    hits.map((h) => h.excerpts).flat().join(' | ')
  );
}

{
  const audit = engagement();
  const insensitive = findEverywhere(audit, bodies(), { find: 'API.ACME.EXAMPLE', matchCase: false });
  check('an insensitive search finds the lot', insensitive.total === 10, `${insensitive.total}`);
  const sensitive = findEverywhere(audit, bodies(), { find: 'API.ACME.EXAMPLE' });
  check('a sensitive one finds none of it', sensitive.total === 0, `${sensitive.total}`);
}

/* -------------------------------------------------------------------------- */
console.log('\nDoing it:');

{
  const audit = engagement();
  const rows = bodies();
  const before = findEverywhere(audit, rows, { find: OLD }).total;
  const done = replaceEverywhere(audit, rows, { find: OLD, replace: NEW, user: me });

  check('every hit outside a locked finding is applied', done.changed === before - 1, `${done.changed} of ${before}`);
  check('the finding title moved', audit.findings[0].title === `Weak TLS on ${NEW}`, audit.findings[0].title);
  check('its prose moved', audit.findings[0].description.includes(NEW));
  check(
    'the picture in its proof did not',
    audit.findings[0].poc === `<p><img src="/api/media/aaaaaaaaaaaaaaaaaaaaaaaa" alt="${OLD}"></p>`,
    audit.findings[0].poc
  );
  check('the section moved', audit.sections[0].text.includes(NEW));
  check('the note moved', audit.notes[0].content.includes(NEW));
  check('the step title moved', audit.enumeration[0].title === `Scanning ${NEW}`);
  check('the step summary moved', audit.enumeration[0].summary === `${NEW} exposes 443`);

  check(
    'the command is untouched',
    audit.enumeration[0].command === `nmap -sV ${OLD}`,
    audit.enumeration[0].command
  );
  check('the output is untouched', audit.enumeration[0].output.includes(`for ${OLD}`));
  check('the scope list is untouched', audit.scope.hosts[0].host === OLD);

  check('a finding somebody else holds is left alone', audit.findings[1].remediation.includes(OLD));
  check('and comes back by name', done.skipped.join() === 'An unrelated finding', done.skipped.join());
  check(
    'a held finding with nothing to change is not reported as skipped',
    !done.skipped.includes('Held, but unaffected')
  );
  check('the person who did it is recorded on what changed', audit.findings[0].updatedBy === 'u1');
  check('and not on what did not', !audit.findings[2].updatedBy);

  check('the write-up comes back separately, because it lives in its own collection', done.bodies.length === 1);
  check('with its step and its new text', done.bodies[0].step === 'e1' && done.bodies[0].content.includes(NEW));
  check('and the row handed in is not mutated behind the caller', rows[0].content.includes(OLD));

  const after = findEverywhere(audit, done.bodies.map((b) => ({ step: { _id: b.step }, content: b.content })), {
    find: OLD,
  });
  check(
    'afterwards only the locked finding still carries it',
    after.hits.length === 1 && after.hits[0].findingId === 'f2',
    after.hits.map((h) => h.where).join()
  );
}

{
  /* Deleting a string, rather than swapping one: the replace field is allowed to be empty. */
  const audit = engagement();
  const done = replaceEverywhere(audit, [], { find: `on ${OLD}`, replace: '', user: me });
  check('an empty replacement deletes', audit.findings[0].title === 'Weak TLS ' && done.changed === 1, audit.findings[0].title);
}

{
  /* Nobody holds anything: the lock check must not mistake an own lock for someone else's. */
  const audit = engagement();
  audit.findings[1].lockedBy = me;
  const done = replaceEverywhere(audit, [], { find: OLD, replace: NEW, user: me });
  check('a finding you hold yourself is yours to change', !done.skipped.length && audit.findings[1].remediation.includes(NEW));
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
