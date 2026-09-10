import { Link, useParams } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronLeft, Clock, Minus, Plus } from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { cn, formatDate } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * One client's engagements read as a programme.
 *
 * The client page answers "what have we done for them". This answers the question the renewal
 * conversation turns on: is it getting better, what did they fix since last time, and how long did
 * it take them. Those are comparisons between engagements, and nothing was comparing them.
 *
 * The chart is bars per engagement, oldest to newest, stacked by severity — the shape a person
 * reads left to right without being told how. There is no score on it: the weighting behind
 * "better" exists to order the bars, and a client asked to accept that their security is 34 will
 * ask what 34 means.
 */
const SEVERITY = [
  ['Critical', 'bg-crit'],
  ['High', 'bg-high'],
  ['Medium', 'bg-med'],
  ['Low', 'bg-low'],
  ['None', 'bg-info'],
];

const DIRECTION = {
  better: { icon: ArrowDownRight, tone: 'text-low', words: 'Fewer and less severe than last time' },
  worse: { icon: ArrowUpRight, tone: 'text-crit', words: 'More, or more severe, than last time' },
  steady: { icon: ArrowRight, tone: 'text-fg-muted', words: 'About where it was last time' },
  unknown: { icon: Minus, tone: 'text-fg-subtle', words: 'Not enough history to say yet' },
};

export default function ProgrammePage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useResource(`/data/companies/${id}/programme`, {
    initial: null,
  });

  if (loading) return <LoadingBlock label="Reading the history…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { series, change, pace, direction, company } = data;
  const tallest = Math.max(1, ...series.map((entry) => entry.total));
  const heading = DIRECTION[direction] ?? DIRECTION.unknown;
  const Arrow = heading.icon;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={
          <Link
            to={`/clients/${id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft size={13} />
            {company.name}
          </Link>
        }
        title="The programme"
        description="Every engagement for this client in order, what changed between the last two, and how long things take to disappear."
      />

      {series.length < 2 ? (
        <Card>
          <EmptyState
            icon={Clock}
            title="One engagement so far"
            description="A programme needs two. After the next one this page will say what changed between them, what was fixed, and how long it took."
          />
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Findings, engagement by engagement"
          description="Oldest on the left. Each bar is one engagement, stacked by severity."
          actions={
            <span className={cn('flex items-center gap-1.5 text-xs', heading.tone)}>
              <Arrow size={15} />
              {heading.words}
            </span>
          }
        />
        <CardBody>
          <div className="flex items-end gap-4 overflow-x-auto pb-2">
            {series.map((entry) => (
              <Link
                key={entry._id}
                to={`/engagements/${entry._id}`}
                className="group flex min-w-24 flex-1 flex-col items-center gap-2"
                title={`${entry.name} — ${entry.total} findings`}
              >
                <span className="text-[0.625rem] text-fg-subtle">{entry.total}</span>
                {/*
                  Height by count against the tallest bar, so the shape is comparable across the
                  row. A fixed floor of a few pixels, or an engagement with one finding reads as
                  an engagement with none.
                */}
                <span
                  className="flex w-9 flex-col-reverse overflow-hidden rounded-t"
                  style={{ height: `${Math.max(6, (entry.total / tallest) * 140)}px` }}
                >
                  {SEVERITY.map(([severity, colour]) =>
                    entry.counts[severity] ? (
                      <span
                        key={severity}
                        className={cn(colour, 'w-full')}
                        style={{ flexGrow: entry.counts[severity] }}
                        title={`${entry.counts[severity]} ${severity}`}
                      />
                    ) : null
                  )}
                </span>
                <span className="w-full truncate text-center text-[0.625rem] text-fg-muted group-hover:text-fg">
                  {entry.reference || entry.name}
                </span>
                <span className="text-[0.625rem] text-fg-subtle">
                  {entry.date ? formatDate(entry.date) : '—'}
                </span>
              </Link>
            ))}
          </div>
        </CardBody>
      </Card>

      {change ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader
              icon={Minus}
              title={`Gone · ${change.gone.length}`}
              description="Present last time and not this time."
            />
            <CardBody className="flex flex-col gap-1.5">
              {change.gone.length ? (
                change.gone.map((finding) => (
                  <p key={finding._id} className="truncate text-xs text-fg-muted">
                    <Badge tone="neutral">{finding.severity}</Badge> {finding.title}
                  </p>
                ))
              ) : (
                <p className="text-xs text-fg-subtle">Nothing dropped off.</p>
              )}
              {/*
                Said plainly, because the alternative is a number somebody quotes back at a client.
                An issue can be absent because it was fixed or because nobody looked this time.
              */}
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                Absent, not proven fixed — an issue can also be missing because it was out of scope
                this time.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon={ArrowRight}
              title={`Still there · ${change.again.length}`}
              description="Reported before and found again."
            />
            <CardBody className="flex flex-col gap-1.5">
              {change.again.length ? (
                change.again.map((finding) => (
                  <p key={finding._id} className="truncate text-xs text-fg">
                    <Badge tone="warning">{finding.severity}</Badge> {finding.title}
                  </p>
                ))
              ) : (
                <p className="text-xs text-fg-subtle">Nothing came back.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon={Plus}
              title={`New · ${change.fresh.length}`}
              description="Not seen in the previous engagement."
            />
            <CardBody className="flex flex-col gap-1.5">
              {change.fresh.length ? (
                change.fresh.map((finding) => (
                  <p key={finding._id} className="truncate text-xs text-fg-muted">
                    <Badge tone="neutral">{finding.severity}</Badge> {finding.title}
                  </p>
                ))
              ) : (
                <p className="text-xs text-fg-subtle">Nothing new.</p>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {pace.cleared ? (
        <Card>
          <CardHeader
            icon={Clock}
            title="How long things take"
            description="Measured between one engagement and the next, which is the only evidence there is: a finding records no fix date."
          />
          <CardBody className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-sm text-fg">
            <span>
              <span className="text-2xl font-semibold">{pace.medianDaysToClear}</span>{' '}
              <span className="text-xs text-fg-muted">days, typically, before an issue stops appearing</span>
            </span>
            <span className="text-xs text-fg-muted">
              across {pace.cleared} issue{pace.cleared === 1 ? '' : 's'} over {pace.gaps} gap
              {pace.gaps === 1 ? '' : 's'} between engagements
            </span>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
