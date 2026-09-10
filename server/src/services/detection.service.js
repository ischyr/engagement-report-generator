/**
 * What the client's side noticed, summarised.
 *
 * The counting is here rather than in the route or the report builder because both need exactly
 * the same numbers: a tab that says "43% detected" and a report that says something else about
 * the same engagement is worse than neither saying anything.
 */

import {
  DetectionEvent,
  DETECTION_OUTCOMES,
  DETECTION_OUTCOME_LABELS,
  DETECTION_NOISE_LABELS,
} from '../models/detection-event.model.js';

/** Their telemetry has it. Whether anybody looked is the next question, not this one. */
export const NOTICED = new Set(['logged', 'alerted', 'blocked', 'contacted']);

/** Something or somebody actually acted. This is the one a client cares about. */
export const RESPONDED = new Set(['alerted', 'blocked', 'contacted']);

export const wasNoticed = (outcome) => NOTICED.has(outcome);
export const wasRespondedTo = (outcome) => RESPONDED.has(outcome);

/**
 * Loud and unnoticed — the finding, rather than a statistic.
 *
 * `logged` counts as a miss here on purpose: an action loud enough to be caught that only landed
 * in a log file is a monitoring failure, and burying it in the "noticed" column would let the
 * report congratulate a SOC that never saw it.
 */
export const isLoudMiss = (row) => row.noise === 'loud' && !RESPONDED.has(row.outcome);

const asDate = (value) => (value ? new Date(value) : null);

/** Whole minutes between two instants, or null when either end is missing. */
export function minutesBetween(from, to) {
  const start = asDate(from);
  const end = asDate(to);
  if (!start || !end) return null;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

export const detectionLatency = (row) => minutesBetween(row.occurredAt, row.detectedAt);
export const responseLatency = (row) => minutesBetween(row.occurredAt, row.respondedAt);

/**
 * A duration a sentence can hold.
 *
 * "94 min" is arithmetic; "1 h 34 min" is the thing a reader compares against their own SLA.
 */
export function describeLatency(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.round((minutes % 1440) / 60);
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

/**
 * The middle value, not the average.
 *
 * One action they noticed a week later would drag a mean far past anything that actually
 * happened, and the number is going in a report as a characterisation of their monitoring.
 */
export function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/**
 * Every number the tab and the report state about one engagement's detection log.
 *
 * @param {Array} rows plain objects or documents, in any order
 */
export function detectionSummary(rows) {
  const events = rows.map((row) => (typeof row.toObject === 'function' ? row.toObject() : row));

  const total = events.length;
  /**
   * Rows nobody has checked with the client yet are held out of every rate.
   *
   * Treating "not confirmed" as "not detected" would let an engagement look like a detection
   * failure purely because the closeout call has not happened, which is a claim about the
   * client's security made out of our own incomplete paperwork.
   */
  const confirmed = events.filter((row) => row.outcome !== 'unknown');
  const noticed = confirmed.filter((row) => wasNoticed(row.outcome));
  const responded = confirmed.filter((row) => wasRespondedTo(row.outcome));

  const detectMinutes = events.map(detectionLatency).filter((value) => value !== null);
  const respondMinutes = events.map(responseLatency).filter((value) => value !== null);

  const medianDetect = median(detectMinutes);
  const medianRespond = median(respondMinutes);

  /** Grouped by whatever the team called the technique, busiest first. */
  const techniques = [];
  for (const row of events) {
    const name = row.technique?.trim() || 'Unclassified';
    let group = techniques.find((entry) => entry.technique === name);
    if (!group) {
      group = { technique: name, total: 0, noticed: 0, responded: 0, unconfirmed: 0 };
      techniques.push(group);
    }
    group.total += 1;
    if (row.outcome === 'unknown') group.unconfirmed += 1;
    if (wasNoticed(row.outcome)) group.noticed += 1;
    if (wasRespondedTo(row.outcome)) group.responded += 1;
  }
  for (const group of techniques) {
    group.confirmed = group.total - group.unconfirmed;
    group.noticedPercent = percent(group.noticed, group.confirmed);
    group.respondedPercent = percent(group.responded, group.confirmed);
    /*
     * A group with nothing confirmed has no rate, and 0% is not the same answer.
     *
     * The percentage is still 0 for arithmetic that wants a number, but this flag exists so a
     * table does not print "0% answered" against a technique we simply have not asked about —
     * which reads as a detection failure and would be a claim we cannot support.
     */
    group.rated = group.confirmed > 0;
  }
  techniques.sort((a, b) => b.total - a.total || a.technique.localeCompare(b.technique));

  return {
    total,
    confirmed: confirmed.length,
    unconfirmed: total - confirmed.length,

    noticed: noticed.length,
    responded: responded.length,
    /** Confirmed and nothing at all happened. */
    missed: confirmed.filter((row) => row.outcome === 'not-detected').length,
    /** In their logs and nowhere else — the monitoring gap, counted separately. */
    loggedOnly: confirmed.filter((row) => row.outcome === 'logged').length,
    blocked: confirmed.filter((row) => row.outcome === 'blocked').length,

    /** Out of the confirmed rows, so an unfinished log does not flatter or damn anybody. */
    noticedPercent: percent(noticed.length, confirmed.length),
    respondedPercent: percent(responded.length, confirmed.length),

    medianDetectMinutes: medianDetect,
    medianDetect: describeLatency(medianDetect),
    medianRespondMinutes: medianRespond,
    medianRespond: describeLatency(medianRespond),
    fastestDetectMinutes: detectMinutes.length ? Math.min(...detectMinutes) : null,
    slowestDetectMinutes: detectMinutes.length ? Math.max(...detectMinutes) : null,

    /** The headline: things we were not hiding that still went unanswered. */
    loudMisses: events.filter(isLoudMiss).length,
    loudTotal: events.filter((row) => row.noise === 'loud').length,
    /** And the credit side: quiet work they caught anyway. */
    quietCatches: events.filter((row) => row.noise === 'quiet' && wasRespondedTo(row.outcome))
      .length,

    byOutcome: DETECTION_OUTCOMES.map((outcome) => ({
      outcome,
      label: DETECTION_OUTCOME_LABELS[outcome],
      count: events.filter((row) => row.outcome === outcome).length,
      percent: percent(events.filter((row) => row.outcome === outcome).length, total),
    })),
    techniques,
  };
}

/**
 * One stored event as a template sees it.
 *
 * Exported because the sample engagement builds its fixture with it. A fixture that reproduced
 * this shape by hand is how a template passes its Test render and then prints an ISO timestamp,
 * or a latency, for a real client.
 */
export function detectionRow(row, formatDateTime = (value) => String(value ?? '')) {
  const detectMinutes = detectionLatency(row);
  const respondMinutes = responseLatency(row);
  return {
    action: row.action,
    target: row.target ?? '',
    technique: row.technique ?? '',
    /** Already formatted, like every other date a template prints. */
    at: formatDateTime(row.occurredAt),
    /** The raw instant too, for a template that wants its own pattern. */
    occurredAt: row.occurredAt,

    outcome: row.outcome,
    outcomeLabel: DETECTION_OUTCOME_LABELS[row.outcome] ?? row.outcome,
    noise: row.noise,
    noiseLabel: DETECTION_NOISE_LABELS[row.noise] ?? row.noise,

    noticed: wasNoticed(row.outcome),
    responded: wasRespondedTo(row.outcome),
    /** True for a row that belongs in the "what we got away with" list. */
    loudMiss: isLoudMiss(row),

    detectedAt: row.detectedAt ? formatDateTime(row.detectedAt) : '',
    respondedAt: row.respondedAt ? formatDateTime(row.respondedAt) : '',
    detectionLatency: describeLatency(detectMinutes),
    detectionLatencyMinutes: detectMinutes,
    responseLatency: describeLatency(respondMinutes),
    responseLatencyMinutes: respondMinutes,

    source: row.source ?? '',
    notes: row.notes ?? '',
  };
}

/**
 * Everything a report needs about detection, from rows already in hand.
 *
 * Split from the query so the fixture and the real engagement go through identical code: the
 * summary is always computed from the same events the timeline prints, and the two cannot
 * describe different engagements.
 */
export function detectionReport(rows, formatDateTime) {
  const events = rows.map((row) => detectionRow(row, formatDateTime));
  return {
    events,
    recorded: events.length > 0,
    /** Just the embarrassing ones, so a template can print that table on its own. */
    loudMisses: events.filter((event) => event.loudMiss),
    summary: detectionSummary(rows),
  };
}

/**
 * The detection log shaped for a report.
 *
 * A query, so it is handed to `buildReportData()` rather than read inside it — the same
 * arrangement as scope changes, finding history, effort and the delivery record.
 *
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @param {(value: any) => string} formatDateTime how this client's reports write a timestamp
 */
export async function detectionFor(auditId, formatDateTime = (value) => String(value ?? '')) {
  const rows = await DetectionEvent.find({ audit: auditId }).sort({ occurredAt: 1, createdAt: 1 });
  return detectionReport(rows, formatDateTime);
}

export default detectionFor;
