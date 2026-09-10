import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarClock,
  CalendarSync,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  ImageOff,
  OctagonPause,
  Plus,
  ScrollText,
  Send,
  ShieldAlert,
  Timer,
  TriangleAlert,
} from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { cn, formatDate, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import SetupChecklist from '../components/layout/SetupChecklist.jsx';
import { PageHeader, Stat } from '../components/ui/Misc.jsx';
import { Badge, SeverityBadge, StateBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { EmptyState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { SeverityBar, SeverityLegend } from '../components/cvss/CvssEditor.jsx';
import ActivityHeatmap, { HeatmapLegend } from '../components/charts/ActivityHeatmap.jsx';

/**
 * Reasons wear the status palette, never a series colour.
 *
 * These are states — blocked, needs a look, worth knowing — not categories in a chart, so they
 * get the reserved status steps and always ship with words beside them rather than colour alone.
 */
const LEVEL_META = {
  blocker: { dot: 'bg-crit', text: 'text-crit' },
  warning: { dot: 'bg-med', text: 'text-med' },
  note: { dot: 'bg-info', text: 'text-info' },
};

/** A row in one of the work queues. Deliberately a list: these are things to do, not magnitudes. */
function QueueRow({ to, children, className }) {
  return (
    <li>
      <Link
        to={to}
        className={cn(
          'flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40',
          className
        )}
      >
        {children}
      </Link>
    </li>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, loading } = useResource('/dashboard', { initial: null });
  const audits = useResource('/audits', { initial: [] });
  const templates = useResource('/templates?purpose=report', { initial: [] });
  const library = useResource('/vulnerabilities', { initial: [] });

  const list = Array.isArray(audits.data) ? audits.data : [];
  const recent = list.slice(0, 5);
  const noTemplates = !templates.loading && (templates.data?.length ?? 0) === 0;

  const totals = data?.totals;
  const mine = data?.mine;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome back, ${user?.firstname || user?.username || 'there'}`}
        description="What is waiting on you, what needs a look, and everything you can see."
        actions={
          <Button as={Link} to="/engagements" variant="primary" icon={Plus}>
            New engagement
          </Button>
        }
      />

      {/* Only on an instance that is not finished being set up; it removes itself after. */}
      <SetupChecklist />

      {noTemplates ? (
        <Card className="border-med/25 bg-med/[0.06]">
          <CardBody className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex gap-3">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-med" />
              <div>
                <p className="text-sm font-medium text-fg">No report template uploaded yet</p>
                <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                  Reports are rendered from a .docx you supply. Upload one — or start from the
                  bundled starter template — before generating a report.
                </p>
              </div>
            </div>
            <Button
              as={Link}
              to="/templates"
              variant="secondary"
              size="sm"
              iconRight={ArrowRight}
              className="shrink-0"
            >
              Go to templates
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {/*
        Five headline numbers, and only one of them wears a colour.
        A row where everything is red is a row where nothing is.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Engagements"
          value={totals?.engagements ?? list.length}
          sub={`${totals?.open ?? 0} still open`}
          icon={ScrollText}
        />
        <Stat
          label="Waiting on you"
          value={(mine?.checksTotal ?? 0) + (mine?.findingsTotal ?? 0)}
          sub={`${mine?.checksTotal ?? 0} checks, ${mine?.findingsTotal ?? 0} findings`}
          icon={ClipboardCheck}
        />
        <Stat
          label="Needs a look"
          value={data?.attention?.length ?? 0}
          sub="engagements with something outstanding"
          icon={TriangleAlert}
          tone={data?.attention?.length ? 'med' : undefined}
        />
        <Stat
          label="Open critical & high"
          value={totals?.openSerious ?? 0}
          sub="not yet fixed, across everything"
          tone={totals?.openSerious ? 'crit' : undefined}
          icon={ShieldAlert}
        />
        <Stat
          label="Library entries"
          value={library.data?.length ?? 0}
          sub="reusable vulnerabilities"
          icon={FileText}
        />
      </div>

      {loading && !data ? <LoadingBlock label="Working out what needs you…" /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------------------ your work */}
        <Card>
          <CardHeader
            icon={Timer}
            title="Your week"
            description="Where you are booked, what is assigned to you, and anything you have not written down yet."
          />
          {mine?.clear ? (
            <CardBody className="flex items-center gap-2.5 text-sm text-low">
              <CheckCircle2 size={16} />
              Nothing is waiting on you.
            </CardBody>
          ) : (
            <CardBody className="flex flex-col gap-4">
              {mine?.bookings?.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    Booked
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {mine.bookings.map((booking) => (
                      <QueueRow
                        key={`${booking.audit._id}-${booking.start}`}
                        to={`/engagements/${booking.audit._id}`}
                        className={booking.current ? 'border-brand-500/30' : ''}
                      >
                        <CalendarClock size={13} className="shrink-0 text-fg-subtle" />
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">
                          {booking.audit.name}
                        </span>
                        {booking.audit.onHold ? (
                          <Badge tone="danger" icon={OctagonPause}>
                            stopped
                          </Badge>
                        ) : null}
                        <span className="text-[0.625rem] text-fg-subtle">
                          {booking.current
                            ? `now, until ${formatDate(booking.end)}`
                            : `from ${formatDate(booking.start)}`}
                        </span>
                      </QueueRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {mine?.checks?.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    Checks assigned to you · {mine.checksTotal}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {mine.checks.map((check) => (
                      <QueueRow
                        key={check._id}
                        to={`/engagements/${check.audit._id}?tab=checks`}
                      >
                        <ClipboardCheck size={13} className="shrink-0 text-fg-subtle" />
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">
                          {check.title}
                        </span>
                        <span className="truncate text-[0.625rem] text-fg-subtle">
                          {check.audit.name}
                        </span>
                      </QueueRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {mine?.findings?.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    Your findings with no evidence · {mine.findingsTotal}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {mine.findings.map((finding) => (
                      <QueueRow
                        key={finding._id}
                        to={`/engagements/${finding.audit._id}/findings/${finding._id}`}
                      >
                        <SeverityBadge severity={finding.severity} score={finding.score} />
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">
                          {finding.title}
                        </span>
                        <ImageOff size={13} className="shrink-0 text-med" />
                      </QueueRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {mine?.unloggedDays?.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    Days booked with no hours logged
                  </p>
                  {/*
                    Said plainly rather than as a chart: the effort figure the report prints is
                    built from these entries, so a gap is a thing to go and fix, not a trend.
                  */}
                  <Link
                    to="/schedule"
                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-med/25 bg-med/[0.06] px-3 py-2 transition hover:border-med/40"
                  >
                    {mine.unloggedDays.slice(0, 8).map((day) => (
                      <span
                        key={day}
                        className="rounded bg-canvas/60 px-1.5 py-0.5 font-mono text-[0.625rem] text-fg-muted"
                      >
                        {formatDate(day, { day: 'numeric', month: 'short' })}
                      </span>
                    ))}
                    {mine.unloggedDays.length > 8 ? (
                      <span className="text-[0.625rem] text-fg-subtle">
                        +{mine.unloggedDays.length - 8} more
                      </span>
                    ) : null}
                  </Link>
                </div>
              ) : null}
            </CardBody>
          )}
        </Card>

        {/* -------------------------------------------------------- needs a look */}
        <Card>
          <CardHeader
            icon={TriangleAlert}
            title="Needs a look"
            description="Engagements with something outstanding, worst first. Each line says what and where."
          />
          {!data?.attention?.length ? (
            <CardBody className="flex items-center gap-2.5 text-sm text-low">
              <CheckCircle2 size={16} />
              Nothing outstanding anywhere you can see.
            </CardBody>
          ) : (
            <CardBody className="flex flex-col gap-1.5">
              {data.attention.map((row) => (
                <div
                  key={row.audit._id}
                  className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/engagements/${row.audit._id}`}
                      className="min-w-0 flex-1 truncate text-xs text-fg transition hover:text-brand-300"
                    >
                      {row.audit.name}
                    </Link>
                    {row.company ? (
                      <span className="truncate text-[0.625rem] text-fg-subtle">{row.company}</span>
                    ) : null}
                    <StateBadge state={row.audit.state} />
                  </div>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {row.reasons.map((reason) => {
                      const meta = LEVEL_META[reason.level] ?? LEVEL_META.note;
                      return (
                        <li key={reason.code}>
                          <Link
                            to={`/engagements/${row.audit._id}?tab=${reason.tab}`}
                            className="flex items-center gap-2 text-[0.6875rem] leading-relaxed text-fg-muted transition hover:text-fg"
                          >
                            <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} />
                            <span className="min-w-0 flex-1 truncate">
                              {reason.label}
                              {/* The server keeps days out of its sentences; this is the side
                                  that knows how to write one. */}
                              {reason.day ? ` — ${formatDate(reason.day)}` : ''}
                            </span>
                            <ArrowRight size={11} className="shrink-0 text-fg-subtle" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </CardBody>
          )}
        </Card>
      </div>

      {/*
        Change over time, so a heatmap — one hue, light to dark, and the only chart on the page
        that has a time axis. Yours alone: the whole team's rhythm is a management view.
      */}
      {data?.activity?.days?.length ? (
        <Card>
          <CardHeader
            icon={CalendarClock}
            title="Your last four months"
            description={`${data.activity.total} things you did, by the day you did them.`}
          />
          <CardBody className="flex flex-wrap items-end justify-between gap-4">
            {/* Scrolls inside its own box rather than stretching the page on a narrow window. */}
            <div className="min-w-0 max-w-full overflow-x-auto">
              <ActivityHeatmap days={data.activity.days} />
            </div>
            {/* A sequential scale needs its key: light to dark means nothing on its own. */}
            <HeatmapLegend />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Recent engagements"
            description="Ordered by last edit."
            icon={ScrollText}
            actions={
              <Link
                to="/engagements"
                className="text-xs font-medium text-brand-300 transition hover:underline"
              >
                View all
              </Link>
            }
          />
          {audits.loading ? (
            <LoadingBlock />
          ) : recent.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No engagements yet"
              description="Create your first engagement to start recording findings."
            >
              <Button as={Link} to="/engagements" variant="primary" size="sm" icon={Plus}>
                New engagement
              </Button>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line-soft">
              {recent.map((audit) => (
                <li key={audit._id}>
                  <Link
                    to={`/engagements/${audit._id}`}
                    className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-white/[0.035]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-fg">{audit.name}</p>
                        <StateBadge state={audit.state} />
                        {audit.onHold ? (
                          <Badge tone="danger" icon={OctagonPause}>
                            stopped
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-fg-muted">
                        {[audit.company?.name, audit.auditType].filter(Boolean).join(' · ') ||
                          'No client set'}
                        {' · edited '}
                        {timeAgo(audit.updatedAt)}
                      </p>
                      <div className="mt-2 max-w-56">
                        <SeverityBar counts={audit.severityCounts} total={audit.findingCount} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm font-semibold tabular-nums text-fg">
                        {audit.findingCount ?? 0}
                      </p>
                      <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">
                        findings
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Findings by severity"
              description="Every finding you can currently see."
              icon={ShieldAlert}
            />
            <CardBody className="flex flex-col gap-4">
              {/* One stacked bar and its legend: identity is never carried by colour alone. */}
              <SeverityBar
                counts={totals?.severityCounts}
                total={totals?.findings ?? 0}
                height={10}
              />
              <SeverityLegend counts={totals?.severityCounts} showZero className="gap-x-5" />
              {!totals?.findings ? (
                <p className="text-xs leading-relaxed text-fg-subtle">
                  Counts appear here once you add findings to an engagement.
                </p>
              ) : null}
            </CardBody>
          </Card>

          {/* Only when there is something to say — an empty "coming up" is furniture. */}
          {data?.due?.length ? (
            <Card>
              <CardHeader
                icon={CalendarSync}
                title="Coming round again"
                description="Work that repeats, and is due."
              />
              <CardBody className="flex flex-col gap-1.5">
                {data.due.map((row) => (
                  <Link
                    key={row.audit._id}
                    to={`/engagements/${row.audit._id}?tab=overview`}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {row.company || row.audit.name}
                    </span>
                    <Badge tone={row.overdue ? 'warning' : 'neutral'}>
                      {row.overdue ? 'due' : formatDate(row.nextDue)}
                    </Badge>
                  </Link>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {data?.deliveries?.length ? (
            <Card>
              <CardHeader
                icon={Send}
                title="Recently delivered"
                description="The last few reports that went to a client."
                actions={
                  <Link
                    to="/deliverables"
                    className="text-xs font-medium text-brand-300 transition hover:underline"
                  >
                    All of them
                  </Link>
                }
              />
              <CardBody className="flex flex-col gap-1.5">
                {data.deliveries.map((delivery) => (
                  <Link
                    key={delivery._id}
                    to={`/engagements/${delivery.audit._id}?tab=delivery`}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {delivery.audit.name}
                    </span>
                    {delivery.version ? (
                      <Badge tone="neutral">{delivery.version}</Badge>
                    ) : null}
                    <span className="text-[0.625rem] text-fg-subtle">
                      {timeAgo(delivery.sentAt)}
                    </span>
                  </Link>
                ))}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody className="flex flex-col gap-2">
              <Link
                to="/library"
                className="flex items-center justify-between rounded-lg px-2 py-2 text-sm text-fg-muted transition hover:bg-white/5 hover:text-fg"
              >
                Browse the vulnerability library
                <ArrowRight size={14} />
              </Link>
              <Link
                to="/deliverables"
                className="flex items-center justify-between rounded-lg px-2 py-2 text-sm text-fg-muted transition hover:bg-white/5 hover:text-fg"
              >
                Every report that has gone out
                <ArrowRight size={14} />
              </Link>
              <Link
                to="/templates"
                className="flex items-center justify-between rounded-lg px-2 py-2 text-sm text-fg-muted transition hover:bg-white/5 hover:text-fg"
              >
                Manage report templates
                <ArrowRight size={14} />
              </Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
