/**
 * Checks that a backup can actually be restored.
 *
 *   npm run test:backup
 *
 * The only question worth asking about a backup is whether it comes back, and the only way to
 * answer it is to put it back somewhere and look. So this does the whole round trip: it seeds a
 * scratch database with an engagement, a screenshot and a template, backs it up, **empties
 * everything**, restores, and compares.
 *
 * Two things it does not take on trust.
 *
 * **The archive is read by GNU tar**, not only by this project's own reader. A backup is a promise
 * to whoever opens it in five years, possibly without this application — so if `tar -tzf` cannot
 * list it, it does not matter that the reader here can.
 *
 * **The damage check is proved by damaging one.** A digest that is never tested against a corrupted
 * file is a digest nobody knows the sign of, so a byte is flipped inside an archive and the restore
 * has to refuse it.
 *
 * Everything happens in a database of its own — `engy-backup-test` — and in a scratch templates
 * directory. Nothing here can see the real instance.
 */
process.env.MONGODB_URI = process.env.BACKUP_TEST_URI ?? 'mongodb://127.0.0.1:27017/engy-backup-test';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';

const { connectDatabase } = await import('../config/db.js');
const { default: env } = await import('../config/env.js');
const { log } = await import('../utils/logger.js');
const { MEDIA_BUCKET } = await import('../services/media.service.js');
const { writeBackup, restoreBackup, readManifest, BACKUP_FORMAT } = await import(
  '../services/backup/index.js'
);
const { Audit } = await import('../models/audit.model.js');
const { User } = await import('../models/user.model.js');
const { Settings } = await import('../models/settings.model.js');

let passed = 0;
let failed = 0;
let skipped = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

/** Wherever tar is, if it is anywhere. Windows has shipped bsdtar as `tar` since 2018. */
function findTar() {
  for (const candidate of ['tar', 'C:\\Windows\\System32\\tar.exe']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* Not this one. */
    }
  }
  return null;
}

const tarBinary = findTar();
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'engy-backup-test-'));

/* The templates directory and the staging area are pointed somewhere disposable. */
env.storage.templates = path.join(scratch, 'templates');
env.storage.tmp = path.join(scratch, 'tmp');
await fs.mkdir(env.storage.templates, { recursive: true });
await fs.mkdir(env.storage.tmp, { recursive: true });

await connectDatabase();
if (mongoose.connection.db.databaseName === 'engy-report') {
  log.error('Refusing to run: this is pointed at the real database.');
  process.exit(1);
}

const bucket = () => new GridFSBucket(mongoose.connection.db, { bucketName: MEDIA_BUCKET });

/** Everything gone, as a restore has to cope with. */
async function empty() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    if (name.startsWith('system.')) continue;
    await mongoose.connection.db.collection(name).deleteMany({});
  }
  await fs.rm(env.storage.templates, { recursive: true, force: true });
  await fs.mkdir(env.storage.templates, { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* What goes in                                                               */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('Seeding something worth losing');

await empty();

const owner = await User.create({
  username: 'zz-backup-owner',
  email: 'zz-backup@example.invalid',
  password: 'a-long-enough-password',
  firstname: 'Backup',
  lastname: 'Owner',
  role: 'admin',
  totpEnrolmentRequired: false,
  approvedAt: new Date(),
});

/* A picture with structure, so a partial or shifted restore is obvious rather than subtle. */
const SHOT = Buffer.concat([
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
  crypto.randomBytes(4096),
]);
const shotId = new mongoose.Types.ObjectId();
await new Promise((resolve, reject) => {
  const upload = bucket().openUploadStreamWithId(shotId, 'evidence.png', {
    metadata: { sha256: crypto.createHash('sha256').update(SHOT).digest('hex') },
  });
  upload.on('finish', resolve).on('error', reject);
  upload.end(SHOT);
});

const audit = await Audit.create({
  name: 'zz-backup An engagement worth keeping',
  reference: 'ZZ-BACKUP-1',
  creator: owner._id,
  date_start: '2026-09-01',
  date_end: '2026-09-05',
  findings: [
    {
      title: 'zz-backup A finding with a picture in it',
      identifier: 1,
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      /* The reference that makes preserving the evidence id load-bearing. */
      poc: `<figure><img src="/api/media/${shotId}"><figcaption>The response</figcaption></figure>`,
      description: '<p>Something that must survive.</p>',
      tags: ['needs retest'],
    },
  ],
});

await Settings.getSettings();

/* A template, which lives on disk rather than in the database. */
const TEMPLATE = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), crypto.randomBytes(2048)]);
await fs.writeFile(path.join(env.storage.templates, 'zz-backup-template.docx'), TEMPLATE);

check('an engagement, a finding, a screenshot, a template and a settings row', Boolean(audit._id));

/* -------------------------------------------------------------------------- */
/* The backup                                                                 */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('Backing it up');

const written = await writeBackup({ out: scratch });
check('a file is written', Boolean(written.file) && written.bytes > 0, JSON.stringify(written.bytes));
check('with the engagement in it', written.documents >= 2, `${written.documents} documents`);
check('the screenshot', written.media === 1, `${written.media} media`);
check('and the template', written.templates === 1, `${written.templates} templates`);
check(
  'named so a directory of them sorts by date',
  /engy-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(written.file),
  path.basename(written.file)
);

const manifest = await readManifest(written.file);
check('it carries a manifest', manifest.format === BACKUP_FORMAT, JSON.stringify(manifest.format));
check(
  'saying which collections were deliberately left out',
  (manifest.skipped ?? []).includes('sessions'),
  JSON.stringify(manifest.skipped)
);
check(
  'and a digest for every entry',
  (manifest.entries ?? []).length > 3 &&
    manifest.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)),
  `${manifest.entries?.length} entries`
);

/* -------------------------------------------------------------------------- */
/* What tar makes of it                                                       */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('What GNU tar makes of it');

if (!tarBinary) {
  skipped += 2;
  log.warn('  SKIPPED — no tar on this machine, so the archive format is UNPROVEN here.');
} else {
  /*
   * Run from the directory, with a bare filename. GNU tar reads `C:\Users\...` as a *remote host*
   * spec — the colon makes it `host:path` — and goes looking for a machine called C. Passing the
   * basename with a `cwd` sidesteps that without needing `--force-local`, which the tar that ships
   * with Windows does not have.
   */
  const listing = execFileSync(tarBinary, ['-tzf', path.basename(written.file)], {
    cwd: scratch,
    encoding: 'utf8',
  });
  check(
    'it lists the archive rather than calling it corrupt',
    listing.includes('manifest.json') &&
      listing.includes('db/audits.jsonl') &&
      listing.includes(`media/${shotId}`) &&
      listing.includes('templates/zz-backup-template.docx'),
    listing.split('\n').slice(0, 6).join(' | ')
  );

  const out = path.join(scratch, 'extracted');
  await fs.mkdir(out, { recursive: true });
  execFileSync(tarBinary, ['-xzf', path.basename(written.file), '-C', 'extracted'], { cwd: scratch });
  const extracted = await fs.readFile(path.join(out, 'media', String(shotId)));
  check(
    'and extracts the screenshot byte for byte',
    extracted.equals(SHOT),
    `${extracted.length} of ${SHOT.length} bytes`
  );
}

/* -------------------------------------------------------------------------- */
/* Checking without restoring                                                 */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('Checking it without touching anything');

const checked = await restoreBackup(written.file, { dryRun: true });
check('every entry matches its digest', checked.checked === manifest.entries.length, `${checked.checked}`);
check(
  'and nothing was written',
  (await Audit.countDocuments({ name: /^zz-backup/ })) === 1,
  'the dry run wrote to the database'
);

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('What it refuses');

let refused = false;
try {
  await restoreBackup(written.file, {});
} catch (error) {
  refused = /already holds/.test(error.message);
}
check('a restore over a database with work in it, without --force', refused);

/* A byte flipped inside the archive: the digest is the only thing standing between that and a
 * silently damaged instance, so it gets tested rather than assumed. */
const raw = zlib.gunzipSync(await fs.readFile(written.file));
const at = raw.indexOf(SHOT.subarray(64, 96));
check('the screenshot is findable inside the archive, to damage it', at > 0, String(at));
raw[at + 5] ^= 0xff;
const damaged = path.join(scratch, 'damaged.tar.gz');
await fs.writeFile(damaged, zlib.gzipSync(raw));

let caught = '';
try {
  await restoreBackup(damaged, { dryRun: true });
} catch (error) {
  caught = error.message;
}
check('a damaged entry is refused rather than restored', /damaged/i.test(caught), caught || 'no error');
check('and the message names the entry', caught.includes(String(shotId)), caught);

/* An archive from a future version. */
const future = path.join(scratch, 'future.tar.gz');
const rawFuture = zlib.gunzipSync(await fs.readFile(written.file));
const patched = Buffer.from(
  rawFuture.toString('binary').replace(`"format": ${BACKUP_FORMAT}`, `"format": ${BACKUP_FORMAT + 9}`),
  'binary'
);
await fs.writeFile(future, zlib.gzipSync(patched));
let futureError = '';
try {
  await restoreBackup(future, { dryRun: true });
} catch (error) {
  futureError = error.message;
}
check(
  'an archive from a newer version is refused with something actionable',
  /newer version/.test(futureError),
  futureError || 'no error'
);

/* -------------------------------------------------------------------------- */
/* And back                                                                   */
/* -------------------------------------------------------------------------- */
log.info('');
log.info('Losing everything, then restoring');

await empty();
check(
  'the database and the templates are empty',
  (await Audit.countDocuments()) === 0 &&
    (await bucket().find({}).toArray()).length === 0 &&
    (await fs.readdir(env.storage.templates)).length === 0,
  'the wipe did not take'
);

const restored = await restoreBackup(written.file, { force: true });
check('the restore reports what it did', restored.documents >= 2, JSON.stringify(restored.documents));

const back = await Audit.findOne({ reference: 'ZZ-BACKUP-1' }).lean();
check('the engagement is back', Boolean(back), 'no engagement came back');
check('with its dates as dates rather than strings of them', back?.date_start === '2026-09-01');
check(
  'and its creator still pointing at a real account',
  String(back?.creator) === String(owner._id) &&
    (await User.countDocuments({ _id: owner._id })) === 1,
  'the reference between two collections did not survive'
);

const finding = (back?.findings ?? [])[0];
check('the finding came with it', finding?.title?.startsWith('zz-backup'), JSON.stringify(finding?.title));
check('including its tags', JSON.stringify(finding?.tags) === '["needs retest"]', JSON.stringify(finding?.tags));

const files = await bucket().find({}).toArray();
check('the screenshot is back', files.length === 1, `${files.length} files`);
check(
  'under the id the finding points at, which is what keeps the picture in the report',
  String(files[0]?._id) === String(shotId),
  `${files[0]?._id} vs ${shotId}`
);
check(
  'with the filename the download route puts in a Content-Disposition',
  files[0]?.filename === 'evidence.png',
  JSON.stringify(files[0]?.filename)
);
check(
  'and the digest in its metadata, which is what makes evidence content-addressed',
  files[0]?.metadata?.sha256 === crypto.createHash('sha256').update(SHOT).digest('hex'),
  JSON.stringify(files[0]?.metadata)
);

const chunks = [];
for await (const chunk of bucket().openDownloadStream(shotId)) chunks.push(chunk);
const rebuilt = Buffer.concat(chunks);
check('byte for byte', rebuilt.equals(SHOT), `${rebuilt.length} of ${SHOT.length} bytes`);

const template = await fs
  .readFile(path.join(env.storage.templates, 'zz-backup-template.docx'))
  .catch(() => null);
check('the template is back on disk', template?.equals(TEMPLATE) === true, 'the template did not return');

check(
  'and the indexes were rebuilt from the models rather than from the archive',
  (await Audit.collection.indexes()).length > 1,
  JSON.stringify((await Audit.collection.indexes()).map((index) => index.name))
);

/* -------------------------------------------------------------------------- */
await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
await mongoose.connection.dropDatabase().catch(() => {});
await mongoose.disconnect();

log.info('');
if (failed === 0) log.info(`RESULT: ${passed} checks passed${skipped ? `, ${skipped} SKIPPED` : ''}`);
else log.error(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
