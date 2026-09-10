/**
 * The chart pieces the Insights and client pages are built from.
 *
 * Plain SVG and CSS — no charting library, for the same reason there is no
 * server-side PDF renderer: it keeps the install small, and these forms are simple
 * enough that a library would mostly add weight and a theme to fight.
 *
 * Rules these follow deliberately, because they are what make charts readable
 * rather than decorative:
 *
 *   - Severity is a *status* scale, not a categorical palette. Its five steps were
 *     validated against the card surface: worst adjacent pair ΔE 17.6 for normal
 *     vision, 11.6 protan, 7.3 tritan. Tritan sits in the floor band, so severity is
 *     never encoded by colour alone — every chart carries a legend, a 2px surface gap
 *     between segments, hover labels, and a table view.
 *   - Nominal categories get **one** colour for every bar. Shading them by size would
 *     double-encode length as hue and spend the only free channel on information the
 *     bar already shows.
 *   - Marks are thin, gridlines are hairline and solid, and nothing is labelled that
 *     the axis or the tooltip already answers.
 *   - Every chart has a table twin, so no value is reachable only by hovering.
 */

import { useState } from 'react';
import { Table2, ChartColumn } from 'lucide-react';

import { cn, SEVERITY_META } from '../../lib/utils.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

/** Severity order, worst first — the order stacks and legends read in. */
export const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'None'];

/** Fills come from the theme tokens so charts and badges cannot drift apart. */
const SEVERITY_FILL = {
  Critical: 'var(--color-crit)',
  High: 'var(--color-high)',
  Medium: 'var(--color-med)',
  Low: 'var(--color-low)',
  None: 'var(--color-info)',
};

export const STATUS_META = {
  open: { label: 'Not fixed', fill: 'var(--color-danger)', text: 'text-crit' },
  retesting: { label: 'Retesting', fill: 'var(--color-warn)', text: 'text-med' },
  fixed: { label: 'Fixed', fill: 'var(--color-ok)', text: 'text-low' },
};

const SURFACE = 'var(--color-surface)';
const GRID = 'var(--color-line-soft)';

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A chart in a card, with the table view one click away.
 *
 * The toggle is not a nicety: severity's tritan separation is in the floor band, so
 * a non-colour route to every value is required rather than optional.
 */
export function ChartCard({ title, description, icon, children, table, actions, className }) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card className={className}>
      <CardHeader
        title={title}
        description={description}
        icon={icon}
        actions={
          <div className="flex items-center gap-2">
            {actions}
            {table ? (
              <button
                type="button"
                onClick={() => setShowTable((v) => !v)}
                title={showTable ? 'Show the chart' : 'Show the numbers as a table'}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-fg-muted transition hover:bg-white/5 hover:text-fg"
              >
                {showTable ? <ChartColumn size={13} /> : <Table2 size={13} />}
                {showTable ? 'Chart' : 'Table'}
              </button>
            ) : null}
          </div>
        }
      />
      <CardBody>{showTable && table ? table : children}</CardBody>
    </Card>
  );
}

/** Identity channel that never depends on colour vision. */
export function Legend({ items, className }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            style={{ background: item.fill }}
            className="size-2.5 shrink-0 rounded-sm"
          />
          <span className="text-[0.6875rem] text-fg-muted">
            {item.label}
            {item.count !== undefined ? (
              <span className="ml-1 font-mono tabular-nums text-fg-subtle">{item.count}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Follows the pointer; values lead, labels follow. */
function Tooltip({ point }) {
  if (!point) return null;
  return (
    <div
      role="status"
      style={{ left: point.x, top: point.y }}
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-overlay px-2.5 py-1.5 shadow-pop"
    >
      <p className="whitespace-nowrap text-[0.6875rem] font-semibold text-fg">{point.title}</p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {point.rows.map((row) => (
          <li key={row.label} className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden style={{ background: row.fill }} className="h-0.5 w-3 rounded-full" />
            <span className="font-mono text-[0.6875rem] font-semibold tabular-nums text-fg">
              {row.value}
            </span>
            <span className="text-[0.625rem] text-fg-muted">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Axis ticks land on round numbers, so the reader is not doing arithmetic. */
function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Math.round(value));
  return ticks;
}

const monthLabel = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
  });
};

/* -------------------------------------------------------------------------- */
/* Severity over time                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Findings per month, stacked by severity.
 *
 * Columns rather than a line: the reader's job is part-to-whole within each month
 * *and* the month-to-month total, which a stack gives and five lines would not.
 */
export function SeverityColumns({ data, height = 200 }) {
  const [hovered, setHovered] = useState(null);

  const max = Math.max(1, ...data.map((row) => row.total ?? 0));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];

  const GAP = 2; // the surface gap between stacked segments
  const BAR_MAX = 24; // marks stay thin; the band's leftover is air
  const slot = 100 / Math.max(data.length, 1);

  return (
    <div className="relative">
      <div className="flex">
        {/* Y axis. Its own column, so the ticks cannot collide with the plot. */}
        <div
          style={{ height }}
          className="flex w-8 shrink-0 flex-col justify-between pr-2 text-right"
        >
          {[...ticks].reverse().map((tick) => (
            <span key={tick} className="font-mono text-[0.625rem] tabular-nums text-fg-subtle">
              {tick}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div style={{ height }} className="relative">
            {/* Hairline gridlines, solid and one step off the surface. */}
            {ticks.map((tick) => (
              <span
                key={tick}
                aria-hidden
                style={{ bottom: `${(tick / top) * 100}%`, background: GRID }}
                className="absolute inset-x-0 h-px"
              />
            ))}

            <div className="absolute inset-0 flex items-end">
              {data.map((row) => {
                const total = row.total ?? 0;
                const present = SEVERITY_ORDER.filter((severity) => (row[severity] ?? 0) > 0);

                return (
                  <div
                    key={row.month}
                    style={{ width: `${slot}%` }}
                    className="flex h-full items-end justify-center"
                  >
                    <div
                      tabIndex={0}
                      role="button"
                      aria-label={`${monthLabel(row.month)}: ${total} finding${total === 1 ? '' : 's'}${present.length ? `, ${present.map((s) => `${SEVERITY_META[s].label} ${row[s]}`).join(', ')}` : ''}`}
                      onMouseMove={(event) => {
                        const box = event.currentTarget.closest('.relative').getBoundingClientRect();
                        const mark = event.currentTarget.getBoundingClientRect();
                        setHovered({
                          x: mark.left - box.left + mark.width / 2,
                          y: mark.top - box.top - 6,
                          title: monthLabel(row.month),
                          rows: present.length
                            ? present.map((severity) => ({
                                label: SEVERITY_META[severity].label,
                                value: row[severity],
                                fill: SEVERITY_FILL[severity],
                              }))
                            : [{ label: 'findings', value: 0, fill: GRID }],
                        });
                      }}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={(event) => {
                        const box = event.currentTarget.closest('.relative').getBoundingClientRect();
                        const mark = event.currentTarget.getBoundingClientRect();
                        setHovered({
                          x: mark.left - box.left + mark.width / 2,
                          y: mark.top - box.top - 6,
                          title: monthLabel(row.month),
                          rows: present.map((severity) => ({
                            label: SEVERITY_META[severity].label,
                            value: row[severity],
                            fill: SEVERITY_FILL[severity],
                          })),
                        });
                      }}
                      onBlur={() => setHovered(null)}
                      // The hit area is the whole column slot, not the painted bar:
                      // a 3px-tall segment is not something anyone can point at.
                      className="flex h-full w-full max-w-6 cursor-default flex-col justify-end rounded-sm outline-none ring-brand-500/60 focus-visible:ring-2"
                      style={{ maxWidth: BAR_MAX }}
                    >
                      {present.map((severity, index) => {
                        const value = row[severity] ?? 0;
                        return (
                          <span
                            key={severity}
                            aria-hidden
                            style={{
                              height: `${(value / top) * 100}%`,
                              background: SEVERITY_FILL[severity],
                              // 4px rounded data-end on the top segment only; the
                              // stack sits square on the baseline.
                              borderTopLeftRadius: index === 0 ? 4 : 0,
                              borderTopRightRadius: index === 0 ? 4 : 0,
                              // The 2px separator is surface-coloured space, not a stroke.
                              marginBottom: index === present.length - 1 ? 0 : GAP,
                              minHeight: value > 0 ? 2 : 0,
                            }}
                            className="w-full"
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* X axis band, inside the card's flow so it can never be cut off. */}
          <div className="mt-1.5 flex">
            {data.map((row, index) => (
              <span
                key={row.month}
                style={{ width: `${slot}%` }}
                className="truncate text-center text-[0.625rem] text-fg-subtle"
              >
                {/* Thin the labels rather than let them collide. */}
                {data.length <= 8 || index % Math.ceil(data.length / 8) === 0
                  ? monthLabel(row.month)
                  : ''}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Tooltip point={hovered} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Horizontal bars — one colour, ranked                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ranked magnitude for nominal categories.
 *
 * Every bar is the same colour on purpose: these categories have no order, and
 * shading them by size would encode the bar's length twice.
 */
export function RankedBars({ data, valueLabel = 'findings', emphasise }) {
  const [hovered, setHovered] = useState(null);
  const max = Math.max(1, ...data.map((row) => row.count));

  return (
    <div className="relative flex flex-col gap-2">
      {data.map((row) => {
        const highlighted = emphasise ? emphasise(row) : false;
        return (
          <div key={row.label} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3">
            <span className="truncate text-xs text-fg-muted" title={row.label}>
              {row.label}
            </span>
            <div className="flex items-center gap-2">
              <div
                tabIndex={0}
                role="button"
                aria-label={`${row.label}: ${row.count} ${valueLabel}`}
                onMouseMove={(event) => {
                  const box = event.currentTarget.closest('.relative').getBoundingClientRect();
                  const mark = event.currentTarget.getBoundingClientRect();
                  setHovered({
                    x: mark.left - box.left + Math.min(mark.width, 120),
                    y: mark.top - box.top,
                    title: row.label,
                    rows: [
                      {
                        label: valueLabel,
                        value: row.count,
                        fill: highlighted ? 'var(--color-crit)' : 'var(--color-brand-500)',
                      },
                    ],
                  });
                }}
                onMouseLeave={() => setHovered(null)}
                onBlur={() => setHovered(null)}
                className="min-w-0 flex-1 cursor-default rounded-sm py-1.5 outline-none ring-brand-500/60 focus-visible:ring-2"
              >
                <span
                  aria-hidden
                  style={{
                    width: `${Math.max((row.count / max) * 100, 1.5)}%`,
                    background: highlighted ? 'var(--color-crit)' : 'var(--color-brand-500)',
                  }}
                  // Square at the baseline, 4px rounded at the data end.
                  className="block h-2 rounded-r"
                />
              </div>
              {/* The value at the tip, in text ink — never in the mark's colour. */}
              <span className="w-8 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                {row.count}
              </span>
            </div>
          </div>
        );
      })}
      <Tooltip point={hovered} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Part-to-whole strip                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One bar, split by class — for remediation status, where three classes and a total
 * is the whole story and a chart with axes would be overkill.
 */
export function ProportionBar({ segments, height = 10, className }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (!total) {
    return (
      <div
        role="img"
        aria-label="Nothing to show"
        style={{ height }}
        className={cn('w-full rounded-full bg-white/6', className)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={segments
        .filter((s) => s.value > 0)
        .map((s) => `${s.label}: ${s.value}`)
        .join(', ')}
      style={{ height, gap: 2 }}
      className={cn('flex w-full', className)}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.label}
            title={`${segment.label}: ${segment.value}`}
            style={{ width: `${(segment.value / total) * 100}%`, background: segment.fill }}
            className="rounded-full"
          />
        ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table twins                                                                */
/* -------------------------------------------------------------------------- */

/** The table view for a severity-by-month chart. */
export function SeverityTable({ data }) {
  return (
    <Table>
      <THead>
        <TH>Month</TH>
        {SEVERITY_ORDER.map((severity) => (
          <TH key={severity} align="right">
            {SEVERITY_META[severity].label}
          </TH>
        ))}
        <TH align="right">Total</TH>
      </THead>
      <TBody>
        {data.map((row) => (
          <TR key={row.month}>
            <TD className="whitespace-nowrap">{monthLabel(row.month)}</TD>
            {SEVERITY_ORDER.map((severity) => (
              <TD key={severity} align="right" className="font-mono tabular-nums">
                {row[severity] ?? 0}
              </TD>
            ))}
            <TD align="right" className="font-mono font-semibold tabular-nums">
              {row.total ?? 0}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** The table view for any ranked list. */
export function RankedTable({ data, label = 'Category', valueLabel = 'Findings' }) {
  return (
    <Table>
      <THead>
        <TH>{label}</TH>
        <TH align="right">{valueLabel}</TH>
      </THead>
      <TBody>
        {data.map((row) => (
          <TR key={row.label}>
            <TD>{row.label}</TD>
            <TD align="right" className="font-mono tabular-nums">
              {row.count}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export const severityLegendItems = (counts) =>
  SEVERITY_ORDER.map((severity) => ({
    label: SEVERITY_META[severity].label,
    fill: SEVERITY_FILL[severity],
    count: counts?.[severity],
  }));

export { SEVERITY_FILL, SURFACE };
