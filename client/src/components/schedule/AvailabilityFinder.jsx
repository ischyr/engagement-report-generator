import { useEffect, useMemo, useState } from 'react';
import { CalendarOff, EyeOff, Search, TriangleAlert, UserCheck } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn, formatDate } from '../../lib/utils.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select } from '../ui/Field.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import SkillPips from '../team/SkillPips.jsx';
import { levelOf } from '../team/skills-meta.js';
import { leaveMeta } from './leave-meta.js';

const todayIso = () => new Date().toISOString().slice(0, 10);
const plusDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Who is free, and who is free *and* able.
 *
 * Three things were already recorded and never joined: what people can do, what they have
 * promised, and when they are away. Staffing a job meant opening two pages and doing the
 * overlap in your head — which is the arithmetic that ends with somebody booked into their own
 * holiday.
 *
 * Ranked by whether they could do the work before how free they are: a clear fortnight from
 * somebody who has never touched Active Directory is not an answer to "who can run this Active
 * Directory job", and sorting on free days alone puts them at the top.
 */
export default function AvailabilityFinder({ open, onClose, onBook }) {
  const [skill, setSkill] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(plusDays(27));
  const [minLevel, setMinLevel] = useState('');

  // The skill list comes from the same place the Skills page reads, so the two agree about
  // what a skill is called and how deep the team is in it.
  const roster = useResource(open ? '/users/skills' : null, { initial: null });
  const skills = roster.data?.skills ?? [];

  const query = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (skill) params.set('skill', skill);
    if (minLevel) params.set('level', minLevel);
    return params.toString();
  }, [from, to, skill, minLevel]);

  const { data, loading, reload } = useResource(open ? `/schedule/availability?${query}` : null, {
    initial: null,
  });

  useEffect(() => {
    if (open) reload({ quiet: true });
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = data?.candidates ?? [];
  const weekdays = data?.window?.weekdays ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Who is free?"
      description="Availability and ability in one answer — bookings and approved leave taken off, whether or not you can see the engagement behind them."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Skill"
            wrapperClassName="sm:col-span-2"
            hint={
              skill
                ? `${skills.find((entry) => entry.name === skill)?.depth ?? 0} people could take this work on`
                : 'Leave it as anybody to see the whole team’s availability.'
            }
            value={skill}
            onChange={(event) => setSkill(event.target.value)}
            options={[
              { value: '', label: 'Anybody' },
              ...skills.map((entry) => ({
                value: entry.name,
                label: `${entry.name} — ${entry.depth} deep of ${entry.people}`,
              })),
            ]}
          />
          <Input label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <Input
            label="To"
            type="date"
            hint={weekdays ? `${weekdays} weekdays in that range` : undefined}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          {skill ? (
            <Select
              label="At least"
              wrapperClassName="sm:col-span-2"
              hint="Somebody learning a thing cannot be handed the job — but they can be put beside somebody who can."
              value={minLevel}
              onChange={(event) => setMinLevel(event.target.value)}
              options={[
                { value: '', label: 'Any level' },
                { value: 'working', label: 'Working knowledge or better' },
                { value: 'strong', label: 'Strong or expert only' },
              ]}
            />
          ) : null}
        </div>

        {loading && !data ? (
          <LoadingBlock label="Working out who is free…" />
        ) : candidates.length === 0 ? (
          <EmptyState
            icon={Search}
            title={skill ? 'Nobody has recorded that skill' : 'Nobody to show'}
            description={
              skill
                ? 'Try a lower level, or widen the range — and it may be worth knowing that nobody has written this down.'
                : 'No enabled accounts in this instance.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {candidates.map((person) => {
              const clear = person.freeDays === person.weekdays;
              const none = person.freeDays === 0;
              return (
                <li
                  key={person.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5',
                    none
                      ? 'border-line-soft bg-canvas/20 opacity-70'
                      : 'border-line-soft bg-canvas/40'
                  )}
                >
                  <Avatar user={{ fullname: person.fullname, username: person.username }} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">{person.fullname}</span>
                      {person.level ? (
                        <span
                          className="flex items-center gap-1.5 text-[0.625rem] text-fg-subtle"
                          title={levelOf(person.level).label}
                        >
                          <SkillPips level={person.level} />
                          {levelOf(person.level).label}
                        </span>
                      ) : null}
                      {person.clashDays ? (
                        <Badge tone="warning" icon={TriangleAlert} title="Booked on days they are also away">
                          {person.clashDays} clash
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                      {person.headline || person.title || 'No headline'}
                    </span>
                  </span>

                  {/* The number the question was asked for, said plainly and never only as a bar. */}
                  <span className="shrink-0 text-right">
                    <span
                      className={cn(
                        'block font-mono text-sm tabular-nums',
                        none ? 'text-fg-subtle' : clear ? 'text-low' : 'text-fg'
                      )}
                    >
                      {person.freeDays}
                      <span className="text-fg-subtle">/{person.weekdays}</span>
                    </span>
                    <span className="block text-[0.5625rem] uppercase tracking-wide text-fg-subtle">
                      days free
                    </span>
                  </span>

                  <span className="flex w-full flex-col gap-1 text-[0.625rem] text-fg-subtle sm:w-auto sm:min-w-52">
                    {person.bookings.slice(0, 3).map((booking, index) => (
                      <span key={`${booking.start}-${index}`} className="flex items-center gap-1.5">
                        {/* A booking on an engagement you cannot open still takes the day: the
                            date is shown, the client's name is not. */}
                        {booking.visible ? null : <EyeOff size={10} className="shrink-0" />}
                        <span className="truncate">
                          {booking.label} · {formatDate(booking.start)} → {formatDate(booking.end)}
                        </span>
                      </span>
                    ))}
                    {person.bookings.length > 3 ? (
                      <span>+{person.bookings.length - 3} more bookings</span>
                    ) : null}
                    {person.leave.slice(0, 2).map((row, index) => (
                      <span
                        key={`${row.start}-${index}`}
                        className="flex items-center gap-1.5"
                        style={{ color: leaveMeta(row.type).hue }}
                      >
                        <CalendarOff size={10} className="shrink-0" />
                        <span className="truncate">
                          {row.everyone ? 'Public holiday' : leaveMeta(row.type).label} ·{' '}
                          {formatDate(row.start)}
                        </span>
                      </span>
                    ))}
                  </span>

                  {onBook ? (
                    <Button
                      variant={person.deep && !none ? 'primary' : 'secondary'}
                      size="sm"
                      icon={UserCheck}
                      disabled={none}
                      title={none ? 'They have no free weekdays in that range' : 'Book them'}
                      onClick={() =>
                        onBook({
                          user: person.id,
                          // Their longest unbroken stretch, not their first and last free day:
                          // free on Monday and Friday is not free for five days.
                          start: person.freeRun?.start ?? from,
                          end: person.freeRun?.end ?? to,
                        })
                      }
                    >
                      Book{person.freeRun && person.freeRun.days > 1 ? ` ${person.freeRun.days}d` : ''}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-[0.625rem] leading-relaxed text-fg-subtle">
          Availability counts every booking in the instance, not only the ones you can see — a
          scheduler that calls somebody free because you cannot see the job they are on is worse
          than no scheduler. Approved leave and public holidays come off; a request nobody has
          answered yet does not, because it is not a day off until it is.
        </p>
      </div>
    </Modal>
  );
}
