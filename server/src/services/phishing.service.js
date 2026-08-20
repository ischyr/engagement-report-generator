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

/** One campaign shaped for a report, alongside the summary. */
export async function phishingFor(auditId, formatDateTime = (value) => String(value ?? '')) {
  const rows = await PhishingTarget.find({ audit: auditId }).sort({ email: 1 });

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

  return {
    targets,
    recorded: targets.length > 0,
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

export default importResults;
