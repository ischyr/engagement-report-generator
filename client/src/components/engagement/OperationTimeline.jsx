import { useState } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, MailCheck, Radar, Send, Target, Terminal } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';

/**
 * The operation as one chronology, above the detection log it is partly made of.
 *
 * Four logs already record dated events — the enumeration tree, the detection log, a phishing
 * campaign and the scope changes — and each of them is a separate tab and a separate table in the
 * report. Nothing put them in one order, which is the order the work actually happened in and the
 * only one a readout can be told from.
 *
 * It sits on this tab rather than getting one of its own because the question it answers is this
 * tab's question, asked properly: not "what did we log as detection" but "what did we do, and did
 * anybody notice". The composition is done on the server so the page and the report cannot
 * disagree — see `operation-timeline.service.js`, which also documents what it refuses to guess.
 */

const KINDS = {
  run: { icon: Terminal, label: 'ran', tone: 'text-fg-muted' },
  phishing: { icon: MailCheck, label: 'campaign', tone: 'text-info' },
  detection: { icon: Radar, label: 'detection', tone: 'text-med' },
  scope: { icon: Target, label: 'scope', tone: 'text-brand-300' },
  delivery: { icon: Send, label: 'report', tone: 'text-low' },
};

/**
 * How much of it is on screen to begin with, and how much each press adds.
 *
 * Ten, from the **end**. The rows are in the order things happened, which is what the card is for
 * — but the first twenty-five of them are the start of an operation that may have run for three
 * weeks, and somebody opening this tab is almost always asking what happened recently. So the
 * window sits at the newest end and is dragged backwards through the history ten at a time.
 *
 * The rows inside the window stay in their own order, oldest at the top. Reversing them would make
 * the card read as a feed, and the one thing this merge exists to show is a sequence.
 */
const STEP = 10;

export default function OperationTimeline({ audit }) {
  const { data } = useResource(`/audits/${audit._id}/timeline`, { initial: null });
  const [limit, setLimit] = useState(STEP);

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? null;
  if (!rows.length) return null;

  /* The tail, not the head: the latest `limit` events, still oldest-first among themselves. */
  const shown = limit >= rows.length ? rows : rows.slice(rows.length - limit);
  const earlier = rows.length - shown.length;
  const skippedRuns = data?.skipped?.runs ?? 0;

  return (
    <Card>
      <CardHeader
        icon={CalendarClock}
        title="The operation, in one order"
        description="Steps that were run, what the campaign did, what they noticed, when the scope moved and when the report went. This is what the red team report prints as its narrative."
      />

      {summary ? (
        <CardBody className="flex flex-wrap gap-x-8 gap-y-2 border-b border-line-soft text-xs">
          <span className="text-fg-muted">
            <span className="text-fg">{summary.actions}</span> action
            {summary.actions === 1 ? '' : 's'}
          </span>
          <span className="text-fg-muted">
            <span className="text-fg">{summary.noticed}</span> noticed
          </span>
          {/*
            The two sentences a readout turns on. Neither is knowable from any one of the four
            logs on its own, which is the whole argument for merging them.
          */}
          {summary.timeToFirstNoticedLabel ? (
            <span className="text-fg-muted">
              first noticed{' '}
              <span className="text-fg">{summary.timeToFirstNoticedLabel}</span> in
            </span>
          ) : (
            <span className="text-med">nothing was ever noticed</span>
          )}
          {summary.longestQuiet ? (
            <span className="text-fg-muted">
              longest quiet stretch <span className="text-fg">{summary.longestQuiet.label}</span>
            </span>
          ) : null}
        </CardBody>
      ) : null}

      {/*
        Above the list, because that is where the rows it reveals appear. The hidden events are
        the earlier ones and the list runs downwards in time, so a button at the foot would push
        its own result off the top of the card — the same reason every message history puts
        "earlier" at the top.
      */}
      {rows.length > STEP ? (
        <CardBody className="flex flex-wrap items-center gap-3 border-b border-line-soft py-2.5">
          <button
            type="button"
            onClick={() => setLimit(earlier ? limit + STEP : STEP)}
            className="flex items-center gap-1 text-xs text-fg-muted transition hover:text-fg"
          >
            {earlier ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {earlier ? 'Show more' : 'Show fewer'}
          </button>
          <span className="text-[0.6875rem] text-fg-subtle">
            {earlier
              ? `${earlier} earlier event${earlier === 1 ? '' : 's'} not shown`
              : `all ${rows.length} shown`}
          </span>
        </CardBody>
      ) : null}

      <CardBody className="p-0">
        <ol className="divide-y divide-line-soft">
          {shown.map((row, index) => {
            const kind = KINDS[row.kind] ?? KINDS.run;
            return (
              <li key={`${row.occurredAt}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
                <kind.icon size={14} className={cn('mt-0.5 shrink-0', kind.tone)} />
                <span className="w-36 shrink-0 text-[0.6875rem] text-fg-subtle">
                  {formatDateTime(row.occurredAt)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">{row.label}</span>
                  {row.detail ? (
                    <span className="block truncate text-[0.6875rem] text-fg-subtle">
                      {row.detail}
                    </span>
                  ) : null}
                </span>
                {row.note ? (
                  <Badge
                    tone={
                      row.kind === 'detection' ? (row.noticed ? 'warning' : 'success') : 'neutral'
                    }
                  >
                    {row.note}
                  </Badge>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardBody>

      {skippedRuns ? (
        <CardBody className="flex flex-wrap items-center gap-3 border-t border-line-soft">
          {/*
            Said rather than hidden. A step with no recorded run time is left out, because placing
            it by when somebody wrote it up would put a false event in the one list whose value is
            the sequence — so the count is on the page instead.
          */}
          <span className="text-[0.6875rem] text-fg-subtle">
            {skippedRuns} step{skippedRuns === 1 ? '' : 's'} ran without a recorded time and{' '}
            {skippedRuns === 1 ? 'is' : 'are'} not placed here.
          </span>
        </CardBody>
      ) : null}
    </Card>
  );
}
