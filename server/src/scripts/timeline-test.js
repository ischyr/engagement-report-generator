/**
 * Checks the operation timeline.
 *
 *   npm run test:timeline
 *
 * The merge itself is easy; what is worth guarding is everything it refuses to do. A timeline that
 * quietly invents a time for a step nobody recorded one for, or that reads a detection row from
 * one shape and not the other, produces a chronology that looks authoritative and is wrong — and
 * it is printed in a document whose whole value is the order things happened in.
 */
import { operationTimeline } from '../services/operation-timeline.service.js';
import { campaignReport } from '../services/phishing.service.js';
import { detectionReport } from '../services/detection.service.js';

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

/** A day in July, at the hour given, so the fixtures read like a working day. */
const at = (day, hour, minute = 0) => new Date(2026, 6, day, hour, minute);
const kinds = (rows) => rows.map((row) => row.kind).join(',');
const labels = (rows) => rows.map((row) => row.label).join(' | ');

/* -------------------------------------------------------------------------- */
console.log('Putting four logs in one order:');

{
  const { rows, skipped } = operationTimeline({
    enumeration: [
      { title: 'External scan', tool: 'nmap', target: 'acme.example', outputAt: at(20, 9) },
      { title: 'Password spray', tool: 'kerbrute', outputAt: at(22, 14), command: 'x' },
      /* Ran, but nobody recorded when. */
      { title: 'Something we did', tool: 'crackmapexec', command: 'cme smb …', output: 'lots' },
      /* A heading in the tree: not a step, not an omission. */
      { title: 'Recon', output: '', content: '' },
    ],
    detection: [
      { action: 'Spray against the VPN', occurredAt: at(22, 14), outcome: 'missed', noise: 'loud' },
      {
        action: 'Kerberoast',
        occurredAt: at(23, 11),
        detectedAt: at(23, 11, 26),
        outcome: 'alerted',
      },
    ],
    scopeChanges: [{ agreedOn: '2026-07-21', kind: 'added', summary: 'Staging came into scope' }],
    deliveries: [{ sentAt: at(30, 17), version: '1.0' }],
  });

  check(
    'every source lands in the same list, oldest first',
    kinds(rows) === 'run,scope,run,detection,detection,delivery',
    kinds(rows)
  );
  check(
    'a step with no recorded run time is left out',
    !labels(rows).includes('Something we did'),
    labels(rows)
  );
  check('and counted, so a report can say so', skipped.runs === 1, JSON.stringify(skipped));
  check(
    'a heading in the tree is not counted as a step that vanished',
    skipped.runs === 1,
    JSON.stringify(skipped)
  );
  check(
    'a day-only event is placed at the start of its day, not at midnight UTC',
    rows.find((row) => row.kind === 'scope')?.at.getDate() === 21 &&
      rows.find((row) => row.kind === 'scope')?.at.getHours() === 0,
    String(rows.find((row) => row.kind === 'scope')?.at)
  );
  check(
    'a detection nobody saw says so',
    rows.find((row) => row.label === 'Spray against the VPN')?.note === 'Nobody noticed',
    rows.find((row) => row.label === 'Spray against the VPN')?.note
  );
  check(
    'and one they did says how long it took',
    rows.find((row) => row.label === 'Kerberoast')?.note === 'Noticed after 26 min',
    rows.find((row) => row.label === 'Kerberoast')?.note
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe shape of the time:');

{
  const { summary } = operationTimeline({
    enumeration: [
      { title: 'First thing', tool: 'nmap', outputAt: at(20, 9) },
      { title: 'Last thing', tool: 'impacket', outputAt: at(24, 12) },
    ],
    detection: [
      { action: 'Seen at last', occurredAt: at(21, 9), outcome: 'alerted' },
      /* In the middle of the quiet stretch, and not the end of it: nobody saw this one. */
      { action: 'Missed entirely', occurredAt: at(23, 9), outcome: 'missed' },
      { action: 'Seen again', occurredAt: at(24, 9), outcome: 'blocked' },
    ],
  });

  check('the first action is the first thing we did', summary.firstAction.getDate() === 20);
  check(
    'the time to the first thing anybody noticed is measured from it',
    summary.timeToFirstNoticedLabel === '1 d',
    summary.timeToFirstNoticedLabel
  );
  check(
    'the longest quiet stretch runs between the things that were noticed',
    summary.longestQuiet?.label === '3 d',
    JSON.stringify(summary.longestQuiet)
  );
  check(
    'and an action nobody noticed does not end one',
    summary.longestQuiet?.to.getDate() === 24,
    String(summary.longestQuiet?.to)
  );
  check('only the noticed ones are counted as noticed', summary.noticed === 2, `${summary.noticed}`);
}

{
  /* The stretch after the last detection is a quiet stretch too, and usually the interesting one. */
  const { summary } = operationTimeline({
    enumeration: [
      { title: 'Start', tool: 'nmap', outputAt: at(20, 9) },
      { title: 'Still going', tool: 'impacket', outputAt: at(30, 9) },
    ],
    detection: [{ action: 'Seen once, early', occurredAt: at(20, 10), outcome: 'alerted' }],
  });
  check(
    'the time after the last thing they noticed counts as quiet as well',
    summary.longestQuiet?.open === true && summary.longestQuiet?.label === '9 d 23 h',
    JSON.stringify(summary.longestQuiet)
  );
}

{
  const { summary } = operationTimeline({
    enumeration: [{ title: 'Nobody saw a thing', tool: 'nmap', outputAt: at(20, 9) }],
    detection: [{ action: 'Not confirmed', occurredAt: at(21, 9), outcome: 'unknown' }],
  });
  check(
    'nothing noticed leaves the time-to-first empty rather than zero',
    summary.timeToFirstNoticedLabel === '' && summary.firstNoticed === null,
    JSON.stringify([summary.timeToFirstNoticedLabel, summary.firstNoticed])
  );
  check(
    'and an unconfirmed outcome is not counted as a miss',
    /Not yet confirmed/.test(
      operationTimeline({
        detection: [{ action: 'x', occurredAt: at(21, 9), outcome: 'unknown' }],
      }).rows[0].note
    )
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nA campaign, as milestones rather than as people:');

const TARGETS = [
  { email: 'a@acme.example', sent: true, sentAt: at(22, 9), clicked: true, clickedAt: at(22, 9, 6), phished: true, phishedAt: at(22, 9, 8) },
  { email: 'b@acme.example', sent: true, sentAt: at(22, 9), clicked: true, clickedAt: at(22, 9, 41) },
  { email: 'c@acme.example', sent: true, sentAt: at(22, 9), reported: true, reportedAt: at(22, 9, 4) },
  { email: 'd@acme.example', sent: false },
];

{
  const { rows } = operationTimeline({ phishing: TARGETS });
  const phishing = rows.filter((row) => row.kind === 'phishing');
  check('four moments, not four people', phishing.length === 4, labels(phishing));
  check(
    'in the order they happened, which is not the order they are listed in',
    labels(phishing) ===
      'The pretext went out | First person reported it to the security team | First click on the link | First set of credentials submitted',
    labels(phishing)
  );
  check(
    'each saying how many people it applied to',
    phishing[0].detail === '3 of 4 sent' && phishing[2].detail === '2 of 4 clicked',
    JSON.stringify(phishing.map((row) => row.detail))
  );
  check(
    'and nobody is named',
    !JSON.stringify(rows).includes('acme.example'),
    JSON.stringify(rows)
  );
}

{
  /*
   * The same campaign through the report's own shaping, where the dates are already formatted
   * strings. This is the shape `buildReportData` hands over, and reading it wrongly would empty
   * the campaign out of every printed timeline while the tab still showed it.
   */
  const report = campaignReport(TARGETS, (value) => `formatted:${new Date(value).toISOString()}`);
  const { rows } = operationTimeline({ phishing: report });
  const phishing = rows.filter((row) => row.kind === 'phishing');
  check('the report shape gives the same four moments', phishing.length === 4, labels(phishing));
  check(
    'at the same times, from the milestones rather than the formatted text',
    phishing[0].at.getTime() === at(22, 9).getTime(),
    String(phishing[0].at)
  );
}

{
  /* And detection, likewise, through the shape a report holds. */
  const report = detectionReport(
    [
      {
        action: 'Kerberoast',
        occurredAt: at(23, 11),
        detectedAt: at(23, 11, 26),
        outcome: 'alerted',
        noise: 'standard',
      },
    ],
    (value) => `formatted:${new Date(value).toISOString()}`
  );
  const { rows } = operationTimeline({ detection: report.events });
  check(
    'a formatted detection row still knows when it was noticed',
    rows[0].note === 'Noticed after 26 min',
    rows[0].note
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd nothing at all:');

{
  const empty = operationTimeline({});
  check('an engagement with nothing dated has no timeline', !empty.recorded && !empty.rows.length);
  check('and a summary that says so rather than throwing', empty.summary.events === 0);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
