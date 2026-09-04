import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, RotateCcw } from 'lucide-react';

import {
  BASE_METRICS,
  TEMPORAL_METRICS,
  CVSS_DEFAULT_VECTOR,
  buildVector,
  calculateCvss,
  isCvss4,
  parseVector,
} from '../../lib/cvss.js';
import {
  BASE_METRICS_4,
  CVSS4_DEFAULT_VECTOR,
  ENVIRONMENTAL_METRICS_4,
  SUPPLEMENTAL_METRICS_4,
  THREAT_METRICS_4,
  buildVector4,
  parseVector4,
} from '../../lib/cvss4.js';
import { cn, SEVERITY_META } from '../../lib/utils.js';
import { Button } from '../ui/Button.jsx';
import { SeverityBadge } from '../ui/Badge.jsx';

/** Big score readout, coloured by severity. */
export function CvssScore({ score, severity, label = 'Base score', className }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.None;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        className={cn(
          'grid size-14 shrink-0 place-items-center rounded-xl ring-1 ring-inset',
          meta.bg,
          meta.ring
        )}
      >
        <span className={cn('font-mono text-lg font-bold tabular-nums', meta.text)}>
          {score === null || score === undefined || score === '' ? '—' : Number(score).toFixed(1)}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">{label}</p>
        <p className={cn('text-sm font-semibold', meta.text)}>{meta.label}</p>
      </div>
    </div>
  );
}

function MetricRow({ metric, value, onSelect, editable = true }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg">{metric.name}</p>
        {metric.help ? (
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-fg-subtle">{metric.help}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {metric.values.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              title={option.help}
              disabled={!editable}
              onClick={() => onSelect(metric.key, option.value)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-brand-600 text-white'
                  : 'bg-white/5 text-fg-muted hover:bg-white/10 hover:text-fg'
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A collapsible group of optional metrics. */
function MetricGroup({ title, metrics, values, onSelect, note, editable = true }) {
  const [open, setOpen] = useState(false);
  const anySet = metrics.some((m) => values[m.key] && values[m.key] !== 'X');

  return (
    <div className="border-t border-line-soft">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-fg-muted transition hover:text-fg"
      >
        <ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} />
        {title}
        {anySet ? (
          <span className="rounded bg-brand-500/15 px-1.5 py-0.5 text-[0.625rem] text-brand-300">
            set
          </span>
        ) : (
          <span className="text-[0.6875rem] text-fg-subtle">optional</span>
        )}
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-line-soft px-4 py-3.5">
          {note ? <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">{note}</p> : null}
          {metrics.map((metric) => (
            <MetricRow
              key={metric.key}
              metric={metric}
              value={values[metric.key] ?? 'X'}
              onSelect={onSelect}
              editable={editable}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const VERSIONS = [
  { id: '3.1', label: 'v3.1' },
  { id: '4.0', label: 'v4.0' },
];

/**
 * Interactive CVSS vector builder for v3.1 and v4.0.
 *
 * The version comes from the vector itself, so a finding scored either way opens
 * in the right editor and both can coexist in one engagement. The score recomputes
 * locally on every click; the server recalculates from the stored vector
 * regardless, so this is purely for immediate feedback.
 */
export function CvssEditor({
  value,
  onChange,
  className,
  showTemporal = true,
  /**
   * False when the finding this scores is read-only — an approved engagement, a read-only account,
   * or somebody else holding the lock. The score is part of the finding, so it has to obey the same
   * rule: a vector somebody could still change on a locked finding is a locked finding they can
   * still change.
   */
  editable = true,
}) {
  const [copied, setCopied] = useState(false);
  const v4 = isCvss4(value);
  const fallback = v4 ? CVSS4_DEFAULT_VECTOR : CVSS_DEFAULT_VECTOR;
  const vector = value || fallback;

  /**
   * Whatever was last built in the other version. Switching version cannot
   * convert a vector — the metrics genuinely differ — so the discarded one is kept
   * here and handed back if the user switches away and returns.
   */
  const previous = useRef({});

  const metrics = useMemo(
    () => (v4 ? parseVector4(vector) : parseVector(vector)),
    [vector, v4]
  );
  const result = useMemo(() => calculateCvss(vector), [vector]);

  const select = (key, next) => {
    if (!editable) return;
    onChange(v4 ? buildVector4({ ...metrics, [key]: next }) : buildVector({ ...metrics, [key]: next }));
  };

  const switchVersion = (id) => {
    if ((id === '4.0') === v4) return;
    previous.current[v4 ? '4.0' : '3.1'] = vector;
    onChange(previous.current[id] ?? (id === '4.0' ? CVSS4_DEFAULT_VECTOR : CVSS_DEFAULT_VECTOR));
  };

  const copyVector = async () => {
    try {
      await navigator.clipboard.writeText(result.vector || value || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — the field is selectable anyway */
    }
  };

  const showSecondScore =
    showTemporal && result.temporalScore !== null && result.temporalScore !== result.baseScore;

  return (
    <div className={cn('rounded-lg bg-canvas/40 ring-1 ring-line', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <CvssScore
          score={result.baseScore}
          severity={result.baseSeverity}
          label={v4 ? 'CVSS-B score' : 'Base score'}
        />
        {showSecondScore ? (
          <CvssScore
            score={result.temporalScore}
            severity={result.temporalSeverity}
            label={v4 ? 'With threat' : 'Temporal'}
          />
        ) : null}
        {v4 && result.environmentalScore !== null && result.environmentalScore !== result.temporalScore ? (
          <CvssScore
            score={result.environmentalScore}
            severity={result.environmentalSeverity}
            label="With environment"
          />
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {/* Segmented version switch. Which version a finding uses is a
              per-finding choice: retests keep the version the original was
              scored with, new work can use 4.0. */}
          <div
            role="group"
            aria-label="CVSS version"
            className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line-soft"
          >
            {VERSIONS.map((version) => {
              const active = (version.id === '4.0') === v4;
              return (
                <button
                  key={version.id}
                  type="button"
                  aria-pressed={active}
                  disabled={!editable}
                  onClick={() => switchVersion(version.id)}
                  className={cn(
                    'rounded px-2 py-1 text-[0.6875rem] font-semibold transition-colors',
                    active ? 'bg-brand-600 text-white' : 'text-fg-muted hover:text-fg'
                  )}
                >
                  {version.label}
                </button>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="xs"
            icon={RotateCcw}
            disabled={!editable}
            onClick={() => editable && onChange(fallback)}
            title="Reset every metric"
          >
            Reset
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        {(v4 ? BASE_METRICS_4 : BASE_METRICS).map((metric) => (
          <MetricRow
            key={metric.key}
            metric={metric}
            value={metrics[metric.key]}
            onSelect={select}
            editable={editable}
          />
        ))}
      </div>

      {showTemporal && !v4 ? (
        <MetricGroup
          title="Temporal metrics"
          metrics={TEMPORAL_METRICS}
          values={metrics}
          onSelect={select}
          editable={editable}
        />
      ) : null}

      {showTemporal && v4 ? (
        <>
          <MetricGroup
            title="Threat metric"
            metrics={THREAT_METRICS_4}
            values={metrics}
            onSelect={select}
            note="Left undefined, v4.0 scores as though the flaw were being actively attacked — say so explicitly to score it lower."
          editable={editable}
          />
          <MetricGroup
            title="Environmental metrics"
            metrics={ENVIRONMENTAL_METRICS_4}
            values={metrics}
            onSelect={select}
            note="This client's priorities, not the flaw's. Undefined requirements also count as High."
          editable={editable}
          />
          <MetricGroup
            title="Supplemental metrics"
            metrics={SUPPLEMENTAL_METRICS_4}
            values={metrics}
            onSelect={select}
            note="Context for the reader — the specification never scores these, so they cannot change the number."
          editable={editable}
          />
        </>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line-soft px-4 py-2.5">
        {v4 ? (
          <span
            title="Which parts of the vector are filled in: B base, T threat, E environmental"
            className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[0.625rem] text-fg-subtle"
          >
            {result.nomenclature}
          </span>
        ) : null}
        <code className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-fg-subtle">
          {result.vector || value}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          icon={copied ? Check : Copy}
          onClick={copyVector}
          title="Copy vector"
          className={copied ? 'text-low' : undefined}
        />
      </div>
    </div>
  );
}

/** Read-only severity + score, used in tables and cards. */
export function CvssSummary({ vector, className }) {
  const result = useMemo(() => calculateCvss(vector), [vector]);
  return <SeverityBadge severity={result.baseSeverity} score={result.baseScore} className={className} />;
}

export const severityCountEntries = (counts) => [
  ['Critical', counts?.critical ?? 0],
  ['High', counts?.high ?? 0],
  ['Medium', counts?.medium ?? 0],
  ['Low', counts?.low ?? 0],
  ['None', counts?.none ?? 0],
];

/**
 * Stacked severity meter. Segments are separated by a 2px surface gap so
 * adjacent colours never touch — necessary because severity hues sit close
 * together for tritan vision. Always pair it with labels (see SeverityLegend);
 * the bar alone is a secondary encoding, never the only one.
 */
export function SeverityBar({ counts, total, className, height = 6 }) {
  const order = severityCountEntries(counts);
  const sum = total ?? order.reduce((acc, [, n]) => acc + n, 0);

  if (!sum) {
    return (
      <div
        role="img"
        aria-label="No findings"
        style={{ height }}
        className={cn('w-full rounded-full bg-white/6', className)}
      />
    );
  }

  const present = order.filter(([, count]) => count > 0);
  const label = present.map(([s, n]) => `${SEVERITY_META[s].label}: ${n}`).join(', ');

  return (
    <div
      role="img"
      aria-label={label}
      style={{ height, gap: 2 }}
      className={cn('flex w-full overflow-hidden rounded-full bg-white/6', className)}
    >
      {present.map(([severity, count]) => (
        <span
          key={severity}
          title={`${SEVERITY_META[severity].label}: ${count}`}
          style={{ width: `${(count / sum) * 100}%` }}
          className={cn('rounded-full', SEVERITY_META[severity].dot)}
        />
      ))}
    </div>
  );
}

/** Labelled counts for the severity meter — the required text encoding. */
export function SeverityLegend({ counts, className, showZero = false }) {
  const entries = severityCountEntries(counts).filter(([, n]) => showZero || n > 0);
  if (!entries.length) {
    return <p className={cn('text-xs text-fg-subtle', className)}>No findings recorded yet.</p>;
  }
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {entries.map(([severity, count]) => {
        const meta = SEVERITY_META[severity];
        return (
          <li key={severity} className="flex items-center gap-1.5 text-xs">
            <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
            <span className="text-fg-muted">{meta.label}</span>
            <span className="font-mono font-semibold tabular-nums text-fg">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default CvssEditor;
