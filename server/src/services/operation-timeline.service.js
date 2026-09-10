/**
 * One chronology for an operation, out of the four that already exist.
 *
 * A red team readout is a story with a shape: we got in here, we did this, nothing happened for
 * three days, then somebody noticed *that* and rang the wrong person. Every piece of it is already
 * recorded — enumeration steps know when they ran, detection events know when they happened and
 * whether anybody saw them, a phishing campaign knows when the first person clicked, scope changes
 * know when they were agreed — and each of the four prints its own separate table. The reader is
 * left to interleave four tables by eye, which is exactly the work the narrative was supposed to
 * do for them.
 *
 * ## What it will not do
 *
 * **Guess a time.** An enumeration step carries `ranAt`, which is free text somebody typed, and
 * `outputAt`, which the model documents as *"the one that answers when was this last actually run,
 * and the only honest basis for calling a step stale"*. This uses `outputAt` and nothing else: a
 * step with no recorded run time is **left out and counted**, because placing it by `createdAt` —
 * when somebody wrote it up, often days later — would put a false event in a document whose whole
 * value is the order things happened in.
 *
 * **Recompute detection rates.** `detection.service.js` owns those, and two places computing the
 * same percentage is how a report ends up disagreeing with itself. What this adds is the shape of
 * the time: when the first action was, when anybody first noticed, and the longest stretch where
 * nobody did. Those are facts about a timeline and belong to the thing that has one.
 *
 * **Name individuals.** A phishing campaign is summarised as milestones — first send, first click,
 * first credential, first report to the security team, each with how many people it applied to.
 * Twenty rows saying "Dana clicked" is a list of people to be embarrassed, not a narrative, and
 * the per-person detail already lives on its own tab.
 */

import { describeLatency, minutesBetween, wasNoticed } from './detection.service.js';

/** Every row is one of these. The template groups and colours on it, so they are worth naming. */
export const TIMELINE_KINDS = ['run', 'phishing', 'detection', 'scope', 'delivery'];

const asObject = (row) => (typeof row?.toObject === 'function' ? row.toObject() : row);

/** A day string (`2026-03-04`) placed at the start of that day, in the server's own zone. */
function fromDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(at.getTime()) ? null : at;
}

const asDate = (value) => {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** The earliest of a set of dates, ignoring the ones that are not there. */
const earliest = (dates) => {
  const usable = dates.map(asDate).filter(Boolean);
  return usable.length ? new Date(Math.min(...usable.map((at) => at.getTime()))) : null;
};

/**
 * The four sources, merged and in order.
 *
 * @param {object} sources
 * @param {Array} [sources.enumeration] the engagement's steps
 * @param {Array} [sources.detection] detection events
 * @param {Array} [sources.phishing] phishing targets
 * @param {Array} [sources.scopeChanges] scope changes
 * @param {Array} [sources.deliveries] what was sent, and when
 * @param {{formatDateTime?: (value: any) => string}} [options]
 * @returns {{rows: Array, summary: object, skipped: object}}
 */
export function operationTimeline(
  { enumeration = [], detection = [], phishing = [], scopeChanges = [], deliveries = [] } = {},
  { formatDateTime = (value) => String(value ?? '') } = {}
) {
  const rows = [];
  const skipped = { runs: 0, phishing: 0, scopeChanges: 0 };

  /* ------------------------------------------------------------------ runs */
  for (const step of enumeration.map(asObject)) {
    const at = asDate(step?.outputAt);
    if (!at) {
      /* Only steps that actually ran. A section heading in the tree is not an event. */
      if (step?.command || step?.output || step?.tool) skipped.runs += 1;
      continue;
    }
    rows.push({
      at,
      kind: 'run',
      label: step.title || step.tool || 'A step was run',
      /* The tool and what it was pointed at, which is what makes a line recognisable. */
      detail: [step.tool, step.target].filter(Boolean).join(' · '),
      /* Kept so a reader can see the operator's own words about when, where they wrote any. */
      note: String(step.ranAt ?? '').trim(),
      phase: step.phase ?? '',
    });
  }

  /* ------------------------------------------------------------- detection */
  for (const event of detection.map(asObject)) {
    const at = asDate(event?.occurredAt);
    if (!at) continue;
    const noticed = event.noticed ?? wasNoticed(event.outcome);
    /*
     * Either shape. A raw event holds `detectedAt` as an instant; the report's own row has already
     * formatted it and carries the minutes instead — so this reads the number where there is one
     * and works it out where there is not, rather than parsing a date back out of a string.
     */
    const latency =
      event.detectionLatencyMinutes ?? minutesBetween(event.occurredAt, event.detectedAt);
    rows.push({
      at,
      kind: 'detection',
      label: event.action,
      detail: [event.target, event.technique].filter(Boolean).join(' · '),
      outcome: event.outcome,
      noticed,
      /* The sentence a readout turns on: seen, and how long it took. */
      note: noticed
        ? latency === null
          ? 'Noticed'
          : `Noticed after ${describeLatency(latency)}`
        : event.outcome === 'unknown'
          ? 'Not yet confirmed with the client'
          : 'Nobody noticed',
      source: event.source ?? '',
    });
  }

  /* -------------------------------------------------------------- phishing */
  const WORDING = {
    sentAt: ['sent', 'The pretext went out'],
    clickedAt: ['clicked', 'First click on the link'],
    phishedAt: ['submitted credentials', 'First set of credentials submitted'],
    reportedAt: ['reported it', 'First person reported it to the security team'],
  };

  /*
   * Either the campaign's own milestones — which is what `phishingFor` hands over, because its
   * report rows carry formatted dates — or the raw targets, for a caller holding those instead.
   */
  const campaign = asObject(phishing);
  const targets = Array.isArray(phishing) ? phishing.map(asObject) : [];
  const milestones = Array.isArray(campaign?.milestones)
    ? campaign.milestones.map((row) => ({ ...row, total: campaign.people ?? row.count }))
    : Object.keys(WORDING)
        .map((field) => ({
          field,
          at: earliest(targets.map((row) => row[field])),
          count: targets.filter((row) => row[field]).length,
          total: targets.length,
        }))
        .filter((row) => row.at);

  for (const milestone of milestones) {
    const [verb, label] = WORDING[milestone.field] ?? ['happened', 'A campaign milestone'];
    const at = asDate(milestone.at);
    if (!at) continue;
    rows.push({
      at,
      kind: 'phishing',
      label,
      detail: `${milestone.count} of ${milestone.total ?? milestone.count} ${verb}`,
      note: '',
    });
  }
  if (targets.length && !milestones.length) skipped.phishing = targets.length;

  /* ----------------------------------------------------------------- scope */
  for (const change of scopeChanges.map(asObject)) {
    const at = fromDay(change?.agreedOn);
    if (!at) {
      skipped.scopeChanges += 1;
      continue;
    }
    rows.push({
      at,
      kind: 'scope',
      label: change.summary || 'The scope changed',
      detail: [change.kind, change.agreedBy?.name || change.agreedBy?.email || '']
        .filter(Boolean)
        .join(' · '),
      note: change.channel ? `Agreed by ${change.channel}` : '',
      /* Day precision: it was agreed on a date, not at a time, and the row should not pretend. */
      dayOnly: true,
    });
  }

  /* -------------------------------------------------------------- delivery */
  for (const delivery of deliveries.map(asObject)) {
    const at = asDate(delivery?.sentAt);
    if (!at) continue;
    rows.push({
      at,
      kind: 'delivery',
      label: `Report ${delivery.version ?? ''} issued`.replace(/\s+/g, ' ').trim(),
      detail: delivery.channel ?? '',
      note: '',
    });
  }

  rows.sort((a, b) => a.at - b.at);

  /* Formatted once, here, like every other date a template prints. */
  for (const row of rows) {
    row.when = formatDateTime(row.at);
    row.occurredAt = row.at;
  }

  return { rows, summary: summarise(rows), skipped, recorded: rows.length > 0 };
}

/**
 * The shape of the time, which is the part a reader cannot see by scanning the rows.
 *
 * Deliberately only time: how long from the first thing we did to the first thing anyone noticed,
 * and the longest stretch in which nobody noticed anything. Rates, counts by outcome and the
 * median latencies belong to `detectionSummary` and are not recomputed here.
 */
function summarise(rows) {
  const actions = rows.filter((row) => row.kind === 'run' || row.kind === 'phishing');
  const noticed = rows.filter((row) => row.kind === 'detection' && row.noticed);

  const firstAction = actions[0]?.at ?? null;
  const firstNoticed = noticed[0]?.at ?? null;
  const toFirst = firstAction && firstNoticed ? minutesBetween(firstAction, firstNoticed) : null;

  /*
   * The longest quiet stretch, measured between the things that were *noticed*.
   *
   * The first stretch starts at the first action rather than at the first detection: the time
   * before anybody saw anything is the most interesting quiet of all, and a window that began at
   * the first detection would silently drop it.
   */
  let longest = null;
  let previous = firstAction;
  for (const event of noticed) {
    if (previous) {
      const minutes = minutesBetween(previous, event.at);
      if (minutes !== null && (!longest || minutes > longest.minutes)) {
        longest = { from: previous, to: event.at, minutes, label: describeLatency(minutes) };
      }
    }
    previous = event.at;
  }
  /* And the stretch from the last thing anybody noticed to the last thing we did. */
  const lastAction = actions.at(-1)?.at ?? null;
  if (previous && lastAction && lastAction > previous) {
    const minutes = minutesBetween(previous, lastAction);
    if (minutes !== null && (!longest || minutes > longest.minutes)) {
      longest = { from: previous, to: lastAction, minutes, label: describeLatency(minutes), open: true };
    }
  }

  return {
    from: rows[0]?.at ?? null,
    to: rows.at(-1)?.at ?? null,
    events: rows.length,
    actions: actions.length,
    noticed: noticed.length,
    firstAction,
    firstNoticed,
    /** Null when nothing was ever noticed, which is itself the finding. */
    timeToFirstNoticed: toFirst,
    timeToFirstNoticedLabel: toFirst === null ? '' : describeLatency(toFirst),
    longestQuiet: longest,
  };
}

export default operationTimeline;
