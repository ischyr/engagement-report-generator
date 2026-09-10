import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  Clock,
  Palmtree,
  Plus,
  Search,
  TrendingUp,
  TriangleAlert,
  Trash2,
  Users,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { cn, displayName, formatDate, initialsOf } from '../lib/utils.js';

import { Card, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Avatar, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge, StateBadge } from '../components/ui/Badge.jsx';
import { Input, Select } from '../components/ui/Field.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import TimeOffCard from '../components/schedule/TimeOffCard.jsx';
import TimeOffModal from '../components/schedule/TimeOffModal.jsx';
import { isWeekend, leaveBarStyle, leaveMeta, portionLabel } from '../components/schedule/leave-meta.js';
import AvailabilityFinder from '../components/schedule/AvailabilityFinder.jsx';
import CapacityView from '../components/schedule/CapacityView.jsx';

/* -------------------------------------------------------------------------- */
/* Dates. All of it in `yyyy-mm-dd`, like the server                          */
/* -------------------------------------------------------------------------- */

/*
 * Deliberately no Date arithmetic on booking days.
 *
 * A booking is a *day*, and `new Date('2026-08-10')` is midnight UTC — which is the 9th
 * for anyone west of London. Formatting that back would move somebody's booking a day
 * whenever the reader's timezone disagreed with the author's, which is exactly the bug
 * that makes shared calendars untrustworthy. Strings compare and sort correctly, so the
 * only place a real Date appears is building the month grid.
 */
const iso = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

const todayIso = () => iso(new Date());

/** Inclusive day count, from the string parts — no timezone anywhere near it. */
function daysBetween(start, end) {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  return Math.round((b - a) / 86_400_000) + 1;
}


const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** Monday first: a working week, for a page about who is working. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The weeks a month view has to draw, each as seven `yyyy-mm-dd` days.
 *
 * Always whole weeks, so the grid is rectangular and a booking that runs over a month
 * boundary still has cells to sit in.
 */
function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  // getUTCDay: 0 is Sunday; shift so Monday is 0.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month, 1 - lead));

  const weeks = [];
  for (let week = 0; week < 6; week += 1) {
    const days = [];
    for (let day = 0; day < 7; day += 1) {
      const at = new Date(start.getTime() + (week * 7 + day) * 86_400_000);
      days.push({
        iso: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(
          at.getUTCDate()
        ).padStart(2, '0')}`,
        dayOfMonth: at.getUTCDate(),
        inMonth: at.getUTCMonth() === month,
      });
    }
    weeks.push(days);
    // A sixth row only when the month needs one: stop once a week ends in a later month
    // and at least four have been drawn. Compared as `yyyy-mm`, so it says what it means
    // rather than leaning on a day number that may not exist.
    const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (week >= 4 && days[6].iso.slice(0, 7) > monthKey) break;
  }
  return weeks;
}

/* -------------------------------------------------------------------------- */

/**
 * Colour per engagement, assigned in the order they appear and held by the entity.
 *
 * Six validated categorical slots (see index.css). Beyond six the order repeats, which is
 * acceptable *here* and would not be on a chart: every block is labelled with the
 * engagement's name, so colour groups a run of days rather than carrying the identity on
 * its own. Keyed by engagement id so a filter that hides one never repaints the others.
 */
const SLOTS = 6;
function colourMap(bookings) {
  const map = new Map();
  for (const booking of bookings) {
    const id = String(booking.audit?._id ?? booking.audit ?? '');
    if (id && !map.has(id)) map.set(id, `var(--color-slot-${(map.size % SLOTS) + 1})`);
  }
  return map;
}

/**
 * A booking whose account has since been deleted still exists, and the engagement still
 * lists that person on its team — so this says so instead of rendering a blank.
 */
const whoOf = (user) => displayName(user) || 'Removed account';

/** Bookings for the same person that share a day, which is the thing worth flagging. */
function clashesOf(bookings) {
  const clashing = new Set();
  for (let i = 0; i < bookings.length; i += 1) {
    for (let j = i + 1; j < bookings.length; j += 1) {
      const a = bookings[i];
      const b = bookings[j];
      if (String(a.user?._id ?? a.user) !== String(b.user?._id ?? b.user)) continue;
      if (a.start <= b.end && b.start <= a.end) {
        clashing.add(a._id);
        clashing.add(b._id);
      }
    }
  }
  return clashing;
}

/**
 * Bookings that land on the booked person's own time off, and how many days of it.
 *
 * Never a refusal — the schedule reports reality rather than arguing with it — but it is the
 * one overlap worth seeing before the day arrives, because unlike two engagements at once it
 * cannot be solved by working harder. Public holidays count for everybody, which is why a
 * row with no owner matches every person.
 */
function leaveClashesOf(bookings, leave) {
  const map = new Map();
  for (const booking of bookings) {
    const who = String(booking.userId ?? booking.user?._id ?? booking.user ?? '');
    const hits = leave.filter(
      (row) =>
        (row.everyone || String(row.userId ?? '') === who) &&
        row.start <= booking.end &&
        booking.start <= row.end
    );
    if (hits.length) map.set(booking._id, hits);
  }
  return map;
}

/**
 * Who is booked on what, and when.
 *
 * The engagement's own dates are the window the client bought; this is the part of it each
 * person has actually promised. Nothing could answer "am I free that week" before, because
 * the answer spans engagements and every view was inside one.
 */
export default function SchedulePage() {
  const { user, canWrite } = useAuth();
  const toast = useToast();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  /** The time-off form, and the day it was opened from — clicking the 8th means the 8th. */
  const [timeOff, setTimeOff] = useState(null);
  /**
   * Which question the page is answering.
   *
   * The month is "who is on what"; capacity is "have we got room for this" — the same three
   * facts read in opposite directions, and the second one had no home at all.
   */
  const [view, setView] = useState('month');
  const [finding, setFinding] = useState(false);

  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const from = weeks[0][0].iso;
  const to = weeks.at(-1).at(-1).iso;

  const { data, error, loading, reload } = useResource(`/schedule?from=${from}&to=${to}`, {
    initial: null,
  });
  /*
   * The hours actually logged over the same window.
   *
   * Fetched here so the plan and the outturn are read side by side: the point of recording
   * hours is the difference, and a page showing only one half of it is the page that made
   * the difference invisible in the first place.
   */
  const time = useResource(`/time?from=${from}&to=${to}`, { initial: null });
  // Only for turning the team's ids into names in the picker; the schedule itself comes
  // back with its people already populated.
  const people = useResource(canWrite ? '/users?active=true' : null, { initial: [] });
  const nameOf = (id) => {
    const person = (people.data ?? []).find((entry) => String(entry.id ?? entry._id) === String(id));
    return person ? displayName(person) : 'Somebody on the team';
  };

  const me = String(user?.id ?? user?._id ?? '');
  const all = data?.bookings ?? [];
  const bookings = all;
  const colours = useMemo(() => colourMap(all), [all]);
  const clashes = useMemo(() => clashesOf(all), [all]);
  const engagements = data?.engagements ?? [];

  /*
   * Time off, from the same request as the bookings.
   *
   * Unscoped by engagement, unlike everything else on this page: leave is a fact about a
   * person's week. A calendar that only knew what people had already said yes to could not
   * answer the question it exists for — can I book them that week.
   */
  const leave = data?.leave ?? [];
  const capacity = data?.capacity ?? null;
  const allowance = data?.allowance ?? null;
  const leaveClashes = useMemo(() => leaveClashesOf(all, leave), [all, leave]);
  /** People off at some point this month — the number worth seeing above the grid. */
  const awayCount = useMemo(
    () => new Set(leave.filter((row) => !row.everyone).map((row) => row.userId)).size,
    [leave]
  );

  const timeEntries = time.data?.entries ?? [];
  const loggedHours = time.data?.totals?.hours ?? 0;
  /**
   * Hours per person per engagement, so a booking row can show what it actually took.
   *
   * Keyed by person and engagement rather than by booking: a booking is a range and an
   * entry is a day, and attributing a day to one of two overlapping bookings would be a
   * guess. The column says "on this engagement, in this month", which is answerable.
   *
   * Keyed on the `userId` the server sends rather than the populated `user`, which is null
   * for a deleted account — every deleted colleague would otherwise share one bucket.
   */
  const loggedByPair = useMemo(() => {
    const map = new Map();
    for (const entry of timeEntries) {
      const key = `${entry.userId ?? ''}:${String(entry.audit?._id ?? entry.audit)}`;
      map.set(key, (map.get(key) ?? 0) + entry.hours);
    }
    return new Map([...map].map(([key, hours]) => [key, Math.round(hours * 4) / 4]));
  }, [timeEntries]);

  const removeEntry = async (entry) => {
    try {
      await api.del(`/time/${entry._id}`);
      await time.reload({ quiet: true });
      toast.success('Entry removed');
    } catch (err) {
      toast.fromError(err);
    }
  };

  const step = (delta) => {
    const at = new Date(Date.UTC(year, month + delta, 1));
    setYear(at.getUTCFullYear());
    setMonth(at.getUTCMonth());
  };

  const openForm = (day) => {
    const first = engagements[0];
    setForm({
      audit: first?._id ?? '',
      user: me,
      start: day ?? todayIso(),
      end: day ?? todayIso(),
      note: '',
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.post('/schedule', {
        audit: form.audit,
        ...(form.user && form.user !== me ? { user: form.user } : {}),
        start: form.start,
        end: form.end,
        note: form.note,
      });
      setForm(null);
      await reload({ quiet: true });
      /*
       * Booking over somebody's time off is allowed and said out loud. A warning toast
       * rather than a refusal: the server records it either way, and the person who needs
       * to know is the one who just did it.
       */
      if (saved?.warning) toast.warning('Booked — but that week is not clear', saved.warning);
      else toast.success('Booked');
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/schedule/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Booking removed');
    } catch (err) {
      toast.fromError(err);
    }
  };

  if (loading && !data) return <LoadingBlock label="Loading the schedule…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const chosen = engagements.find((entry) => entry._id === form?.audit);
  const bookedDays = bookings.reduce((sum, b) => sum + daysBetween(b.start, b.end), 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Schedule"
        description="The days each person has promised to an engagement — the part of the client's window that is actually booked."
        actions={
          canWrite ? (
            <span className="flex flex-wrap items-center gap-2">
              {/* The join the two pages could not make on their own. */}
              <Button variant="secondary" icon={Search} onClick={() => setFinding(true)}>
                Who is free?
              </Button>
              <Button variant="secondary" icon={Palmtree} onClick={() => setTimeOff({ day: null })}>
                Book time off
              </Button>
              {engagements.length ? (
                <Button variant="primary" icon={Plus} onClick={() => openForm()}>
                  Book time
                </Button>
              ) : null}
            </span>
          ) : null
        }
      />

      <Tabs
        options={[
          { value: 'month', label: 'Month', icon: CalendarDays },
          { value: 'capacity', label: 'Capacity', icon: TrendingUp },
        ]}
        value={view}
        onChange={setView}
        size="sm"
        className="self-start"
      />

      {view === 'capacity' ? <CapacityView /> : null}

      {/* One row of controls above the calendar, as filters should be. */}
      <div className={cn('flex flex-wrap items-center gap-3', view === 'capacity' && 'hidden')}>
        <div className="flex items-center gap-1 rounded-lg border border-line-soft bg-surface/60 p-1">
          <Button variant="ghost" size="icon-sm" icon={ChevronLeft} aria-label="Previous month" onClick={() => step(-1)} />
          <span className="min-w-40 text-center text-sm font-semibold text-fg">
            {MONTHS[month]} {year}
          </span>
          <Button variant="ghost" size="icon-sm" icon={ChevronRight} aria-label="Next month" onClick={() => step(1)} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setYear(new Date().getFullYear());
            setMonth(new Date().getMonth());
          }}
        >
          Today
        </Button>
        {/* Your own balance, where somebody deciding whether to book a week will see it. */}
        {allowance?.allowance ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft bg-surface/60 px-2.5 py-1.5 text-xs text-fg-muted"
            title={`Holiday and unpaid leave in ${allowance.year}. Sickness and training do not count against an allowance.`}
          >
            <Palmtree size={12} className="text-info" />
            <span className="tabular-nums text-fg">{allowance.taken}</span>
            <span className="text-fg-subtle">of {allowance.allowance} days taken</span>
            {allowance.pending ? (
              <span className="text-med">· {allowance.pending} awaiting approval</span>
            ) : null}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-fg-muted">
          {bookings.length} booking{bookings.length === 1 ? '' : 's'} · {bookedDays} day
          {bookedDays === 1 ? '' : 's'}
          {capacity ? (
            <span className="ml-2 text-fg-subtle" title="Weekdays in the month shown, minus your own approved leave and the public holidays everybody gets">
              · {capacity.available} working day{capacity.available === 1 ? '' : 's'} for you
              {capacity.off ? ` (${capacity.off} off)` : ''}
            </span>
          ) : null}
          {awayCount ? (
            <span className="ml-2 inline-flex items-center gap-1 text-info">
              <CalendarOff size={12} />
              {awayCount} away
            </span>
          ) : null}
          {loggedHours ? (
            <span className="ml-2 inline-flex items-center gap-1 text-fg-muted">
              <Clock size={12} />
              {loggedHours} h logged
            </span>
          ) : null}
          {clashes.size ? (
            <span className="ml-2 inline-flex items-center gap-1 text-med">
              <TriangleAlert size={12} />
              {clashes.size} overlapping
            </span>
          ) : null}
        </span>
      </div>

      {/* ------------------------------------------------------------ calendar */}
      <Card className={cn('overflow-hidden', view === 'capacity' && 'hidden')}>
        <div className="grid grid-cols-7 border-b border-line-soft bg-surface/60">
          {WEEKDAYS.map((label) => (
            <span
              key={label}
              className="px-2 py-2 text-center text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="divide-y divide-line-soft">
          {weeks.map((week) => (
            <div key={week[0].iso} className="grid grid-cols-7">
              {week.map((day) => {
                const onThisDay = bookings.filter((b) => b.start <= day.iso && day.iso <= b.end);
                const offThisDay = leave.filter((l) => l.start <= day.iso && day.iso <= l.end);
                const closed = offThisDay.filter((l) => l.everyone);
                const isToday = day.iso === todayIso();
                const weekend = isWeekend(day.iso);
                return (
                  <div
                    key={day.iso}
                    className={cn(
                      'group/day min-h-24 border-l border-line-soft p-1.5 first:border-l-0',
                      day.inMonth ? '' : 'bg-canvas/40',
                      // Weekends dimmed, so a five-day booking reads as a working week and
                      // nobody counts Saturday when they eye a range.
                      weekend && day.inMonth ? 'bg-canvas/50' : '',
                      // A day the firm is closed is a property of the day itself, so it is
                      // said by the cell rather than by a bar inside it.
                      closed.length ? 'bg-low/8' : ''
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={cn(
                          'grid size-5 place-items-center rounded-full text-[0.6875rem] tabular-nums',
                          isToday
                            ? 'bg-brand-500 font-semibold text-white'
                            : day.inMonth
                              ? 'text-fg-muted'
                              : 'text-fg-subtle'
                        )}
                      >
                        {day.dayOfMonth}
                      </span>
                      {canWrite ? (
                        <span className="flex items-center">
                          {/* Two ways to spend a day, both reachable from the day itself —
                              which is where somebody looking at a week decides. */}
                          <button
                            type="button"
                            onClick={() => setTimeOff({ day: day.iso })}
                            aria-label={`Book time off on ${day.iso}`}
                            title="Book time off"
                            className="rounded p-0.5 text-fg-subtle opacity-0 transition hover:bg-white/5 hover:text-info focus-visible:opacity-100 group-hover/day:opacity-100"
                          >
                            <Palmtree size={12} />
                          </button>
                          {engagements.length ? (
                            <button
                              type="button"
                              onClick={() => openForm(day.iso)}
                              aria-label={`Book time on ${day.iso}`}
                              title="Book time on an engagement"
                              className="rounded p-0.5 text-fg-subtle opacity-0 transition hover:bg-white/5 hover:text-fg focus-visible:opacity-100 group-hover/day:opacity-100"
                            >
                              <Plus size={12} />
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>

                    {/* Time off first: it is the constraint, and the bookings below it are
                        the thing being constrained. */}
                    <div className="mt-1 flex flex-col gap-0.5">
                      {closed.length ? (
                        <span
                          className="-mx-1.5 flex h-4 items-center gap-1 truncate px-1.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-low"
                          title={closed.map((row) => row.note || 'Public holiday').join(' · ')}
                        >
                          {closed[0].note || 'Public holiday'}
                        </span>
                      ) : null}

                      {offThisDay
                        .filter((row) => !row.everyone)
                        .map((row) => {
                          const meta = leaveMeta(row.type);
                          const Icon = meta.icon;
                          const first = row.start === day.iso;
                          const labelled = first || day.iso === week[0].iso;
                          return (
                            <span
                              key={row._id}
                              title={`${displayName(row.user) || 'Somebody'} — ${meta.label}${
                                row.portion === 'full' ? '' : ` (${portionLabel(row.portion)} only)`
                              } · ${row.start} → ${row.end}${
                                row.status === 'requested' ? ' · requested, not yet approved' : ''
                              }${row.note ? ` · ${row.note}` : ''}`}
                              className={cn(
                                '-mx-1.5 flex h-4.5 items-center gap-1 px-1.5 text-[0.625rem] font-medium leading-none',
                                first ? 'ml-0 rounded-l-md' : '',
                                row.end === day.iso ? 'mr-0 rounded-r-md' : ''
                              )}
                              style={leaveBarStyle(row, {
                                first,
                                last: row.end === day.iso,
                              })}
                            >
                              {labelled ? <Icon size={9} className="shrink-0" /> : null}
                              <span className="truncate">
                                {labelled ? initialsOf(row.user) || '??' : ''}
                              </span>
                              {/* Half a day says so on the bar itself: a morning off drawn
                                  like a whole day is the kind of small lie that gets somebody
                                  booked for a meeting at four. */}
                              {labelled && row.portion !== 'full' ? (
                                <span className="shrink-0 opacity-90">½</span>
                              ) : null}
                              {labelled && row.status === 'requested' ? (
                                <span className="ml-auto shrink-0 opacity-80">?</span>
                              ) : null}
                            </span>
                          );
                        })}

                      {onThisDay.map((booking) => {
                        const id = String(booking.audit?._id ?? booking.audit);
                        const first = booking.start === day.iso;
                        // The bar is one thing, so it is labelled once — at its start, and
                        // again where a week wraps, since that is a new line for the reader.
                        // Repeating the name, the initials and the warning on all five days
                        // turns a bar into a row of stamps.
                        const labelled = first || day.iso === week[0].iso;
                        return (
                          <Link
                            key={booking._id}
                            to={`/engagements/${id}`}
                            title={`${booking.audit?.name ?? 'Engagement'} — ${whoOf(
                              booking.user
                            )} · ${booking.start} → ${booking.end}${
                              booking.note ? ` · ${booking.note}` : ''
                            }`}
                            className={cn(
                              // Bled into the cell's padding: without it each day is a
                              // separate chip and a five-day booking reads as five things.
                              // A fixed height, because only the labelled day has text in
                              // it: sized by content, the continuation days collapsed to a
                              // hairline and the bar looked like a rule with a chip on it.
                              '-mx-1.5 flex h-4.5 items-center gap-1 px-1.5 text-[0.625rem] font-medium leading-none text-white transition hover:brightness-110',
                              // Rounded only where the run actually starts and ends, so a
                              // multi-day booking reads as one bar across the week.
                              first ? 'ml-0 rounded-l-md' : '',
                              booking.end === day.iso ? 'mr-0 rounded-r-md' : ''
                            )}
                            style={{ backgroundColor: colours.get(id) }}
                          >
                            {labelled && clashes.has(booking._id) ? (
                              <TriangleAlert size={10} className="shrink-0" />
                            ) : null}
                            {/* Booked over their own time off — the overlap that cannot be
                                solved by working harder. */}
                            {labelled && leaveClashes.has(booking._id) ? (
                              <CalendarOff size={10} className="shrink-0" />
                            ) : null}
                            {/* The label carries the identity; the colour only groups the
                                run. */}
                            <span className="truncate">
                              {labelled
                                ? booking.audit?.reference || booking.audit?.name || 'Engagement'
                                : ''}
                            </span>
                            {labelled ? (
                              <span className="ml-auto shrink-0 opacity-90">
                                {initialsOf(booking.user) || '??'}
                              </span>
                            ) : null}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card>

      {/* --------------------------------------------------------------- table */}
      <Card className={cn(view === 'capacity' && 'hidden')}>
        <CardHeader
          icon={CalendarDays}
          title="The same month, as a list"
          description="Every booking overlapping this month, earliest first. Sortable by eye, copyable, and readable without relying on colour."
        />
        {bookings.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Nothing booked this month"
            description="Book the days you expect to spend on an engagement and they appear here and on the calendar above."
            actionLabel={canWrite && engagements.length ? 'Book time' : undefined}
            actionIcon={Plus}
            onAction={canWrite && engagements.length ? () => openForm() : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH>Who</TH>
              <TH>Engagement</TH>
              <TH>From</TH>
              <TH>To</TH>
              <TH align="right">Days</TH>
              <TH align="right">Logged</TH>
              <TH>Note</TH>
              <TH width="3rem" />
            </THead>
            <TBody>
              {[...bookings]
                .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
                .map((booking) => {
                  const id = String(booking.audit?._id ?? booking.audit);
                  const mine = String(booking.user?._id ?? booking.user) === me;
                  return (
                    <TR key={booking._id}>
                      <TD>
                        <span className="flex items-center gap-2">
                          <Avatar user={booking.user} size={22} />
                          <span className="truncate text-xs text-fg">
                            {whoOf(booking.user)}
                          </span>
                          {clashes.has(booking._id) ? (
                            <Badge tone="warning" icon={TriangleAlert} title="This person is booked on something else at the same time">
                              overlaps
                            </Badge>
                          ) : null}
                          {leaveClashes.has(booking._id) ? (
                            <Badge
                              tone="info"
                              icon={CalendarOff}
                              title={leaveClashes
                                .get(booking._id)
                                .map(
                                  (row) =>
                                    `${leaveMeta(row.type).label}${
                                      row.status === 'requested' ? ' (requested)' : ''
                                    }: ${row.start} → ${row.end}`
                                )
                                .join(' · ')}
                            >
                              time off
                            </Badge>
                          ) : null}
                        </span>
                      </TD>
                      <TD className="max-w-xs">
                        <span className="flex items-center gap-2">
                          {/* A colour swatch, so the table and the calendar can be read
                              against each other — never colour alone. */}
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-sm"
                            style={{ backgroundColor: colours.get(id) }}
                          />
                          <Link
                            to={`/engagements/${id}`}
                            className="truncate text-xs text-fg transition hover:text-brand-300"
                          >
                            {booking.audit?.name ?? 'Engagement'}
                          </Link>
                          <StateBadge state={booking.audit?.state} />
                        </span>
                        <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                          {[booking.audit?.reference, booking.audit?.company?.name]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">
                        {formatDate(booking.start)}
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">
                        {formatDate(booking.end)}
                      </TD>
                      <TD align="right" className="font-mono text-xs tabular-nums text-fg-muted">
                        {daysBetween(booking.start, booking.end)}
                      </TD>
                      {/* Hours this person logged on this engagement this month — beside the
                          days they promised, which is the comparison the page exists for. */}
                      <TD
                        align="right"
                        className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-muted"
                        title="Hours logged by this person on this engagement, within the month shown"
                      >
                        {loggedByPair.has(`${booking.userId ?? ''}:${id}`)
                          ? `${loggedByPair.get(`${booking.userId ?? ''}:${id}`)} h`
                          : '—'}
                      </TD>
                      <TD className="max-w-xs truncate text-xs text-fg-subtle">
                        {booking.note || '—'}
                      </TD>
                      <TD align="right">
                        {canWrite && mine ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={Trash2}
                            title="Remove this booking"
                            className="hover:text-crit"
                            onClick={() => setPendingDelete(booking)}
                          />
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
            </TBody>
          </Table>
        )}
      </Card>

      {/* -------------------------------------------------------------- time off */}
      <div className={cn('flex flex-col gap-6', view === 'capacity' && 'hidden')}>
      <TimeOffCard
        leave={leave}
        onChanged={() => reload({ quiet: true })}
        onAdd={() => setTimeOff({ day: null })}
      />

      {/* ---------------------------------------------------------- time logged */}
      <Card>
        <CardHeader
          icon={Clock}
          title="Time logged this month"
          description="What the work actually took, a day at a time. Logged inside an engagement, on its Time tab — nothing here is inferred from the bookings above."
        />
        {timeEntries.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No hours logged this month"
            description="Open an engagement and use its Time tab. Bookings are what people expect to spend; this is what it cost, and the difference is what makes the next quote honest."
          />
        ) : (
          <Table>
            <THead>
              <TH>Day</TH>
              <TH>Who</TH>
              <TH>Engagement</TH>
              <TH align="right">Hours</TH>
              <TH>Note</TH>
              <TH width="3rem" />
            </THead>
            <TBody>
              {[...timeEntries]
                .sort((a, b) => b.day.localeCompare(a.day))
                .map((entry) => {
                  const id = String(entry.audit?._id ?? entry.audit);
                  const mine = (entry.userId ?? '') === me;
                  return (
                    <TR key={entry._id}>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">
                        {formatDate(entry.day)}
                      </TD>
                      <TD>
                        <span className="flex items-center gap-2">
                          <Avatar user={entry.user} size={22} />
                          <span className="truncate text-xs text-fg">{whoOf(entry.user)}</span>
                        </span>
                      </TD>
                      <TD className="max-w-xs">
                        <Link
                          to={`/engagements/${id}?tab=time`}
                          className="truncate text-xs text-fg transition hover:text-brand-300"
                        >
                          {entry.audit?.name ?? 'Engagement'}
                        </Link>
                      </TD>
                      <TD align="right" className="font-mono text-xs tabular-nums text-fg">
                        {entry.hours} h
                      </TD>
                      <TD className="max-w-xs truncate text-xs text-fg-subtle">
                        {entry.note || '—'}
                      </TD>
                      <TD align="right">
                        {canWrite && mine ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={Trash2}
                            title="Remove this entry"
                            className="hover:text-crit"
                            onClick={() => removeEntry(entry)}
                          />
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
            </TBody>
          </Table>
        )}
      </Card>

      {engagements.length === 0 ? (
        <p className="text-xs text-fg-subtle">
          You are not on any engagement yet, so there is nothing to book time against.
        </p>
      ) : null}
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title="Book time"
        description="The days you expect to be occupied with this engagement. Overlaps are allowed — the page shows them rather than refusing them."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.audit || !form?.start || !form?.end || form.end < form.start}
              onClick={save}
            >
              Book it
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Engagement"
              required
              wrapperClassName="sm:col-span-2"
              value={form.audit}
              onChange={(event) => {
                const next = engagements.find((entry) => entry._id === event.target.value);
                setForm({
                  ...form,
                  audit: event.target.value,
                  // Prefilled from the client's own window when it has one: the booking
                  // usually sits inside it, and typing dates twice is how they diverge.
                  start: next?.date_start || form.start,
                  end: next?.date_end || form.end,
                });
              }}
              options={engagements.map((entry) => ({
                value: entry._id,
                label: [entry.reference, entry.name].filter(Boolean).join(' — '),
              }))}
            />
            <Input
              label="From"
              type="date"
              required
              value={form.start}
              onChange={(event) => setForm({ ...form, start: event.target.value })}
            />
            <Input
              label="To"
              type="date"
              required
              hint={
                form.start && form.end && form.end >= form.start
                  ? `${daysBetween(form.start, form.end)} day(s), inclusive`
                  : 'Must not be before the start'
              }
              error={form.end && form.end < form.start ? 'Before the start date' : undefined}
              value={form.end}
              onChange={(event) => setForm({ ...form, end: event.target.value })}
            />
            {/* Booking somebody else is the creator's call or an admin's, which the server
                enforces — the picker only appears when the team has other people on it. */}
            {chosen && chosen.team.length > 1 ? (
              <Select
                label="Who"
                wrapperClassName="sm:col-span-2"
                hint="Only the engagement's creator or an admin can book somebody else."
                value={form.user}
                onChange={(event) => setForm({ ...form, user: event.target.value })}
                options={chosen.team.map((id) => ({
                  value: id,
                  label: id === me ? 'Me' : nameOf(id),
                }))}
              />
            ) : null}
            <Input
              label="Note"
              placeholder="Remote, on site in Cluj, retest only…"
              wrapperClassName="sm:col-span-2"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
            {chosen?.date_start || chosen?.date_end ? (
              <p className="sm:col-span-2 flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
                <Users size={12} className="shrink-0" />
                The client's window for this engagement is{' '}
                {chosen.date_start ? formatDate(chosen.date_start) : '—'} to{' '}
                {chosen.date_end ? formatDate(chosen.date_end) : '—'}.
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <AvailabilityFinder
        open={finding}
        onClose={() => setFinding(false)}
        /* Straight into the booking form with the person and their longest clear stretch
           already filled in — the whole point of having asked. */
        onBook={({ user, start, end }) => {
          setFinding(false);
          const first = engagements.find((entry) => entry.team.includes(String(user)));
          setForm({
            audit: first?._id ?? engagements[0]?._id ?? '',
            user: String(user),
            start,
            end,
            note: '',
          });
        }}
      />

      <TimeOffModal
        open={Boolean(timeOff)}
        defaultDay={timeOff?.day ?? undefined}
        people={people.data ?? []}
        requireApproval={data?.requireApproval !== false}
        onClose={() => setTimeOff(null)}
        onSaved={() => reload({ quiet: true })}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this booking?"
        message={`${whoOf(pendingDelete?.user)} on ${
          pendingDelete?.audit?.name ?? 'this engagement'
        }, ${pendingDelete?.start} → ${pendingDelete?.end}.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
