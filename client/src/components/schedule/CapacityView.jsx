import { useMemo, useState } from 'react';
import { CalendarOff, ChevronLeft, ChevronRight, TrendingUp, TriangleAlert } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

const todayIso = () => new Date().toISOString().slice(0, 10);
const plusDays = (from, days) =>
  new Date(new Date(`${from}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

const SPANS = [
  { weeks: 6, label: '6 weeks' },
  { weeks: 12, label: '12 weeks' },
  { weeks: 26, label: '6 months' },
];

/** A short label for a week column: the Monday's day and month. */
function weekLabel(start) {
  const [, month, day] = start.split('-');
  return `${Number(day)}/${Number(month)}`;
}

/**
 * How much of the team is spoken for, forwards.
 *
 * The Team page answers "how busy has this person been" — a window that looks backwards, by
 * design. Nothing answered "can we take a two-week job in March", which is the question that
 * decides whether work is accepted, and the only view that could have was a month calendar
 * somebody had to count by eye.
 *
 * Available days, never plain weekdays: approved leave and public holidays come off first, so a
 * week three people are away for does not read as a week with spare capacity in it.
 */
export default function CapacityView() {
  const [from, setFrom] = useState(todayIso());
  const [span, setSpan] = useState(12);

  const to = plusDays(from, span * 7 - 1);
  const { data, error, loading, reload } = useResource(
    `/schedule/capacity?from=${from}&to=${to}`,
    { initial: null }
  );

  const weeks = data?.weeks ?? [];
  const people = data?.people ?? [];

  /** The busiest week's load, so the bars compare against something real. */
  const peak = useMemo(() => Math.max(1, ...weeks.map((week) => week.available)), [weeks]);

  const step = (direction) => setFrom(plusDays(from, direction * span * 7));

  if (loading && !data) return <LoadingBlock label="Working out the weeks ahead…" />;
  if (error) return <EmptyState icon={TrendingUp} title="Could not read the forecast" description={String(error.message ?? error)} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-line-soft bg-surface/60 p-1">
          <Button variant="ghost" size="icon-sm" icon={ChevronLeft} aria-label="Earlier" onClick={() => step(-1)} />
          <span className="min-w-44 text-center text-xs text-fg-muted">
            {formatDate(weeks[0]?.start ?? from)} → {formatDate(weeks.at(-1)?.end ?? to)}
          </span>
          <Button variant="ghost" size="icon-sm" icon={ChevronRight} aria-label="Later" onClick={() => step(1)} />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setFrom(todayIso())}>
          From today
        </Button>
        <div className="flex items-center gap-1 rounded-lg border border-line-soft bg-surface/60 p-1">
          {SPANS.map((option) => (
            <button
              key={option.weeks}
              type="button"
              onClick={() => setSpan(option.weeks)}
              aria-pressed={span === option.weeks}
              className={cn(
                'rounded-md px-2 py-1 text-xs transition',
                span === option.weeks ? 'bg-raised text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-fg-muted">
          {people.length} {people.length === 1 ? 'person' : 'people'} ·{' '}
          {weeks.reduce((sum, week) => sum + week.free, 0)} free person-days ahead
        </span>
      </div>

      {/* ------------------------------------------------------- the team, by week */}
      <Card>
        <CardHeader
          icon={TrendingUp}
          title="Person-days the team actually has"
          description="Weekdays minus approved leave and public holidays, with what is already booked on top. The number under each bar is what is left."
        />
        <CardBody>
          <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
            {weeks.map((week) => {
              const height = Math.max(6, (week.available / peak) * 84);
              const bookedHeight = week.available ? (week.booked / week.available) * height : 0;
              const over = week.booked > week.available;
              return (
                <span key={week.start} className="flex min-w-11 flex-1 flex-col items-center gap-1.5">
                  <span
                    className={cn(
                      'font-mono text-[0.625rem] tabular-nums',
                      over ? 'text-med' : week.free === 0 ? 'text-fg-subtle' : 'text-fg-muted'
                    )}
                  >
                    {week.load}%
                  </span>
                  {/* One bar, filled to what is booked. A stacked pair would imply booked and
                      free are two quantities; they are one quantity and a share of it. */}
                  <span
                    className="relative flex w-full justify-center rounded-t-md bg-white/8"
                    style={{ height }}
                    title={`Week of ${week.start}: ${week.available} available person-days, ${week.booked} booked, ${week.free} free${
                      week.daysOff ? `, ${week.daysOff} day(s) off` : ''
                    }`}
                  >
                    <span
                      className={cn(
                        'absolute bottom-0 w-full rounded-t-md',
                        over ? 'bg-med/70' : 'bg-brand-400/60'
                      )}
                      style={{ height: Math.min(height, bookedHeight) }}
                    />
                  </span>
                  <span className="text-[0.5625rem] tabular-nums text-fg-subtle">
                    {weekLabel(week.start)}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[0.625rem] tabular-nums',
                      week.free === 0 ? 'text-med' : 'text-low'
                    )}
                  >
                    {week.free}
                  </span>
                </span>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* ---------------------------------------------------------- person by week */}
      <Card>
        <CardHeader
          icon={CalendarOff}
          title="Who has the room"
          description="Free weekdays per person per week — busiest first, because the reader is looking for slack. A dash is a week with nothing left."
        />
        <CardBody className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 w-full bg-surface px-2 pb-2 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  Person
                </th>
                {weeks.map((week) => (
                  <th
                    key={week.start}
                    className="w-10 px-1 pb-2 text-center text-[0.5625rem] tabular-nums text-fg-subtle"
                    title={`Week of ${week.start}`}
                  >
                    {weekLabel(week.start)}
                  </th>
                ))}
                <th className="w-14 px-2 pb-2 text-right text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  Free
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <td className="sticky left-0 z-10 max-w-64 border-t border-line-soft bg-surface px-2 py-1.5">
                    <span className="flex items-center gap-2">
                      <Avatar user={{ fullname: person.fullname, username: person.username }} size={20} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-fg">{person.fullname}</span>
                        {person.skills.length ? (
                          <span className="block truncate text-[0.5625rem] text-fg-subtle">
                            {person.skills.join(' · ')}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </td>
                  {person.weeks.map((week, index) => {
                    const full = week.freeDays === 0;
                    const away = week.daysOff >= week.weekdays && week.weekdays > 0;
                    return (
                      <td
                        key={weeks[index]?.start ?? index}
                        className="w-10 border-t border-line-soft px-1 py-1.5 text-center"
                      >
                        <span
                          title={`Week of ${weeks[index]?.start}: ${week.freeDays} free, ${week.bookedDays} booked${
                            week.daysOff ? `, ${week.daysOff} off` : ''
                          }${week.clashDays ? `, ${week.clashDays} booked while away` : ''}`}
                          className={cn(
                            'mx-auto grid size-6 place-items-center rounded-[0.25rem] font-mono text-[0.625rem] tabular-nums',
                            away
                              ? 'bg-info/15 text-info'
                              : full
                                ? 'bg-white/[0.04] text-fg-subtle'
                                : 'text-canvas'
                          )}
                          style={
                            away || full
                              ? undefined
                              : {
                                  // One hue, weighted by how much room is left — the ordinal
                                  // scale the rest of the app uses for depth.
                                  backgroundColor: 'var(--color-low)',
                                  opacity: 0.25 + Math.min(1, week.freeDays / 5) * 0.6,
                                }
                          }
                        >
                          {away ? (
                            <CalendarOff size={10} />
                          ) : week.clashDays ? (
                            <TriangleAlert size={10} className="text-med" />
                          ) : (
                            week.freeDays || '·'
                          )}
                        </span>
                      </td>
                    );
                  })}
                  <td className="w-14 border-t border-line-soft px-2 py-1.5 text-right font-mono text-xs tabular-nums">
                    <span className={person.total.freeDays === 0 ? 'text-med' : 'text-fg'}>
                      {person.total.freeDays}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
        <CardBody className="border-t border-line-soft">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.625rem] text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <span className="grid size-4 place-items-center rounded-[0.25rem]" style={{ backgroundColor: 'var(--color-low)', opacity: 0.85 }} />
              free weekdays that week
            </span>
            <span className="flex items-center gap-1.5">
              <span className="grid size-4 place-items-center rounded-[0.25rem] bg-white/[0.04] text-fg-subtle">·</span>
              nothing left
            </span>
            <span className="flex items-center gap-1.5 text-info">
              <CalendarOff size={11} />
              away all week
            </span>
            <span className="flex items-center gap-1.5 text-med">
              <TriangleAlert size={11} />
              booked on days they are away
            </span>
          </p>
          {data?.visibleEngagements === 0 ? (
            <p className="mt-2 text-[0.625rem] text-fg-subtle">
              You are not on any engagement, so the bookings counted here are all somebody
              else's — the days are real, the clients are not shown.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <p className="text-[0.625rem] leading-relaxed text-fg-subtle">
        Every booking in the instance is counted, whether or not you can see the engagement behind
        it: a forecast that only knew about your own work would say the team is free when it is
        not. Requested-but-undecided leave is not counted — it is not a day off until somebody
        approves it.
      </p>
    </div>
  );
}
