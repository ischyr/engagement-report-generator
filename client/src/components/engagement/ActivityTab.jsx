import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AtSign,
  CalendarRange,
  ClipboardCheck,
  Crosshair,
  FileDown,
  History,
  ListChecks,
  NotebookPen,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { displayName, formatDate, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { useResource } from '../../hooks/useResource.js';
import ActivityHeatmap, { HeatmapLegend } from '../charts/ActivityHeatmap.jsx';
import { Button } from '../ui/Button.jsx';
import { Select } from '../ui/Field.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../ui/Feedback.jsx';
import { Avatar } from '../ui/Misc.jsx';

/** Icon and accent per family of action, keyed on the prefix before the dot. */
/**
 * How many entries to show before asking, and how many each reveal adds.
 *
 * The feed holds a hundred at a time so the filters and the calendar have something to work over.
 * Nobody reads a hundred rows from the top.
 */
const PAGE = 5;

const FAMILY = {
  audit: { icon: History, tone: 'text-brand-300' },
  report: { icon: FileDown, tone: 'text-brand-300' },
  finding: { icon: ShieldAlert, tone: 'text-high' },
  section: { icon: ListChecks, tone: 'text-fg-muted' },
  note: { icon: NotebookPen, tone: 'text-fg-muted' },
  check: { icon: ClipboardCheck, tone: 'text-low' },
  comment: { icon: AtSign, tone: 'text-med' },
  scope: { icon: Crosshair, tone: 'text-fg-muted' },
};

const FILTERS = [
  { value: 'all', label: 'Everything' },
  { value: 'finding', label: 'Findings' },
  { value: 'section', label: 'Sections' },
  { value: 'check', label: 'Test checks' },
  { value: 'comment', label: 'Comments' },
  { value: 'note', label: 'Notes' },
  { value: 'audit', label: 'Engagement & review' },
];

const familyOf = (action) => String(action ?? '').split('.')[0];

/** Groups entries under a date heading, so a long trail stays readable. */
function dayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Who changed what, and when.
 *
 * The counterpart to the review workflow: an approval means little without being
 * able to see what happened to the report after it was given.
 */
export default function ActivityTab({ audit }) {
  const [entries, setEntries] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, hasMore: false });
  const [filter, setFilter] = useState('all');
  /** A day picked out of the calendar, which narrows the list below to it. */
  const [day, setDay] = useState(null);

  /*
   * The same log, counted per day.
   *
   * Its own request rather than derived from `entries`: the list is paginated a hundred rows at a
   * time, so counting what has been fetched would draw a calendar that fills in as somebody
   * scrolls — and the gap in the middle of an engagement, which is the whole point, would only
   * appear once every page had been loaded.
   */
  const calendar = useResource(`/audits/${audit._id}/activity/calendar?days=180`, {
    initial: null,
  });

  const load = useCallback(
    async ({ before = null } = {}) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const query = before ? `?before=${encodeURIComponent(before)}` : '';
        const data = await api.get(`/audits/${audit._id}/activity${query}`);
        setEntries((prev) => (before ? [...prev, ...(data.entries ?? [])] : (data.entries ?? [])));
        setState({ loading: false, error: null, hasMore: Boolean(data.hasMore) });
      } catch (error) {
        setState({ loading: false, error, hasMore: false });
      }
    },
    [audit._id]
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * How much of the feed is on screen, and the size of a reveal.
   *
   * The hundred entries the server sends are what the *filters* and the calendar work over, so they
   * all have to be here — but a hundred rows is not a thing anybody reads from the top. Five, then
   * five more on request.
   */
  const [shown, setShown] = useState(PAGE);

  const visible = useMemo(() => {
    const byKind = filter === 'all' ? entries : entries.filter((e) => familyOf(e.action) === filter);
    if (!day) return byKind;
    // Compared as a `yyyy-mm-dd` prefix in UTC, exactly as the calendar grouped them: deriving
    // the day from a local Date here would put a late-evening entry on the wrong square.
    return byKind.filter((entry) => String(entry.createdAt ?? '').slice(0, 10) === day);
  }, [entries, filter, day]);

  /*
   * Back to five whenever the question changes. Picking a day on the calendar or switching the
   * filter asks something new, and answering it with however far somebody had scrolled through the
   * previous question is a list that starts in an arbitrary place.
   */
  useEffect(() => {
    setShown(PAGE);
  }, [filter, day]);

  const listed = visible.slice(0, shown);

  if (state.loading && entries.length === 0) return <LoadingBlock label="Loading activity…" />;
  if (state.error && entries.length === 0) return <ErrorState error={state.error} onRetry={load} />;

  let lastDay = null;

  const shape = calendar.data;

  return (
    <div className="flex flex-col gap-4">
      {/*
        When the work actually happened.

        The list answers "what happened" and cannot answer this: a fortnight where nothing moved
        has no rows in it, so the one thing worth noticing is the one thing a log cannot show.
      */}
      {shape?.days?.length ? (
        <Card>
          <CardHeader
            icon={CalendarRange}
            title="When this engagement was worked on"
            description={
              shape.total
                ? `${shape.total} entries across ${shape.activeDays} active day${
                    shape.activeDays === 1 ? '' : 's'
                  } — about ${shape.perActiveDay} a day when anybody was on it.`
                : 'Nothing logged in the last six months.'
            }
            actions={<HeatmapLegend />}
          />
          <CardBody className="flex flex-col gap-3">
            <ActivityHeatmap
              days={shape.days}
              selectedDay={day}
              onPickDay={(picked) => setDay(picked)}
            />

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] text-fg-subtle">
              {shape.busiest ? (
                <span>
                  Busiest day{' '}
                  <span className="text-fg">{formatDate(shape.busiest.day)}</span> ({shape.busiest.count})
                </span>
              ) : null}
              {/* The sentence a log cannot write. */}
              {shape.quietest ? (
                <span className="text-med">
                  Quiet for {shape.quietest.days} day{shape.quietest.days === 1 ? '' : 's'} from{' '}
                  {formatDate(shape.quietest.from)}
                </span>
              ) : null}
              {shape.people?.length ? (
                <span>
                  {shape.people.length === 1
                    ? shape.people[0].fullname
                    : `${shape.people.length} people`}{' '}
                  ·{' '}
                  {shape.people
                    .slice(0, 3)
                    .map((person) => `${person.fullname} (${person.count})`)
                    .join(', ')}
                  {shape.people.length > 3 ? ', …' : ''}
                </span>
              ) : null}
              {day ? (
                <button
                  type="button"
                  onClick={() => setDay(null)}
                  className="ml-auto text-brand-300 transition hover:text-brand-200"
                >
                  Showing {formatDate(day)} only — clear
                </button>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
      <CardHeader
        icon={History}
        title="Activity"
        description="Every change made to this engagement, newest first."
        actions={
          <>
            <Select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              options={FILTERS}
              className="h-9 w-44"
              wrapperClassName="w-44"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              icon={RefreshCw}
              aria-label="Refresh"
              onClick={() => load()}
              disabled={state.loading}
            />
          </>
        }
      />
      <CardBody>
        {visible.length === 0 ? (
          <EmptyState
            icon={History}
            title={
              day
                ? 'Nothing on that day'
                : entries.length
                  ? 'Nothing of that kind yet'
                  : 'No activity recorded yet'
            }
            description={
              day
                ? 'That square counts entries older than the hundred loaded here — load more, or pick another day.'
                : entries.length
                  ? 'Try a different filter.'
                  : 'Edits made from now on are logged here with who made them.'
            }
          />
        ) : (
          <ol className="flex flex-col">
            {listed.map((entry) => {
              const family = FAMILY[familyOf(entry.action)] ?? FAMILY.audit;
              const day = dayLabel(entry.createdAt);
              const heading = day !== lastDay ? day : null;
              lastDay = day;

              return (
                <li key={entry._id}>
                  {heading ? (
                    <p className="mb-2 mt-4 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle first:mt-0">
                      {heading}
                    </p>
                  ) : null}

                  <div className="flex gap-3 py-1.5">
                    {/* Rail: avatar plus the line that ties the entries together. */}
                    <div className="flex flex-col items-center">
                      <span className="relative shrink-0">
                        <Avatar user={entry.actor} size={26} />
                        <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-surface ring-1 ring-line">
                          <family.icon size={9} className={family.tone} />
                        </span>
                      </span>
                      <span aria-hidden className="mt-1 w-px flex-1 bg-line-soft" />
                    </div>

                    <div className="min-w-0 flex-1 pb-1">
                      <p className="text-xs leading-snug text-fg">{entry.summary}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[0.625rem] text-fg-subtle">
                        <span>{entry.actor ? displayName(entry.actor) : 'System'}</span>
                        <span>·</span>
                        <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                          {timeAgo(entry.createdAt)}
                        </time>
                        {entry.fields?.length ? (
                          <>
                            <span>·</span>
                            <span className="font-mono">{entry.fields.join(', ')}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {/*
          One button at a time, and the cheap one first: everything already fetched goes on screen
          before anything is asked of the server. Two buttons both offering "more" would make
          somebody choose between them without knowing the difference.
        */}
        {shown < visible.length ? (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="secondary" onClick={() => setShown((count) => count + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more
              <span className="ml-1 opacity-70">({visible.length - shown} older)</span>
            </Button>
          </div>
        ) : state.hasMore ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={state.loading}
              onClick={() => load({ before: entries.at(-1)?.createdAt })}
            >
              Load older activity
            </Button>
          </div>
        ) : null}
      </CardBody>
      </Card>
    </div>
  );
}
