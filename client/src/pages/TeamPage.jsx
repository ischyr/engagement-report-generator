import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  CalendarDays,
  ClipboardCheck,
  Clock,
  ExternalLink,
  ScrollText,
  ShieldAlert,
  UserRound,
  Users,
} from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { cn, formatDate, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Stat, Tabs, Avatar, AvatarGroup } from '../components/ui/Misc.jsx';
import { StateBadge } from '../components/ui/Badge.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';

/** Roles read as labels rather than raw field names. */
const ROLE_LABEL = {
  creator: 'created it',
  collaborator: 'tester',
  reviewer: 'reviewer',
  former: 'no longer on it',
};

const ROLE_TONE = {
  creator: 'brand',
  collaborator: 'neutral',
  reviewer: 'warning',
  former: 'neutral',
};

function RoleBadges({ roles }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {(roles ?? []).map((role) => (
        <Badge key={role} tone={ROLE_TONE[role] ?? 'neutral'}>
          {ROLE_LABEL[role] ?? role}
        </Badge>
      ))}
    </span>
  );
}

/** How long a window to measure utilisation over. */
const RANGES = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: 'a year' },
];

/**
 * Days booked as a share of the days that person was actually available.
 *
 * The number is always written out beside the bar: the bar is for comparing rows at a
 * glance, and it is not the thing carrying the value. Over 100% is drawn full and marked,
 * because being booked on more days than exist is exactly what somebody wants to see.
 *
 * The denominator is per person now that leave is recorded — weekdays minus their approved
 * holiday and the public holidays everybody gets. Somebody who took two of four weeks off
 * and was booked for the other two is fully booked, and used to read as 50%.
 */
function UtilisationMeter({ booked, workingDays }) {
  if (!booked || !workingDays) {
    return <span className="text-xs text-fg-subtle">—</span>;
  }
  const percent = booked.utilisation;
  const over = booked.clashDays > 0;
  const available = booked.availableDays ?? workingDays;

  return (
    <span
      className="flex items-center justify-end gap-2"
      title={
        booked.daysOff
          ? `${booked.days} of ${available} available days — ${booked.daysOff} day(s) off came out of the ${workingDays} weekdays in the window`
          : `${booked.days} of ${available} available days`
      }
    >
      <span
        aria-hidden
        className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-white/8 sm:block"
      >
        <span
          className={cn('block h-full rounded-full', over ? 'bg-med' : 'bg-brand-400')}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className="font-mono text-xs tabular-nums text-fg">{percent}%</span>
    </span>
  );
}

/** A person, with their engagements folded away until asked for. */
function PersonRow({ person, workingDays, hoursPerDay = 8 }) {
  const [open, setOpen] = useState(false);
  const has = person.engagements.length > 0;

  return (
    <>
      <TR onClick={has ? () => setOpen((v) => !v) : undefined}>
        <TD className="max-w-xs">
          <span className="flex items-center gap-2.5">
            {has ? (
              open ? (
                <ChevronDown size={14} className="shrink-0 text-fg-subtle" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-fg-subtle" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <Avatar user={person} size={26} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{person.fullname}</span>
              <span className="block truncate text-[0.6875rem] text-fg-subtle">
                {person.username}
                {person.enabled ? '' : ' · disabled'}
              </span>
            </span>
          </span>
        </TD>
        <TD className="capitalize text-xs text-fg-muted">{person.role}</TD>
        <TD align="right" className="font-mono tabular-nums text-fg-muted">
          {person.engagements.length}
        </TD>
        <TD align="right" className="font-mono tabular-nums">
          <span className={person.findingsCreated ? 'text-fg' : 'text-fg-subtle'}>
            {person.findingsCreated}
          </span>
        </TD>
        <TD align="right" className="font-mono tabular-nums text-fg-muted">
          {person.checksVerified}
        </TD>
        <TD align="right" className="whitespace-nowrap font-mono text-xs tabular-nums">
          <span className={person.booked?.days ? 'text-fg' : 'text-fg-subtle'}>
            {person.booked?.days ?? 0}
          </span>
          {person.booked?.clashDays ? (
            <span className="ml-1.5 text-med" title={`${person.booked.clashDays} of those days are booked twice`}>
              ({person.booked.clashDays} clash)
            </span>
          ) : null}
          {/* Days off, said out loud beside the booked ones: a low number of booked days
              means something different for somebody who was away half the window. */}
          {person.away?.days ? (
            <span
              className="ml-1.5 text-info"
              title={`${person.away.days} day(s) off in the window, leaving ${person.away.workingDays} available`}
            >
              ({person.away.days} off)
            </span>
          ) : null}
        </TD>
        {/*
          Hours logged, with the rate underneath.

          Beside the booked days rather than replacing them: the plan and the outturn are
          two different facts, and the whole point of recording hours is the gap between
          them. The rate is the honest reading — five days booked and fifty hours logged is
          not a five-day week.
        */}
        <TD align="right" className="whitespace-nowrap font-mono text-xs tabular-nums">
          <span className={person.logged?.hours ? 'text-fg' : 'text-fg-subtle'}>
            {person.logged?.hours ? `${person.logged.hours} h` : '—'}
          </span>
          {person.logged?.hoursPerBookedDay ? (
            <span
              className="mt-0.5 block text-[0.625rem] text-fg-subtle"
              title={`${person.logged.effortDays} person-days at ${hoursPerDay} hours to the day`}
            >
              {person.logged.hoursPerBookedDay} h/day
            </span>
          ) : null}
        </TD>
        <TD align="right">
          <UtilisationMeter booked={person.booked} workingDays={workingDays} />
        </TD>
        <TD align="right" className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-muted">
          {person.booked?.findingsPerDay === null || person.booked?.findingsPerDay === undefined
            ? '—'
            : person.booked.findingsPerDay.toFixed(1)}
        </TD>
        <TD align="right" className="whitespace-nowrap text-xs text-fg-subtle">
          {person.lastSeenAt ? timeAgo(person.lastSeenAt) : 'never signed in'}
        </TD>
      </TR>

      {open
        ? person.engagements.map((engagement) => (
            <TR key={`${person.id}-${engagement.id}`}>
              <TD colSpan={10} className="bg-canvas/40">
                <span className="flex flex-wrap items-center gap-3 pl-10">
                  <Link
                    to={`/engagements/${engagement.id}`}
                    className="min-w-0 flex-1 truncate text-xs font-medium text-fg transition hover:text-brand-300"
                  >
                    {engagement.name}
                  </Link>
                  {engagement.company ? (
                    <span className="shrink-0 text-[0.6875rem] text-fg-subtle">
                      {engagement.company}
                    </span>
                  ) : null}
                  <RoleBadges roles={engagement.roles} />
                  <StateBadge state={engagement.state} />
                  {engagement.bookedDays ? (
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                      <CalendarDays size={11} />
                      {engagement.bookedDays} day{engagement.bookedDays === 1 ? '' : 's'} booked
                    </span>
                  ) : null}
                  {engagement.loggedHours ? (
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                      <Clock size={11} />
                      {engagement.loggedHours} h logged
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                    {engagement.findingsCreated} finding
                    {engagement.findingsCreated === 1 ? '' : 's'} written
                  </span>
                </span>
              </TD>
            </TR>
          ))
        : null}
    </>
  );
}

/**
 * One engagement and everyone on it, folded away until asked for.
 *
 * Collapsed by default because the answer to "who is on this" is usually one
 * engagement out of dozens, and an uncollapsed list of every team on every engagement
 * is a page you scroll past rather than read.
 */
function EngagementCard({ engagement, open, onToggle }) {
  return (
    <Card>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0 text-fg-subtle" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-fg-subtle" />
          )}
          <ScrollText size={15} className="shrink-0 text-brand-300" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-fg">{engagement.name}</span>
            <span className="block truncate text-[0.6875rem] text-fg-subtle">
              {[engagement.reference, engagement.company].filter(Boolean).join(' · ') ||
                'No client set'}
            </span>
          </span>
        </button>

        {/* The team, visible without expanding — the question the page exists for. */}
        <AvatarGroup users={engagement.members} size={22} />
        <span className="hidden shrink-0 font-mono text-[0.6875rem] tabular-nums text-fg-muted sm:block">
          {engagement.findingCount} finding{engagement.findingCount === 1 ? '' : 's'}
        </span>
        <StateBadge state={engagement.state} />
        <Link
          to={`/engagements/${engagement.id}`}
          title="Open the engagement"
          className="shrink-0 rounded-md p-1.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
        >
          <ExternalLink size={13} />
        </Link>
      </div>

      {open ? (
        <CardBody className="flex flex-col gap-1 border-t border-line-soft">
          {engagement.members.map((member) => (
            <div
              key={member.id}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5',
                member.roles.includes('former') && 'opacity-70'
              )}
            >
              <Avatar user={{ fullname: member.fullname }} size={22} />
              <span className="min-w-0 flex-1 truncate text-xs text-fg">
                {member.fullname}
                {member.username ? (
                  <span className="ml-1.5 text-fg-subtle">{member.username}</span>
                ) : null}
              </span>
              <RoleBadges roles={member.roles} />
              <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                {member.findingsCreated} written
              </span>
              {member.checksVerified ? (
                <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] tabular-nums text-fg-subtle">
                  <ClipboardCheck size={11} />
                  {member.checksVerified}
                </span>
              ) : null}
            </div>
          ))}
        </CardBody>
      ) : null}
    </Card>
  );
}

/**
 * Who is working on what.
 *
 * The only view in the app that ignores engagement membership — answering "who is
 * on what, and how much have they written" is the point, so it reads everything.
 * Admin-only for the same reason.
 */
export default function TeamPage() {
  /** Declared before the request, which reads it. */
  const [range, setRange] = useState(90);
  const { data, error, loading, reload } = useResource(`/users/engagements?days=${range}`, {
    initial: null,
  });
  const [view, setView] = useState('people');
  const [search, setSearch] = useState('');
  /** Which engagement cards the reader has opened. */
  const [openIds, setOpenIds] = useState(() => new Set());

  const needle = search.trim().toLowerCase();
  const matches = (...fields) =>
    !needle || fields.filter(Boolean).some((field) => String(field).toLowerCase().includes(needle));

  const people = useMemo(
    () =>
      (data?.users ?? []).filter((person) =>
        matches(
          person.fullname,
          person.username,
          person.role,
          // Searching a client's name should find whoever worked on it.
          ...person.engagements.flatMap((engagement) => [engagement.name, engagement.company])
        )
      ),
    [data?.users, needle] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const engagementList = useMemo(
    () =>
      (data?.engagements ?? []).filter((engagement) =>
        matches(
          engagement.name,
          engagement.reference,
          engagement.company,
          // A search for a person finds the engagements they are on, which is the
          // whole reason to search this view.
          ...engagement.members.flatMap((member) => [member.fullname, member.username])
        )
      ),
    [data?.engagements, needle] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const toggle = (id) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const tabs = useMemo(
    () => [
      { value: 'people', label: 'By person', count: data?.totals?.users },
      { value: 'engagements', label: 'By engagement', count: data?.totals?.engagements },
    ],
    [data?.totals]
  );

  if (loading && !data) return <LoadingBlock label="Working out who is on what…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { totals, window: measured } = data;
  const allOpen = engagementList.length > 0 && engagementList.every((e) => openIds.has(e.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team"
        description="Who is assigned to which engagements, how much of each report they wrote, and how much of their time is booked."
        actions={
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            Utilisation over
            <select
              value={range}
              onChange={(event) => setRange(Number(event.target.value))}
              className="h-9 rounded-lg bg-canvas/60 px-2.5 text-sm text-fg ring-1 ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none"
            >
              {RANGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="People" value={totals.users} sub={`${totals.idle} on nothing`} icon={Users} />
        <Stat label="Engagements" value={totals.engagements} sub="not in the trash" icon={ScrollText} />
        <Stat label="Findings" value={totals.findings} sub="across all engagements" icon={ShieldAlert} />
        <Stat
          label="Days booked"
          value={measured?.bookedDays ?? 0}
          icon={CalendarDays}
          sub={
            measured
              ? `across ${measured.workingDays} weekdays, from ${formatDate(measured.from)}`
              : undefined
          }
        />
        <Stat
          label="Hours logged"
          value={measured?.loggedHours ?? 0}
          icon={Clock}
          sub={
            measured?.loggedHours
              ? `${Math.round((measured.loggedHours / (measured.hoursPerDay ?? 8)) * 100) / 100} person-days`
              : 'nobody has logged time yet'
          }
        />
        <Stat
          label="Unattributed"
          value={totals.unattributedFindings}
          tone={totals.unattributedFindings ? 'med' : 'low'}
          sub={
            totals.unattributedFindings
              ? 'written before authors were recorded'
              : 'every finding has an author'
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs options={tabs} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={
            view === 'people' ? 'Search people or their clients…' : 'Search engagements or members…'
          }
          className="ml-auto w-full sm:w-72"
        />
        {view === 'engagements' && engagementList.length ? (
          <button
            type="button"
            onClick={() =>
              setOpenIds(allOpen ? new Set() : new Set(engagementList.map((e) => e.id)))
            }
            className="shrink-0 rounded-md px-2 py-1.5 text-[0.6875rem] font-medium text-fg-muted transition hover:bg-white/5 hover:text-fg"
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        ) : null}
      </div>

      {view === 'people' ? (
        <Card>
          <CardHeader
            icon={UserRound}
            title="By person"
            description="Click a row to see the engagements they are on. Findings are counted by who wrote them up."
          />
          <Table>
            <THead>
              <TH>Person</TH>
              <TH>Account</TH>
              <TH align="right">Engagements</TH>
              <TH align="right">Findings</TH>
              <TH align="right">Checks</TH>
              <TH align="right">Booked</TH>
              <TH align="right">Logged</TH>
              <TH align="right">Utilisation</TH>
              <TH align="right">Findings / day</TH>
              <TH align="right">Last seen</TH>
            </THead>
            <TBody>
              {people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  workingDays={measured?.workingDays}
                  hoursPerDay={measured?.hoursPerDay ?? 8}
                />
              ))}
            </TBody>
          </Table>
          {people.length === 0 ? (
            <EmptyState icon={UserRound} title="Nobody matches that" />
          ) : null}
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {engagementList.length === 0 ? (
            <Card>
              <EmptyState
                icon={ScrollText}
                title={needle ? 'No engagement matches that' : 'No engagements yet'}
                description={
                  needle ? 'Searching also looks at who is on each one.' : undefined
                }
              />
            </Card>
          ) : (
            engagementList.map((engagement) => (
              <EngagementCard
                key={engagement.id}
                engagement={engagement}
                // A search opens what it found: collapsing the reason a card matched
                // would make the result look wrong. Clearing it restores the state.
                open={Boolean(needle) || openIds.has(engagement.id)}
                onToggle={() => toggle(engagement.id)}
              />
            ))
          )}
        </div>
      )}

    </div>
  );
}
