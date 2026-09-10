/**
 * Per-recipient copies, end to end, against a real database.
 *
 *   npm run test:copies
 *
 * The claim being tested is not "a document was produced". It is: **given a loose file and nothing
 * else, the register names the person it was given to.** Everything here builds towards asking that
 * question the way it gets asked in real life, with a hash and no idea which engagement it came
 * from.
 *
 * So the test renders four copies of one report, throws away everything except the bytes of the
 * third, and then asks the register who had it. If that answer is ever wrong the feature is worse
 * than absent, because somebody will act on it.
 *
 * Its own scratch database, dropped at the end, like the other database-backed suites.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Delivery } from '../models/delivery.model.js';
import { RenderRecord } from '../models/render-record.model.js';
import { Settings } from '../models/settings.model.js';
import { Template } from '../models/template.model.js';
import { User } from '../models/user.model.js';
import { generateReport } from '../services/report.service.js';
import { copyLabel } from '../services/provenance.service.js';
import { deliveryRegister } from '../services/delivery-register.service.js';
import { generateSigningKey, signBytes, verifyBytes } from '../services/signing.service.js';
import { outputHash } from '../services/provenance.service.js';
import env from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config/env.js';

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

/** Declared out here so the cleanup below can remove it whatever happens in between. */
let templateFile = '';

const uri = `mongodb://127.0.0.1:27017/engy-copies-test-${Date.now()}`;
await mongoose.connect(uri);

try {
  /* ------------------------------------------------------------------ set up */
  const settings = await Settings.getSettings();
  const key = generateSigningKey();
  settings.signing = { ...key, enabled: true, createdBy: null };
  settings.markModified('signing');
  await settings.save();

  const lead = await User.create({
    username: 'copies-lead',
    firstname: 'Nadia',
    lastname: 'Okonjo',
    email: 'nadia@example.invalid',
    password: 'CopiesPass123!',
    role: 'user',
    enabled: true,
    approvedAt: new Date(),
  });

  const company = await Company.create({ name: 'Northwind Logistics', createdBy: lead._id });

  /*
   * The template a real instance has, which is the one `npm run make:template` writes.
   *
   * Whether it happens to print the copy marking is a fact this test reports rather than requires:
   * "traceable" is the promise that has to hold for every template, and "marked" is the one that
   * depends on what the template does with the label it is offered.
   */
  const templateSource = path.join(ROOT_DIR, 'DEFAULT_PENTEST_REPORT.docx');
  if (!fs.existsSync(templateSource)) {
    console.error(`\nNo template at ${templateSource}.\nRun: npm run make:template\n`);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    process.exit(1);
  }

  templateFile = `copies-test-${Date.now()}.docx`;
  fs.mkdirSync(env.storage.templates, { recursive: true });
  fs.copyFileSync(templateSource, path.join(env.storage.templates, templateFile));

  const template = await Template.create({
    name: `Copies test template ${Date.now()}`,
    kind: 'docx',
    filename: templateFile,
    createdBy: lead._id,
  });

  const audit = await Audit.create({
    name: 'Northwind Logistics Shipment Portal Assessment',
    reference: 'PT-2026-041',
    company: company._id,
    template: template._id,
    creator: lead._id,
    collaborators: [lead._id],
    state: 'REVIEW',
    findings: [
      {
        identifier: 1,
        title: 'Shipment documents readable without authentication',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        description: '<p>The document endpoint returns a waybill to anybody who asks for it.</p>',
        createdBy: lead._id,
      },
    ],
  });

  const recipients = [
    { name: 'Marijke de Vries', email: 'marijke@northwind-logistics.example' },
    { name: 'Dana Petrescu', email: 'dana@northwind-logistics.example' },
    { name: 'Sam Okoye', email: 'sam@northwind-logistics.example' },
    { name: 'Priya Raman', email: 'priya@northwind-logistics.example' },
  ];

  /* --------------------------------------------------------------- the copies */
  console.log('\nFour copies of one report:');
  const made = [];
  for (const [index, recipient] of recipients.entries()) {
    const copy = { recipient: recipient.name, number: index + 1, of: recipients.length };
    const { buffer, provenance } = await generateReport({
      audit,
      template,
      settings,
      user: lead,
      copy,
    });
    made.push({ ...recipient, copy, buffer, provenance });
  }

  check('all four rendered', made.length === 4);
  check(
    'every one has different bytes',
    new Set(made.map((entry) => entry.provenance.outputHash)).size === 4,
    'two copies hashed the same, so a hash cannot identify one'
  );
  check(
    'each carries its recipient in the document properties',
    made.every((entry, index) => entry.provenance.copy?.for === recipients[index].name),
    JSON.stringify(made.map((entry) => entry.provenance.copy?.for))
  );
  check(
    'numbered one to four',
    made.every((entry, index) => entry.provenance.copy.number === index + 1 && entry.provenance.copy.of === 4)
  );
  check(
    'and the label reads the way it will be printed',
    made[2].provenance.copy.label === 'Prepared for Sam Okoye · copy 3 of 4',
    made[2].provenance.copy.label
  );
  check(
    'an ordinary render has no copy at all',
    (await generateReport({ audit, template, settings, user: lead })).provenance.copy === null
  );

  /* Whether the marking reached the page. Reported either way: see the note above. */
  const { default: PizZip } = await import('pizzip');
  const printed = (buffer, label) => {
    const zip = new PizZip(buffer);
    return Object.keys(zip.files)
      .filter((name) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))
      .some((name) =>
        zip.file(name).asText().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').includes(label.split(' · ')[0])
      );
  };
  const marked = printed(made[0].buffer, made[0].provenance.copy.label);
  /*
   * An assertion rather than a note, now that the template which ships does print it.
   *
   * The visible line is the whole deterrent. Tracing is what happens after a leak; the footer is
   * what makes somebody think twice before forwarding the file. An edit to the starter footer
   * that dropped it would leave every promise in the code true and the feature pointless, and
   * nothing else in this suite would notice.
   */
  check(
    'and the template that ships prints it where a reader will see it',
    marked,
    'the starter footer no longer carries {{#isCopy}}{{ copyLabel }}{{/isCopy}}. If it has not been rebuilt since that was added, run: npm run make:template'
  );

  /* ------------------------------------------------------------ the signature */
  console.log('\nEach copy is signed on its own:');
  const signatures = made.map((entry) => signBytes(entry.buffer, settings));
  check(
    'every signature verifies against its own copy',
    signatures.every((signature, index) => verifyBytes(made[index].buffer, signature.value, key.publicKey))
  );
  check(
    'and none verifies against another copy',
    signatures.every((signature, index) =>
      made.every((entry, other) => other === index || !verifyBytes(entry.buffer, signature.value, key.publicKey))
    ),
    'a signature verified a document it was not made for'
  );

  /* -------------------------------------------------------------- the register */
  console.log('\nRecorded as one delivery to four people:');
  await Delivery.create({
    audit: audit._id,
    version: '1.0',
    sentAt: new Date(),
    channel: 'email',
    recipients: made.map((entry) => ({
      name: entry.name,
      email: entry.email,
      copyNumber: entry.copy.number,
      fileHash: entry.provenance.outputHash,
    })),
    copies: made.length,
    filename: 'Northwind Logistics - PT-2026-041.docx',
    fileHash: made[0].provenance.outputHash,
    kind: 'docx',
    sentBy: lead._id,
    createdBy: lead._id,
  });

  const register = await deliveryRegister(lead, {});
  check('the register shows one delivery', register.deliveries.length === 1, `${register.deliveries.length}`);
  check('which says it is four copies', register.deliveries[0]?.copies === 4);
  check(
    'and carries a hash per recipient',
    (register.deliveries[0]?.recipients ?? []).every((entry) => /^[a-f0-9]{64}$/.test(entry.fileHash))
  );

  /* ------------------------------------------------------------ the real question */
  console.log('\nA loose file, and nothing else:');
  {
    /* Somebody sends us a document. All we have is its bytes. */
    const leaked = made[2].buffer;
    const hash = outputHash(leaked);

    const found = await deliveryRegister(lead, { hash });
    check('the register finds it', found.match?.found === 1, JSON.stringify(found.match));
    check(
      'and names the person it was given to',
      found.match?.copy?.name === 'Sam Okoye',
      JSON.stringify(found.match?.copy)
    );
    check('with the copy number', found.match?.copy?.number === 3, `${found.match?.copy?.number}`);
    check('out of how many', found.match?.copy?.of === 4, `${found.match?.copy?.of}`);

    /* And the shared-bytes case still behaves: the first copy's hash is the delivery's own. */
    const first = await deliveryRegister(lead, { hash: made[0].provenance.outputHash });
    check('the delivery hash is found too', first.match?.found === 1);
    check(
      'and it is attributed, because that copy was made for somebody as well',
      first.match?.copy?.name === 'Marijke de Vries',
      JSON.stringify(first.match?.copy)
    );

    /* A file we never sent. */
    const stranger = await deliveryRegister(lead, { hash: crypto.randomBytes(32).toString('hex') });
    check('a file that never came from here is not found', stranger.match?.found === 0);
    check('and nobody is named for it', stranger.match?.copy === null);
  }

  console.log('\nThe render records:');
  {
    /* Written by the route rather than by generateReport, so here they are created as it would. */
    for (const entry of made) {
      await RenderRecord.create({
        ...entry.provenance,
        kind: 'report',
        audit: audit._id,
        signature: signBytes(entry.buffer, settings),
        copy: {
          for: entry.provenance.copy.for,
          number: entry.provenance.copy.number,
          of: entry.provenance.copy.of,
          marked,
        },
      });
    }
    const records = await RenderRecord.find({ audit: audit._id }).lean();
    check('one per copy', records.length === 4, `${records.length}`);
    check(
      'each with a signature and the fingerprint of the key that made it',
      records.every((row) => row.signature?.value && row.signature.fingerprint === key.fingerprint)
    );
    check(
      'and a render id that appears in the document itself',
      records.every((row) => {
        const entry = made.find((item) => item.provenance.renderId === row.renderId);
        if (!entry) return false;
        const zip = new PizZip(entry.buffer);
        return zip.file('docProps/custom.xml')?.asText().includes(row.renderId);
      }),
      'a file could not be matched to its record by the id inside it'
    );
    check(
      'the copy marking is in the properties as well',
      made.every((entry) =>
        new PizZip(entry.buffer).file('docProps/custom.xml')?.asText().includes(entry.name)
      ),
      'the recipient is not in the document properties, so a stripped file is untraceable'
    );
  }

  /* And the label's own edge: one recipient is not "copy 1 of 1". */
  console.log('\nThe wording:');
  check(
    'a single recipient is not told they are one of one',
    copyLabel({ recipient: 'Marijke de Vries', number: 1, of: 1 }) === 'Prepared for Marijke de Vries',
    copyLabel({ recipient: 'Marijke de Vries', number: 1, of: 1 })
  );
  check('and no recipient means no label', copyLabel({ number: 1, of: 3 }) === '');
} finally {
  /* The scratch database and the template copy, both. */
  if (templateFile) {
    fs.rmSync(path.join(env.storage.templates, templateFile), { force: true });
  }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
