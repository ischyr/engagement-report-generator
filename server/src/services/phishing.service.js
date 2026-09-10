/**
 * Reading a phishing campaign's results, and summarising them.
 *
 * The import is deliberately tolerant. Every phishing platform exports a different shape — some an
 * array, some an object wrapping one; some `email`, some `Email`, some `recipient`; some `true`,
 * some `"Yes"`, some `1`, some the string `"clicked"` in a status column. A strict parser would be
 * correct and useless, because the file always comes from somebody else's tool.
 *
 * So it reads what it can and *says what it did*: how many rows it recognised, how many it matched
 * to people already on the list, how many it added, and how many it could not use and why. The
 * nmap importer takes the same line, for the same reason — an import you cannot check is an import
 * you cannot trust twice.
 */

import { badRequest } from '../utils/http-error.js';
import { PhishingTarget, outcomeOf } from '../models/phishing-target.model.js';

/** Anything that plausibly holds the address. Checked in order. */
const EMAIL_KEYS = [
  'email',
  'emailaddress',
  'email_address',
  'recipient',
  'recipientemail',
  'target',
  'targetemail',
  'address',
  'to',
  'user',
  'username',
];

const NAME_KEYS = ['name', 'fullname', 'full_name', 'displayname', 'recipientname'];
const FIRST_KEYS = ['firstname', 'first_name', 'givenname', 'first'];
const LAST_KEYS = ['lastname', 'last_name', 'surname', 'familyname', 'last'];
const DEPARTMENT_KEYS = ['department', 'dept', 'team', 'division', 'ou', 'group'];
const TITLE_KEYS = ['title', 'jobtitle', 'job_title', 'position', 'role'];
const WAVE_KEYS = ['wave', 'campaign', 'batch', 'send', 'sendgroup'];
const NOTE_KEYS = ['note', 'notes', 'comment', 'comments'];

/**
 * The outcome columns, and every name a tool might give them.
 *
 * `phished` is the one that matters and the one tools name most variously — "compromised",
 * "submitted", "credentials", "success" — because each of them decided for themselves what being
 * phished means. All of those land in the same field, and a campaign that draws the line
 * differently can say so in the report.
 */
const FLAG_KEYS = {
  sent: ['sent', 'delivered', 'emailsent', 'wassent', 'issent'],
  opened: ['opened', 'open', 'emailopened', 'viewed'],
  clicked: ['clicked', 'click', 'clickedlink', 'linkclicked'],
  phished: [
    'phished',
    'compromised',
    'submitted',
    'submitteddata',
    'credentials',
    'credentialssubmitted',
    'enteredcredentials',
    'success',
    'captured',
  ],
  reported: ['reported', 'report', 'reportedphish', 'reportedtosecurity'],
};

const TIME_KEYS = {
  sentAt: ['sentat', 'senttime', 'senton', 'sentdate', 'datesent'],
  clickedAt: ['clickedat', 'clicktime', 'clickedon', 'dateclicked'],
  phishedAt: ['phishedat', 'submittedat', 'submittime', 'compromisedat', 'datesubmitted'],
  reportedAt: ['reportedat', 'reporttime', 'reportedon', 'datereported'],
};

/** Keys are compared with punctuation and case removed, so `Email_Address` finds `emailaddress`. */
const normaliseKey = (key) => String(key ?? '').toLowerCase().replace(/[\s_\-.]/g, '');

/** The first value in the row under any of these names. */
function pick(row, keys) {
  for (const key of Object.keys(row)) {
    if (keys.includes(normaliseKey(key))) {
      const value = row[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
  }
  return undefined;
}

/**
 * Whether a value means yes.
 *
 * Deliberately three-valued: `undefined` means the column was absent, which is different from a
 * column that said no. An import that turned a missing column into "false" would quietly mark
 * everybody as not having reported it, on a file that simply never mentioned reporting.
 */
export function truthy(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'sent', 'clicked', 'opened', 'submitted', 'success'].includes(text))
    return true;
  if (['no', 'n', 'false', '0', '', 'none', 'null', '-', 'n/a'].includes(text)) return false;
  return undefined;
}

const asDate = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
};

/** A loose but real check: enough to reject a header row or a name in the email column. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());

/**
 * Finds the array of rows inside whatever was uploaded.
 *
 * Tools wrap their results in a different key each time, so the shapes are tried in turn rather
 * than one being demanded. A bare array is the commonest and is handled first.
 */
export function rowsFrom(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;

  for (const key of ['targets', 'results', 'recipients', 'users', 'data', 'rows', 'items']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  // A single object with an email in it is a one-row file, which is a reasonable thing to paste.
  if (pick(parsed, EMAIL_KEYS)) return [parsed];
  return null;
}

/**
 * Turns one row into the fields worth writing, or explains why it cannot.
 *
 * Only keys that were actually present appear in `patch`, which is what lets an import of a
 * click-tracking export update clicks without claiming anything about who reported it.
 */
export function readRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { error: 'not an object' };
  }

  const email = String(pick(row, EMAIL_KEYS) ?? '').trim().toLowerCase();
  if (!email) return { error: 'no email address' };
  if (!looksLikeEmail(email)) return { error: `"${email}" is not an email address` };

  const patch = {};

  const name = pick(row, NAME_KEYS);
  if (name) patch.name = String(name).trim().slice(0, 160);
  else {
    const first = pick(row, FIRST_KEYS);
    const last = pick(row, LAST_KEYS);
    const joined = [first, last].filter(Boolean).join(' ').trim();
    if (joined) patch.name = joined.slice(0, 160);
  }

  for (const [field, keys] of [
    ['department', DEPARTMENT_KEYS],
    ['title', TITLE_KEYS],
    ['wave', WAVE_KEYS],
    ['note', NOTE_KEYS],
  ]) {
    const value = pick(row, keys);
    if (value !== undefined) patch[field] = String(value).trim().slice(0, 500);
  }

  for (const [field, keys] of Object.entries(FLAG_KEYS)) {
    const value = truthy(pick(row, keys));
    if (value !== undefined) patch[field] = value;
  }

  for (const [field, keys] of Object.entries(TIME_KEYS)) {
    const value = asDate(pick(row, keys));
    if (value !== undefined) patch[field] = value;
  }

  /*
   * A timestamp implies the thing happened.
   *
   * Exports routinely carry a click time and no click column — the time *is* the record. Only
   * filled in where the flag was absent, so a file that says "clicked: no" with a stale timestamp
   * is believed about the "no".
   */
  if (patch.clickedAt && patch.clicked === undefined) patch.clicked = true;
  if (patch.phishedAt && patch.phished === undefined) patch.phished = true;
  if (patch.reportedAt && patch.reported === undefined) patch.reported = true;
  if (patch.sentAt && patch.sent === undefined) patch.sent = true;

  /*
   * And being phished implies the steps before it.
   *
   * Somebody who submitted credentials clicked the link, whatever the export bothered to record.
   * Inferred only upwards and only where silent, so nothing contradicts a column that spoke.
   */
  if (patch.phished === true) {
    if (patch.clicked === undefined) patch.clicked = true;
    if (patch.opened === undefined) patch.opened = true;
    if (patch.sent === undefined) patch.sent = true;
  } else if (patch.clicked === true) {
    if (patch.opened === undefined) patch.opened = true;
    if (patch.sent === undefined) patch.sent = true;
  } else if (patch.opened === true && patch.sent === undefined) {
    patch.sent = true;
  }

  return { email, patch };
}

/**
 * Applies an uploaded results file to one engagement's list.
 *
 * Matched on the address, case-insensitively, so running it again corrects the same people rather
 * than duplicating them — and an address the list has never seen is added rather than dropped,
 * because a campaign's real recipient list is often only known once the tool has sent it.
 *
 * @param {string} text the raw uploaded file
 * @param {object} audit the engagement
 * @param {object} user whoever is importing
 */
export async function importResults(text, audit, user) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('That file is not valid JSON. Export the results as JSON and try again.');
  }

  const rows = rowsFrom(parsed);
  if (!rows) {
    throw badRequest(
      'No list of recipients in that file. It should be an array of rows, or an object with a ' +
        '"targets", "results" or "recipients" array.'
    );
  }
  if (rows.length > 20_000) {
    throw badRequest('That file has more than 20,000 rows. Split it and import in parts.');
  }

  const existing = await PhishingTarget.find({ audit: audit._id }).select('email');
  const known = new Set(existing.map((row) => row.email));

  const report = { rows: rows.length, updated: 0, added: 0, skipped: 0, problems: [] };
  const seen = new Set();

  for (const [index, row] of rows.entries()) {
    const { email, patch, error } = readRow(row);
    if (error) {
      report.skipped += 1;
      // Only the first few: a file with 3,000 bad rows should not answer with 3,000 sentences.
      if (report.problems.length < 5) report.problems.push(`Row ${index + 1}: ${error}`);
      continue;
    }
    /*
     * The same address twice in one file is one person. The last row wins — an export sorted by
     * event usually puts the latest last, and "they clicked, then they reported it" is the state
     * we want to end up with.
     */
    if (seen.has(email)) report.skipped += 1;
    seen.add(email);

    await PhishingTarget.updateOne(
      { audit: audit._id, email },
      {
        $set: { ...patch, updatedBy: user._id },
        $setOnInsert: { audit: audit._id, email, addedBy: user._id },
      },
      { upsert: true }
    );

    if (known.has(email)) report.updated += 1;
    else {
      report.added += 1;
      known.add(email);
    }
  }

  return report;
}

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** The middle value, not the average — one person who clicked a week later is not typical. */
function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** A duration a sentence can hold. */
export function describeMinutes(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(minutes / 1440);
  return `${days} d`;
}

/**
 * Every number the tab and the report state about one campaign.
 *
 * Rates are of the people the mail actually reached, not of the whole list: a campaign where a
 * third of the addresses bounced would otherwise report a click rate flattered by the failures.
 */
export function campaignSummary(targets) {
  const rows = targets.map((row) => (typeof row.toObject === 'function' ? row.toObject() : row));

  const total = rows.length;
  const sent = rows.filter((row) => row.sent).length;
  /** The honest denominator. Falls back to the whole list when nothing recorded a send. */
  const reached = sent || total;

  const opened = rows.filter((row) => row.opened).length;
  const clicked = rows.filter((row) => row.clicked).length;
  const phished = rows.filter((row) => row.phished).length;
  const reported = rows.filter((row) => row.reported).length;

  const minutesTo = (from, to) => {
    if (!from || !to) return null;
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Math.max(0, Math.round((end - start) / 60_000));
  };

  const clickDelays = rows.map((row) => minutesTo(row.sentAt, row.clickedAt)).filter((v) => v !== null);
  const phishDelays = rows.map((row) => minutesTo(row.sentAt, row.phishedAt)).filter((v) => v !== null);
  const reportDelays = rows
    .map((row) => minutesTo(row.sentAt, row.reportedAt))
    .filter((v) => v !== null);

  /** Per department, because "which part of the business" is what the client acts on. */
  const departments = [];
  for (const row of rows) {
    const name = row.department?.trim() || 'Not recorded';
    let group = departments.find((entry) => entry.department === name);
    if (!group) {
      group = { department: name, total: 0, phished: 0, reported: 0 };
      departments.push(group);
    }
    group.total += 1;
    if (row.phished) group.phished += 1;
    if (row.reported) group.reported += 1;
  }
  for (const group of departments) {
    group.phishedPercent = percent(group.phished, group.total);
    group.reportedPercent = percent(group.reported, group.total);
  }
  departments.sort((a, b) => b.phishedPercent - a.phishedPercent || b.total - a.total);

  const medianClick = median(clickDelays);
  const medianPhish = median(phishDelays);
  const medianReport = median(reportDelays);

  return {
    total,
    sent,
    reached,
    opened,
    clicked,
    phished,
    reported,
    /** Nobody did anything at all — neither fell for it nor reported it. */
    noResponse: rows.filter((row) => !row.opened && !row.clicked && !row.phished && !row.reported)
      .length,

    openedPercent: percent(opened, reached),
    clickedPercent: percent(clicked, reached),
    phishedPercent: percent(phished, reached),
    reportedPercent: percent(reported, reached),

    /**
     * The two numbers a debrief turns on: how fast the first person fell for it, and whether
     * anybody raised the alarm before they did.
     */
    firstClickMinutes: clickDelays.length ? Math.min(...clickDelays) : null,
    firstPhishMinutes: phishDelays.length ? Math.min(...phishDelays) : null,
    firstReportMinutes: reportDelays.length ? Math.min(...reportDelays) : null,
    medianClickMinutes: medianClick,
    medianClick: describeMinutes(medianClick),
    medianPhishMinutes: medianPhish,
    medianPhish: describeMinutes(medianPhish),
    medianReportMinutes: medianReport,
    medianReport: describeMinutes(medianReport),
    /**
     * Did anybody report it before the first person was phished?
     *
     * Null when either end is unknown. This is the single most useful thing a phishing test can
     * tell a client about their people, and it is a comparison nothing else in the app makes.
     */
    reportedBeforeFirstPhish:
      reportDelays.length && phishDelays.length
        ? Math.min(...reportDelays) < Math.min(...phishDelays)
        : null,

    departments,
    waves: [...new Set(rows.map((row) => row.wave).filter(Boolean))],
  };
}

/**
 * The campaign, drafted as a finding.
 *
 * Every number in a phishing write-up already exists — the tab computes them and the report prints
 * them — and then somebody reads them off the screen and types them into a finding, which is where
 * the "38%" that does not match the table comes from. This writes the facts instead, from the same
 * `campaignSummary()` the tab and the report use, so all three agree by construction.
 *
 * **Facts only.** The description is what happened and the impact is what that means arithmetically:
 * how many sets of credentials a real campaign would have handed over, and whether anybody raised
 * the alarm first. There is no remediation, deliberately — awareness training and a reporting
 * button are advice, not data, and this function does not know this client. That field is left
 * empty for a person to write, or for the library to fill from an entry the team already trusts.
 *
 * Pure, so what it says can be held to fixed numbers by a test rather than read off a rendered page.
 *
 * @param {ReturnType<typeof campaignSummary>} summary
 * @returns {{title:string, description:string, observation:string}}
 */
export function campaignFinding(summary) {
  const s = summary ?? {};
  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  /*
   * The title says what actually happened, worst outcome first. A campaign where nobody clicked is
   * a finding worth recording too — it is the evidence that the training worked — and calling it
   * "users submitted credentials" would be a lie in the one place nobody re-reads.
   */
  const title = s.phished
    ? 'Staff submitted credentials to a simulated phishing site'
    : s.clicked
      ? 'Staff followed a link in a simulated phishing email'
      : 'Simulated phishing campaign: no recipient engaged';

  const pct = (n) => `${n}%`;
  const of = (count) => `${count} of ${s.reached}`;

  const sent = [
    `<p>A simulated phishing message was sent to ${s.reached} recipient${s.reached === 1 ? '' : 's'}`,
    s.total > s.reached ? ` (${s.total} on the list; ${s.total - s.reached} never received it)` : '',
    (s.waves ?? []).length > 1 ? `, in ${s.waves.length} waves` : '',
    '.</p>',
  ].join('');

  const what = [
    s.opened ? `${of(s.opened)} opened it (${pct(s.openedPercent)})` : '',
    s.clicked ? `${of(s.clicked)} followed the link (${pct(s.clickedPercent)})` : '',
    s.phished ? `${of(s.phished)} went on to submit credentials (${pct(s.phishedPercent)})` : '',
    s.reported ? `${of(s.reported)} reported it (${pct(s.reportedPercent)})` : '',
  ].filter(Boolean);

  const outcome = what.length
    ? `<p>${what.slice(0, -1).join('; ')}${what.length > 1 ? '; and ' : ''}${what.at(-1)}.</p>`
    : `<p>Nobody opened it, followed it or reported it.</p>`;

  /* The timings, which are the half a table cannot show. */
  const timing = [];
  if (s.firstClickMinutes !== null && s.firstClickMinutes !== undefined) {
    timing.push(
      `The first click came ${describeMinutes(s.firstClickMinutes)} after the message was sent` +
        (s.medianClick ? `, and the median was ${s.medianClick}` : '') +
        '.'
    );
  }
  if (s.firstPhishMinutes !== null && s.firstPhishMinutes !== undefined) {
    timing.push(`The first set of credentials arrived ${describeMinutes(s.firstPhishMinutes)} in.`);
  }
  if (s.firstReportMinutes !== null && s.firstReportMinutes !== undefined) {
    timing.push(`The first report reached the security team after ${describeMinutes(s.firstReportMinutes)}.`);
  }

  const table =
    '<table><tr><th>Outcome</th><th>People</th><th>Share</th></tr>' +
    [
      ['Received the message', s.reached, ''],
      ['Opened it', s.opened, pct(s.openedPercent)],
      ['Followed the link', s.clicked, pct(s.clickedPercent)],
      ['Submitted credentials', s.phished, pct(s.phishedPercent)],
      ['Reported it', s.reported, pct(s.reportedPercent)],
      ['Did nothing at all', s.noResponse, ''],
    ]
      .map(([label, count, share]) => `<tr><td>${label}</td><td>${count}</td><td>${share}</td></tr>`)
      .join('') +
    '</table>';

  /* Per department, only when there is more than one to compare — otherwise it is the same table. */
  const departments = (s.departments ?? []).filter((row) => row.department !== 'Not recorded');
  const byDepartment =
    departments.length > 1
      ? '<p>By part of the business:</p><table><tr><th>Department</th><th>People</th>' +
        '<th>Submitted credentials</th><th>Reported it</th></tr>' +
        departments
          .map(
            (row) =>
              `<tr><td>${escape(row.department)}</td><td>${row.total}</td>` +
              `<td>${row.phished} (${pct(row.phishedPercent)})</td>` +
              `<td>${row.reported} (${pct(row.reportedPercent)})</td></tr>`
          )
          .join('') +
        '</table>'
      : '';

  const description =
    sent + outcome + (timing.length ? `<p>${timing.join(' ')}</p>` : '') + table + byDepartment;

  /*
   * The impact, which is arithmetic rather than opinion: this many working credentials, and
   * whether the alarm was raised before or after the first one was handed over.
   */
  const impact = [];
  if (s.phished) {
    impact.push(
      `<p>In a real campaign this would have put ${s.phished} working credential set${
        s.phished === 1 ? '' : 's'
      } in an attacker's hands, ${
        s.firstPhishMinutes !== null && s.firstPhishMinutes !== undefined
          ? `the first within ${describeMinutes(s.firstPhishMinutes)} of the message being sent`
          : 'without any further effort on their part'
      }.</p>`
    );
  } else if (s.clicked) {
    impact.push(
      `<p>Nobody submitted credentials, but ${of(s.clicked)} followed the link — in a campaign that ` +
        'delivered an attachment or an exploit rather than a login page, following it is the whole ' +
        'of the compromise.</p>'
    );
  }

  if (s.reportedBeforeFirstPhish === true) {
    impact.push(
      '<p>The campaign was reported before the first person submitted anything, so the security ' +
        'team had the chance to act ahead of the loss.</p>'
    );
  } else if (s.reportedBeforeFirstPhish === false) {
    impact.push(
      '<p>The first report arrived after the first credentials had already been submitted, so ' +
        'reporting did not get ahead of the loss.</p>'
    );
  } else if (!s.reported) {
    impact.push('<p>Nobody reported the message, so nothing raised the alarm at all.</p>');
  }

  return { title, description, observation: impact.join('') };
}

/** One campaign shaped for a report, alongside the summary. */
/**
 * A campaign shaped for a report, from rows already in hand.
 *
 * Split from the query for the reason `detectionReport` is: the fixture and a real engagement then
 * go through identical code. The sample used to build this shape by hand, which is how the two
 * quietly came to disagree — the fixture had no milestones, so a template proved against it
 * printed a timeline with no campaign in it and nobody could see why.
 *
 * @param {Array} rows `PhishingTarget` documents, or anything with the same fields
 * @param {(value: any) => string} formatDateTime
 */
export function campaignReport(rows, formatDateTime = (value) => String(value ?? '')) {
  const targets = rows.map((row) => ({
    email: row.email,
    name: row.name ?? '',
    department: row.department ?? '',
    title: row.title ?? '',
    wave: row.wave ?? '',
    sent: row.sent,
    opened: row.opened,
    clicked: row.clicked,
    phished: row.phished,
    reported: row.reported,
    outcome: outcomeOf(row),
    sentAt: row.sentAt ? formatDateTime(row.sentAt) : '',
    clickedAt: row.clickedAt ? formatDateTime(row.clickedAt) : '',
    phishedAt: row.phishedAt ? formatDateTime(row.phishedAt) : '',
    reportedAt: row.reportedAt ? formatDateTime(row.reportedAt) : '',
    note: row.note ?? '',
  }));

  /**
   * When the campaign's four moments happened, as instants rather than as formatted text.
   *
   * The rows above carry their dates already formatted, which is right for a table and useless to
   * anything that has to put them in order beside events from somewhere else. The operation
   * timeline needs exactly these four and none of the per-person detail — a readout says "first
   * click at 09:14", never "Dana clicked at 09:14" — so the campaign hands over its own milestones
   * and keeps the list of people to itself.
   */
  const first = (field) => {
    const dates = rows.map((row) => row[field]).filter(Boolean).map((value) => new Date(value));
    return dates.length ? new Date(Math.min(...dates.map((at) => at.getTime()))) : null;
  };
  const milestones = [
    ['sentAt', (row) => row.sent || row.sentAt],
    ['clickedAt', (row) => row.clicked || row.clickedAt],
    ['phishedAt', (row) => row.phished || row.phishedAt],
    ['reportedAt', (row) => row.reported || row.reportedAt],
  ]
    .map(([field, counts]) => ({ field, at: first(field), count: rows.filter(counts).length }))
    .filter((row) => row.at);

  return {
    targets,
    recorded: targets.length > 0,
    /** The four moments, in order, with how many people each applied to. */
    milestones,
    people: rows.length,
    /*
     * Just the people who fell for it, for a table a report can print on its own.
     *
     * Names and addresses of individuals: a template that prints this is naming employees to
     * their employer, which some engagements are explicitly not allowed to do. The per-department
     * breakdown in the summary is the version most reports should use.
     */
    phishedTargets: targets.filter((target) => target.phished),
    summary: campaignSummary(rows),
  };
}

/**
 * The campaign for one engagement, from the database.
 *
 * A query, so it is handed to `buildReportData()` rather than read inside it — the same
 * arrangement as detection, scope changes, finding history, effort and the delivery record.
 */
export async function phishingFor(auditId, formatDateTime = (value) => String(value ?? '')) {
  const rows = await PhishingTarget.find({ audit: auditId }).sort({ email: 1 });
  return campaignReport(rows, formatDateTime);
}

export default importResults;
