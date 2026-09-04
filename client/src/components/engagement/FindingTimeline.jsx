import {
  CircleCheck,
  FileCheck2,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Scale,
  Sparkles,
} from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Badge } from '../ui/Badge.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

const KIND_META = {
  created: { icon: Sparkles, tone: 'text-brand-300' },
  severity: { icon: Scale, tone: 'text-med' },
  'severity-cleared': { icon: Scale, tone: 'text-fg-subtle' },
  status: { icon: CircleCheck, tone: 'text-low' },
  comment: { icon: MessageSquare, tone: 'text-info' },
  delivered: { icon: FileCheck2, tone: 'text-fg-muted' },
  edited: { icon: PencilLine, tone: 'text-fg-subtle' },
};

const STATUS_WORD = { open: 'Open', retesting: 'Retesting', fixed: 'Fixed' };

/** One line of prose per event, because a table of fields is not a history anybody reads. */
function describe(event) {
  switch (event.kind) {
    case 'created':
      return event.fromLibrary ? 'Pulled in from the library' : 'Written up';
    case 'severity':
      return `Severity set to ${event.severity}${event.reason ? ` — ${event.reason}` : ''}`;
    case 'severity-cleared':
      return 'Severity override removed — back to whatever the vector says';
    case 'status':
      return `Marked ${STATUS_WORD[event.status]?.toLowerCase() ?? event.status}`;
    case 'comment':
      return event.body.length > 140 ? `${event.body.slice(0, 140)}…` : event.body;
    case 'delivered':
      return `In the report sent to the client${event.version ? ` as ${event.version}` : ''}`;
    case 'edited':
      return 'Last edited';
    default:
      return event.label;
  }
}

/**
 * What has happened to one finding, in order.
 *
 * A lifecycle rather than an edit log: when it appeared, when its rating changed and why, when
 * its status moved and who moved it, what was said about it, and which delivered versions it was
 * in. Every keystroke is in the engagement's activity feed and belongs there.
 */
export default function FindingTimeline({ auditId, findingId }) {
  const { data, loading } = useResource(
    findingId ? `/audits/${auditId}/findings/${findingId}/timeline` : null,
    { initial: null }
  );

  if (loading && !data) return <LoadingBlock label="Reading the history…" />;
  if (!data?.events?.length) return null;

  return (
    <div className="flex flex-col gap-3">
      {/*
        Marked fixed and then moved off fixed again — the single most useful thing this history
        knows, and the one nobody could previously prove.
      */}
      {data.reopened ? (
        <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
          <RotateCcw size={15} className="mt-0.5 shrink-0 text-med" />
          <span>
            <strong className="font-semibold text-fg">
              This was marked fixed and came back.
            </strong>{' '}
            Worth saying in the retest section — it is a different fact from a finding that was
            never closed.
          </span>
        </p>
      ) : null}

      <ol className="flex flex-col">
        {data.events.map((event, index) => {
          const meta = KIND_META[event.kind] ?? KIND_META.edited;
          const last = index === data.events.length - 1;
          return (
            <li key={`${event.kind}-${event.at}-${index}`} className="flex gap-3">
              {/* The rail: a dot per event, a line between them, nothing on the last. */}
              <span className="flex shrink-0 flex-col items-center">
                <span
                  className={cn(
                    'mt-1 flex size-6 items-center justify-center rounded-full bg-canvas ring-1 ring-line',
                    meta.tone
                  )}
                >
                  <meta.icon size={12} />
                </span>
                {!last ? <span className="w-px flex-1 bg-line-soft" /> : null}
              </span>

              <span className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-4')}>
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs text-fg">{describe(event)}</span>
                  {event.inferred ? (
                    // Deliveries are matched on dates rather than recorded per finding, and a
                    // timeline that presents an inference as a record is worse than one that
                    // admits it.
                    <Badge tone="neutral" title="Worked out from the dates, not recorded at the time">
                      inferred
                    </Badge>
                  ) : null}
                  {event.resolved ? <Badge tone="success">resolved</Badge> : null}
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                  {/* An unresolved reference yields no name, so the separator has to go with
                      it — otherwise the line opens with a bare "·". */}
                  {displayName(event.by) ? `${displayName(event.by)} · ` : ''}
                  <span title={formatDateTime(event.at)}>{timeAgo(event.at)}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      {data.ageDays !== null ? (
        <p className="text-[0.625rem] text-fg-subtle">
          Open for {data.ageDays} day{data.ageDays === 1 ? '' : 's'}.
          {data.versions.length
            ? ` The client has seen it in ${data.versions.join(', ')}.`
            : ' Not yet in anything sent to the client.'}
        </p>
      ) : null}
    </div>
  );
}
