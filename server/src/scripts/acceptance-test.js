/**
 * Checks the risk that was accepted, and the check that was only done on nine of twelve hosts.
 *
 *   npm run test:acceptance
 *
 * Two things that change what a report *claims*, which is why they are tested together.
 *
 * **A fourth remediation status.** `accepted` is the only one that closes a finding without
 * anything being fixed: the vulnerability is still there and somebody with the authority to do so
 * decided to live with it. The failure this guards against is not an error — it is six places that
 * whitelist three statuses and fall back to `open`, quietly reporting an accepted risk as
 * outstanding and asking a client about a decision they already made.
 *
 * **Per-host checks.** A checklist was one tick for the whole engagement, so on twelve hosts
 * "tested for authentication bypass" was a coverage claim nobody could stand behind. The rule that
 * makes this safe is that `done` keeps meaning exactly what it meant — every listed host — because
 * the report, the counts, preflight and the dashboard all read it and none of them know hosts
 * exist.
 */
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit, REMEDIATION_STATUSES, checkIsDone } from '../models/audit.model.js';
import { User } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import { buildReportData } from '../services/report.service.js';
import { applyClientStatus } from '../services/share.service.js';
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

try {
  const user = await User.findOne();
  const settings = await Settings.getSettings();

  /* ------------------------------------------------------- the status itself --- */
  log.info('A risk can be accepted:');

  check('the status exists', REMEDIATION_STATUSES.includes('accepted'));
  check(
    'and the other three are untouched',
    ['open', 'retesting', 'fixed'].every((s) => REMEDIATION_STATUSES.includes(s)) &&
      REMEDIATION_STATUSES.length === 4,
    REMEDIATION_STATUSES.join()
  );

  const audit = await Audit.create({
    name: 'zz acceptance probe',
    creator: user._id,
    findings: [
      {
        title: 'zz accepted one',
        cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
        remediationStatus: 'accepted',
        riskAcceptance: {
          reason: 'Reachable only from the management VLAN; decommissioning in Q3.',
          acceptedBy: 'R. Whitfield, Head of Infrastructure',
          acceptedAt: new Date('2026-03-12'),
          reviewOn: '2026-09-01',
        },
      },
      {
        title: 'zz open one',
        cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
        remediationStatus: 'open',
      },
      {
        title: 'zz fixed one',
        cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N',
        remediationStatus: 'fixed',
      },
    ],
  });
  made.push(audit._id);

  const data = buildReportData(audit.toObject(), settings, { parts: null, numbering: null }, {
    target: 'html',
  });
  const accepted = data.findings.find((f) => f.title === 'zz accepted one');
  const open = data.findings.find((f) => f.title === 'zz open one');
  const fixed = data.findings.find((f) => f.title === 'zz fixed one');

  log.info('');
  log.info('The report tells the three apart:');

  check('it is accepted', accepted.isAccepted === true);
  check('and not fixed', accepted.isFixed === false, `isFixed ${accepted.isFixed}`);
  check('and not open', accepted.isOpen === false, `isOpen ${accepted.isOpen}`);
  check(
    'nothing is outstanding on it',
    accepted.needsWork === false,
    `needsWork ${accepted.needsWork}`
  );
  check('an open one still needs work', open.needsWork === true);
  check('and a fixed one does not', fixed.needsWork === false);
  check('the label says risk, not approval', accepted.remediationStatusLabel === 'Risk accepted', accepted.remediationStatusLabel);

  check(
    'the reason reaches the document',
    accepted.riskAccepted.reason.startsWith('Reachable only'),
    accepted.riskAccepted.reason
  );
  check('and who decided', accepted.riskAccepted.by.includes('Whitfield'), accepted.riskAccepted.by);
  check('and when', Boolean(accepted.riskAccepted.at), accepted.riskAccepted.at);
  check('and when to revisit', accepted.riskAccepted.hasReview === true, accepted.riskAccepted.reviewOn);

  log.info('');
  log.info('The counts do not pretend:');

  check('accepted is counted', data.stats.accepted === 1, `${data.stats.accepted}`);
  check('and not as fixed', data.stats.fixed === 1, `${data.stats.fixed}`);
  check('and not as open', data.stats.open === 1, `${data.stats.open}`);
  check('outstanding is open plus retesting only', data.stats.outstanding === 1, `${data.stats.outstanding}`);
  /*
   * The number that heads an executive summary. An accepted Critical counted here would contradict
   * the acceptance section three pages later.
   */
  check(
    'a serious risk the client accepted is not counted as still open',
    data.stats.openSerious === 1,
    `${data.stats.openSerious}`
  );
  check('it has its own loop', data.acceptedFindings.length === 1, `${data.acceptedFindings.length}`);
  check(
    'and the outstanding loop leaves it out',
    data.outstandingFindings.length === 1 &&
      data.outstandingFindings[0].title === 'zz open one',
    JSON.stringify(data.outstandingFindings.map((f) => f.title))
  );

  log.info('');
  log.info('The client link:');

  /*
   * Unticking an accepted finding must not quietly turn it back into an ordinary outstanding one —
   * that would erase a decision somebody signed for, through a tick on a web page.
   */
  const shareAudit = await Audit.findById(audit._id);
  const findingId = shareAudit.findings.find((f) => f.title === 'zz accepted one')._id;
  const untick = applyClientStatus(shareAudit, findingId, false, 'Dana at Northwind');
  check(
    'unticking an accepted risk leaves it accepted',
    untick.to === 'accepted',
    `${untick.from} → ${untick.to}`
  );
  const tick = applyClientStatus(shareAudit, findingId, true, 'Dana at Northwind');
  check(
    'but they can still say they fixed it after all',
    tick.to === 'fixed',
    `${tick.from} → ${tick.to}`
  );

  /* --------------------------------------------------- checks, per host --- */
  log.info('');
  log.info('A check can be tracked per host:');

  check('a check with no hosts is the flag itself', checkIsDone({ done: true, hosts: [] }) === true);
  check('and false when it is false', checkIsDone({ done: false, hosts: [] }) === false);
  check(
    'a check with hosts is done only when every host is',
    checkIsDone({ done: false, hosts: [{ done: true }, { done: true }] }) === true
  );
  check(
    'eight of nine is not done',
    checkIsDone({ done: true, hosts: [{ done: true }, { done: false }] }) === false,
    'a check claiming done over an unticked host'
  );
  check('no hosts and no flag is not done', checkIsDone({}) === false);

  const hosted = await Audit.create({
    name: 'zz per-host probe',
    creator: user._id,
    scope: [
      {
        name: 'Internal',
        hosts: [{ ip: '10.0.0.5' }, { ip: '10.0.0.6' }, { ip: '10.0.0.7' }],
      },
    ],
    testChecks: [
      {
        title: 'zz per-host check',
        category: 'Authentication',
        hosts: [
          { key: '10.0.0.5', done: true, doneAt: new Date('2026-03-01'), result: 'no bypass' },
          { key: '10.0.0.6', done: true, doneAt: new Date('2026-03-02') },
          { key: '10.0.0.7', done: false },
        ],
      },
      { title: 'zz ordinary check', category: 'Authentication', done: true },
    ],
  });
  made.push(hosted._id);

  const hostedData = buildReportData(hosted.toObject(), settings, { parts: null, numbering: null }, {
    target: 'html',
  });
  const perHost = hostedData.testChecks.find((c) => c.title === 'zz per-host check');
  const ordinary = hostedData.testChecks.find((c) => c.title === 'zz ordinary check');

  log.info('');
  log.info('And the report can say so:');

  check('the hosts reach the document', perHost.hosts.length === 3, `${perHost.hosts.length}`);
  check('it knows how many are covered', perHost.hostsDone === 2, `${perHost.hostsDone}`);
  check('and says it in words', perHost.coverage === '2 of 3 hosts', perHost.coverage);
  check(
    'a per-host note comes through',
    perHost.hosts.find((h) => h.host === '10.0.0.5')?.result === 'no bypass',
    JSON.stringify(perHost.hosts)
  );
  check(
    'an ordinary check is unchanged and carries no hosts',
    ordinary.hasHosts === false && ordinary.coverage === '' && ordinary.done === true,
    JSON.stringify({ hasHosts: ordinary.hasHosts, coverage: ordinary.coverage })
  );
  check(
    'so a template can guard on it',
    perHost.hasHosts === true && ordinary.hasHosts === false
  );
} finally {
  if (made.length) await Audit.deleteMany({ _id: { $in: made } });
  await disconnectDatabase();
}

log.info('');
log.info(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
