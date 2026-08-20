import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarRange,
  ClipboardCheck,
  Layers,
  ScrollText,
  ShieldAlert,
  Tags,
  TrendingUp,
  Users,
} from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useResource } from '../hooks/useResource.js';
import ActivityHeatmap, { HeatmapLegend } from '../components/charts/ActivityHeatmap.jsx';
import { cn, SEVERITY_META } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Stat } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { SeverityBar, SeverityLegend } from '../components/cvss/CvssEditor.jsx';
import {
  ChartCard,
  Legend,
  ProportionBar,
  RankedBars,
  RankedTable,
  SEVERITY_ORDER,
  SeverityColumns,
  SeverityTable,
  STATUS_META,
  severityLegendItems,
} from '../components/charts/Charts.jsx';

/** Presets as rows, because nobody fights a calendar grid for "last 90 days". */
const RANGES = [
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const statusSegments = (byStatus) =>
  ['open', 'retesting', 'fixed'].map((key) => ({
    label: STATUS_META[key].label,
    value: byStatus?.[key] ?? 0,
    fill: STATUS_META[key].fill,
  }));

/**
 * Trends across every engagement you can see.
 *
 * The dashboard answers "where do things stand"; this answers "what has been
 * happening". One range control at the top scopes every number below it, so the
 * charts and the tiles can never disagree.
 */
export default function InsightsPage() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState('365');
  /** Everyone's work, or only yours. */
  const [mine, setMine] = useState(false);
  /*
   * When anybody was working, day by day.
   *
   * Admin-only on the server, so this asks for it only when it will be answered — a 403 in the
   * network tab on every visit is the kind of noise that hides a real one.
   */
  const rhythm = useResource(isAdmin ? '/insights/activity?days=180' : null, { initial: null });

  const { data, error, loading, reload } = useResource(
    `/insights?days=${range}${mine ? '&mine=1' : ''}`,
    { initial: null }
  );

  if (loading && !data) return <LoadingBlock label="Crunching engagements…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { totals, bySeverity, openBySeverity, byStatus, byState, byType, categories, trend, oldestOpen, clients } =
    data;

  const severityCounts = {
    critical: bySeverity.Critical,
    high: bySeverity.High,
    medium: bySeverity.Medium,
    low: bySeverity.Low,
    none: bySeverity.None,
  };

  const nothing = totals.findings === 0 && totals.engagements === 0;

  return (
    <div
      className={cn(
        'flex flex-col gap-6 transition-opacity',
        // Refetch keeps the frame: hold the render, no skeleton flash.
        loading && data && 'opacity-60'
      )}
    >
      <PageHeader
        title="Insights"
        description={
          mine
            ? 'Your own findings and the engagements you are on — severity, remediation and coverage.'
            : 'How severity, remediation and coverage have moved across your engagements.'
        }
      />

      {/* One filter row, above everything it scopes. */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarRange size={14} className="text-fg-subtle" />
        <div
          role="group"
          aria-label="Date range"
          className="flex rounded-lg bg-white/5 p-0.5 ring-1 ring-line-soft"
        >
          {RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={range === option.value}
              onClick={() => setRange(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range === option.value
                  ? 'bg-brand-600 text-white'
                  : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Whose work"
          className="flex rounded-lg bg-white/5 p-0.5 ring-1 ring-line-soft"
        >
          {[
            { value: false, label: 'Everyone' },
            { value: true, label: 'Just me' },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={mine === option.value}
              onClick={() => setMine(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                mine === option.value ? 'bg-brand-600 text-white' : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-[0.6875rem] text-fg-subtle">
          {mine
            ? 'Findings you wrote up, on engagements you are on.'
            : 'Scopes every chart and number on this page.'}
        </span>
      </div>

      {nothing ? (
        <Card>
          <EmptyState
            icon={TrendingUp}
            title={mine ? 'Nothing of yours in this range' : 'Nothing in this range'}
            description={
              mine
                ? 'Findings are counted by who wrote them up. Widen the range, or switch to Everyone to see the whole instance.'
                : 'Widen the range, or run an engagement or two — every chart here is built from your own findings.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Engagements"
              value={totals.engagements}
              sub={`${byState.EDIT ?? 0} in progress · ${byState.APPROVED ?? 0} approved`}
              icon={ScrollText}
            />
            <Stat label="Findings" value={totals.findings} sub="in this range" icon={ShieldAlert} />
            <Stat
              label="Open critical & high"
              value={totals.openSerious}
              tone={totals.openSerious > 0 ? 'crit' : 'low'}
              sub={totals.openSerious === 0 ? 'nothing serious outstanding' : 'still not fixed'}
            />
            <Stat
              label="Fixed"
              value={totals.fixRate === null ? '—' : `${totals.fixRate}%`}
              tone={totals.fixRate !== null && totals.fixRate >= 50 ? 'low' : 'med'}
              sub={`${byStatus.fixed} of ${totals.findings} findings`}
              icon={ClipboardCheck}
            />
          </div>

          {/*
            The team's rhythm, rather than what it found.

            The rest of this page is about findings; this is about *when* anybody was working,
            which is the question a lead asks when a month felt quiet and nothing on the page
            explains why.
          */}
          {rhythm.data?.days?.length ? (
            <ChartCard
              icon={CalendarRange}
              title="When the team was working"
              description={
                rhythm.data.total
                  ? `${rhythm.data.total} logged changes across ${rhythm.data.activeDays} active day${
                      rhythm.data.activeDays === 1 ? '' : 's'
                    } in the last six months.`
                  : 'Nothing logged in the last six months.'
              }
              actions={<HeatmapLegend />}
            >
              <ActivityHeatmap days={rhythm.data.days} />
              {rhythm.data.people?.length ? (
                <p className="mt-3 text-[0.6875rem] text-fg-subtle">
                  Most active:{' '}
                  {rhythm.data.people
                    .slice(0, 5)
                    .map((person) => `${person.fullname} (${person.count})`)
                    .join(' · ')}
                </p>
              ) : null}
            </ChartCard>
          ) : null}

          <ChartCard
            icon={TrendingUp}
            title="Findings over time"
            description="When findings were written up, stacked by severity."
            table={<SeverityTable data={trend} />}
            actions={<Legend items={severityLegendItems(bySeverity)} />}
          >
            {trend.length ? (
              <SeverityColumns data={trend} />
            ) : (
              <p className="py-8 text-center text-xs text-fg-subtle">
                No findings in this range yet.
              </p>
            )}
          </ChartCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              icon={Layers}
              title="Remediation"
              description="Where everything in range stands."
              table={
                <Table>
                  <THead>
                    <TH>Status</TH>
                    <TH align="right">Findings</TH>
                  </THead>
                  <TBody>
                    {statusSegments(byStatus).map((segment) => (
                      <TR key={segment.label}>
                        <TD>{segment.label}</TD>
                        <TD align="right" className="font-mono tabular-nums">
                          {segment.value}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              }
            >
              <div className="flex flex-col gap-3">
                <ProportionBar segments={statusSegments(byStatus)} height={12} />
                <Legend items={statusSegments(byStatus).map((s) => ({ ...s, count: s.value }))} />

                {/* What is still open, by severity — the number that matters most. */}
                <div className="mt-2 border-t border-line-soft pt-3">
                  <p className="mb-2 text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
                    Still open, by severity
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {SEVERITY_ORDER.filter((severity) => (openBySeverity?.[severity] ?? 0) > 0).map(
                      (severity) => (
                        <li key={severity} className="flex items-center gap-2 text-xs">
                          <span
                            aria-hidden
                            className={cn('size-2 rounded-sm', SEVERITY_META[severity].dot)}
                          />
                          <span className="flex-1 text-fg-muted">
                            {SEVERITY_META[severity].label}
                          </span>
                          <span className="font-mono tabular-nums text-fg">
                            {openBySeverity[severity]}
                          </span>
                          {oldestOpen?.[severity] ? (
                            <span className="text-[0.625rem] text-fg-subtle">
                              oldest {oldestOpen[severity]}d
                            </span>
                          ) : null}
                        </li>
                      )
                    )}
                    {SEVERITY_ORDER.every((s) => (openBySeverity?.[s] ?? 0) === 0) ? (
                      <li className="text-xs text-low">Everything in range is fixed.</li>
                    ) : null}
                  </ul>
                </div>
              </div>
            </ChartCard>

            <ChartCard
              icon={Tags}
              title="Most common categories"
              description="What keeps coming up — the case for a hardening standard."
              table={<RankedTable data={categories} />}
            >
              {categories.length ? (
                <RankedBars data={categories} emphasise={(row) => row.isTail === true} />
              ) : (
                <p className="py-8 text-center text-xs text-fg-subtle">
                  No categorised findings in this range.
                </p>
              )}
            </ChartCard>
          </div>

          {/* Per client: a table, because eight clients is eight classes and a chart
              with eight colours stops being readable. */}
          <Card>
            <CardHeader
              icon={Users}
              title="By client"
              description="Who carries the most outstanding risk. Sorted by what is still open."
            />
            {clients.length === 0 ? (
              <EmptyState icon={Users} title="No client data in this range" />
            ) : (
              <Table>
                <THead>
                  <TH>Client</TH>
                  <TH align="right">Engagements</TH>
                  <TH align="right">Findings</TH>
                  <TH align="right">Open</TH>
                  <TH>Severity mix</TH>
                </THead>
                <TBody>
                  {clients.map((client) => {
                    const counts = {
                      critical: client.severityCounts.Critical,
                      high: client.severityCounts.High,
                      medium: client.severityCounts.Medium,
                      low: client.severityCounts.Low,
                      none: client.severityCounts.None,
                    };
                    return (
                      <TR key={client.company}>
                        <TD className="max-w-xs">
                          {client.companyId ? (
                            <Link
                              to={`/clients/${client.companyId}`}
                              className="block truncate text-sm font-medium text-fg hover:text-brand-300"
                            >
                              {client.company}
                            </Link>
                          ) : (
                            <span className="block truncate text-sm text-fg-muted">
                              {client.company}
                            </span>
                          )}
                        </TD>
                        <TD align="right" className="font-mono tabular-nums text-fg-muted">
                          {client.engagements}
                        </TD>
                        <TD align="right" className="font-mono tabular-nums text-fg-muted">
                          {client.findings}
                        </TD>
                        <TD align="right" className="font-mono tabular-nums">
                          <span className={client.open > 0 ? 'text-med' : 'text-low'}>
                            {client.open}
                          </span>
                        </TD>
                        <TD className="w-56">
                          {client.findings ? (
                            <div className="flex flex-col gap-1.5">
                              <SeverityBar counts={counts} total={client.findings} />
                              <SeverityLegend counts={counts} className="gap-x-2.5" />
                            </div>
                          ) : (
                            <span className="text-xs text-fg-subtle">—</span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              icon={ScrollText}
              title="Engagement types"
              description="What kind of work this range was made of."
              table={<RankedTable data={byType} label="Type" valueLabel="Engagements" />}
            >
              {byType.length ? (
                <RankedBars data={byType} valueLabel="engagements" />
              ) : (
                <p className="py-8 text-center text-xs text-fg-subtle">No engagements in range.</p>
              )}
            </ChartCard>

            <Card>
              <CardHeader
                icon={ClipboardCheck}
                title="Test coverage"
                description="Checklist items ticked across every engagement in range."
              />
              <CardBody className="flex flex-col gap-3">
                {totals.checks.total ? (
                  <>
                    <div className="flex items-baseline gap-2">
                      {/* Proportional figures: tabular digits make a headline number
                          look loose at this size. */}
                      <span className="text-3xl font-semibold text-fg">
                        {Math.round((totals.checks.done / totals.checks.total) * 100)}%
                      </span>
                      <span className="text-xs text-fg-muted">
                        {totals.checks.done} of {totals.checks.total} checks verified
                      </span>
                    </div>
                    <ProportionBar
                      segments={[
                        { label: 'Verified', value: totals.checks.done, fill: 'var(--color-ok)' },
                        {
                          label: 'Outstanding',
                          value: totals.checks.total - totals.checks.done,
                          fill: 'var(--color-line)',
                        },
                      ]}
                      height={10}
                    />
                    <p className="text-[0.6875rem] text-fg-subtle">
                      Coverage is the honest counterpart to the findings list — the ground
                      covered, not just what was found.
                    </p>
                  </>
                ) : (
                  <p className="py-6 text-center text-xs text-fg-subtle">
                    No test checks yet. Add a checklist on an engagement’s Checks tab.
                  </p>
                )}
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
