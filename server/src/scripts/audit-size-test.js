/**
 * Checks the readout that says how close an engagement is to the wall.
 *
 *   npm run test:audit-size
 *
 * An engagement is one MongoDB record, MongoDB refuses a record over 16 MB, and until now nothing
 * anywhere said where a given engagement stood. The failure is specific and nasty: the limit does
 * not make a page slow, it makes the *next save refuse*, mid-work, with the paragraph still on
 * screen. Everything else the app does about it is a defence — capped fields, collections moved
 * out, a 413 that explains itself. This is the part that lets somebody act before any of that.
 *
 * Two things have to be right. The number has to be the real one, because a figure that drifts
 * from what MongoDB will actually refuse is worse than none — it would be believed. And the
 * thresholds have to fire where they say they do, because a warning at 95% is a warning nobody can
 * act on.
 */
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { auditSize, describeSize, DOCUMENT_LIMIT } from '../services/audit-size.service.js';
import log from '../utils/logger.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

await connectDatabase();

const made = [];
const engagement = async (fields) => {
  const user = await User.findOne();
  const audit = await Audit.create({ name: 'zz size probe', creator: user._id, ...fields });
  made.push(audit._id);
  return audit;
};

try {
  log.info('The number is the real one:');

  const empty = await engagement({});
  const emptySize = await auditSize(empty._id);
  check('a new engagement measures something', emptySize.bytes > 0, `${emptySize.bytes}`);
  check('and it is nowhere near the limit', emptySize.level === 'fine', emptySize.level);
  check('the limit is the one MongoDB enforces', emptySize.limit === 16 * 1024 * 1024, `${emptySize.limit}`);

  /*
   * Against the database's own answer.
   *
   * `Object.bsonsize` is the client-side measure of the same document. If the aggregation and the
   * driver disagree, one of them is describing a document that is not the one being saved — and
   * the whole readout is a guess with a decimal point on it.
   */
  const raw = await Audit.collection.findOne({ _id: empty._id });
  const fromDriver = mongoose.mongo.BSON.calculateObjectSize(raw);
  check(
    'and it agrees with what the driver measures',
    Math.abs(emptySize.bytes - fromDriver) < 8,
    `${emptySize.bytes} vs ${fromDriver}`
  );

  log.info('');
  log.info('It says which part is to blame:');

  /* A quarter of a megabyte of write-up, which is the shape that actually fills an engagement. */
  const prose = 'x'.repeat(50_000);
  const heavy = await engagement({
    findings: Array.from({ length: 5 }, (_f, i) => ({
      title: `zz finding ${i}`,
      cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
      description: prose,
    })),
    notes: [{ content: 'a short note' }],
  });
  const heavySize = await auditSize(heavy._id);

  check('it is bigger than the empty one', heavySize.bytes > emptySize.bytes + 200_000, `${heavySize.bytes}`);
  check(
    'the findings are named as the largest part',
    heavySize.parts[0]?.key === 'findings',
    JSON.stringify(heavySize.parts.map((p) => p.key))
  );
  check(
    'and that part is most of the document',
    heavySize.parts[0]?.percent > 90,
    `${heavySize.parts[0]?.percent}%`
  );
  /*
   * Ordering, on a fixture where declaration order is the wrong answer.
   *
   * `findings` is listed first in the service and was also the biggest part above, so the check
   * passed whether anything sorted or not. Here the notes are the heavy part and the findings are
   * the light one, so only a real sort puts them the right way round.
   */
  const lopsided = await engagement({
    findings: [
      {
        title: 'zz small finding',
        cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
        description: 'short',
      },
    ],
    notes: [{ content: 'z'.repeat(120_000) }],
  });
  const lopsidedSize = await auditSize(lopsided._id);
  check(
    'parts come back largest first, whatever order they are declared in',
    lopsidedSize.parts[0]?.key === 'notes',
    JSON.stringify(lopsidedSize.parts.map((p) => `${p.key}:${p.bytes}`))
  );
  check(
    'and the whole list is ordered, not just its head',
    lopsidedSize.parts.every((part, i, all) => i === 0 || part.bytes <= all[i - 1].bytes),
    JSON.stringify(lopsidedSize.parts.map((p) => p.bytes))
  );
  check(
    'a part with nothing in it is not listed',
    !heavySize.parts.some((part) => part.key === 'intrusions'),
    JSON.stringify(heavySize.parts.map((p) => p.key))
  );
  check(
    'every part is smaller than the whole',
    heavySize.parts.every((part) => part.bytes < heavySize.bytes),
    JSON.stringify(heavySize.parts.map((p) => `${p.key}:${p.bytes}`))
  );

  log.info('');
  log.info('The thresholds fire where they say:');

  /*
   * Driven through the real document rather than by calling a private helper, because the
   * threshold only matters if it fires on the number the readout actually produces.
   */
  const at = async (fraction) => {
    const target = Math.floor(DOCUMENT_LIMIT * fraction);
    const audit = await engagement({});
    /* One field, sized to land the whole document on the mark. */
    const base = (await auditSize(audit._id)).bytes;
    const filler = 'y'.repeat(Math.max(0, target - base - 400));
    await Audit.collection.updateOne(
      { _id: audit._id },
      { $set: { sections: [{ field: 'executive_summary', name: 'zz', text: filler }] } }
    );
    return auditSize(audit._id);
  };

  const half = await at(0.5);
  check(`50% reads as fine (${half.percent}%)`, half.level === 'fine', `${half.percent}% ${half.level}`);

  const twoThirds = await at(0.65);
  check(
    `65% reads as a warning (${twoThirds.percent}%)`,
    twoThirds.level === 'warning',
    `${twoThirds.percent}% ${twoThirds.level}`
  );

  const nearly = await at(0.9);
  check(
    `90% reads as critical (${nearly.percent}%)`,
    nearly.level === 'critical',
    `${nearly.percent}% ${nearly.level}`
  );

  /*
   * Checked at 99.7%, not at 90%.
   *
   * Flooring and rounding agree everywhere except the last half of a percent, so a check at 90%
   * passes either way — which is what the first version of this did. The whole point of the floor
   * is the case below: an engagement with fifty kilobytes still to spare must not read as full.
   */
  const brimming = await at(0.997);
  check(
    `the percentage is floored, so it never reads full while there is room (${brimming.percent}%)`,
    brimming.percent < 100 && brimming.bytes < DOCUMENT_LIMIT,
    `${brimming.percent}% at ${brimming.bytes} of ${DOCUMENT_LIMIT}`
  );
  check('and that one is certainly critical', brimming.level === 'critical', brimming.level);
  check(
    'and the warning arrives with room to act on it',
    twoThirds.bytes < DOCUMENT_LIMIT * 0.7,
    `${(twoThirds.bytes / 1024 / 1024).toFixed(1)} MB`
  );

  log.info('');
  log.info('Saying it in one line:');

  check(
    'a quiet engagement is described without alarm',
    describeSize(half).includes('of the 16 MB') && !describeSize(half).includes('%'),
    describeSize(half)
  );
  check(
    'a full one says how full and what of',
    describeSize(nearly).includes('%') && describeSize(nearly).includes('mostly'),
    describeSize(nearly)
  );
  check('nothing measured says nothing', describeSize(null) === '', describeSize(null));

  log.info('');
  log.info('Asking about one that is not there:');
  check(
    'a missing engagement is null rather than a zero that looks like an answer',
    (await auditSize('ffffffffffffffffffffffff')) === null
  );
} finally {
  if (made.length) await Audit.deleteMany({ _id: { $in: made } });
  await disconnectDatabase();
}

log.info('');
log.info(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
