import { useMemo } from 'react';
import { CheckCircle2, ChevronRight, Info, OctagonAlert, RefreshCw, TriangleAlert } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

const LEVELS = {
  blocker: {
    icon: OctagonAlert,
    label: 'Blocker',
    text: 'text-crit',
    box: 'border-crit/25 bg-crit/[0.05]',
    tone: 'danger',
  },
  warning: {
    icon: TriangleAlert,
    label: 'Warning',
    text: 'text-med',
    box: 'border-med/25 bg-med/[0.05]',
    tone: 'warning',
  },
  note: {
    icon: Info,
    label: 'Note',
    text: 'text-info',
    box: 'border-info/20 bg-info/[0.04]',
    tone: 'info',
  },
};

const ORDER = ['blocker', 'warning', 'note'];

/**
 * Pre-delivery check: the things people notice after a report has been sent.
 *
 * Deliberately advisory — it never blocks generation. A tester mid-engagement
 * wants the draft, and a tool that refuses to produce one gets worked around.
 */
export default function PreflightPanel({ auditId, onGoToTab }) {
  const { data, loading, reload } = useResource(`/audits/${auditId}/preflight`);

  const grouped = useMemo(() => {
    const issues = data?.issues ?? [];
    return ORDER.map((level) => ({ level, items: issues.filter((i) => i.level === level) })).filter(
      (group) => group.items.length
    );
  }, [data]);

  if (loading && !data) return <LoadingBlock label="Checking the report…" />;
  if (!data) return null;

  return (
    <Card>
      <CardHeader
        title="Pre-delivery check"
        icon={data.clean ? CheckCircle2 : data.ready ? TriangleAlert : OctagonAlert}
        description={
          data.clean
            ? 'Nothing outstanding. This is ready to go out.'
            : data.ready
              ? 'Nothing broken, but there are things worth a look before sending.'
              : 'There are blockers that would make the report wrong or unusable.'
        }
        actions={
          <div className="flex items-center gap-2">
            {ORDER.map((level) =>
              data.counts[level] ? (
                <Badge key={level} tone={LEVELS[level].tone}>
                  {data.counts[level]} {LEVELS[level].label.toLowerCase()}
                  {data.counts[level] === 1 ? '' : 's'}
                </Badge>
              ) : null
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              icon={RefreshCw}
              title="Re-check"
              loading={loading}
              onClick={() => reload({ quiet: true })}
            />
          </div>
        }
      />

      {data.clean ? (
        <CardBody>
          <p className="flex items-center gap-2 text-sm text-low">
            <CheckCircle2 size={16} />
            All {data.checked} finding(s) and section(s) look complete.
          </p>
        </CardBody>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-4">
          {grouped.map(({ level, items }) => {
            const meta = LEVELS[level];
            return (
              <div key={level} className="flex flex-col gap-1.5">
                <p className={cn('text-[0.6875rem] font-semibold uppercase tracking-wider', meta.text)}>
                  {meta.label}
                  {items.length === 1 ? '' : 's'} · {items.length}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {items.map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>
                      <button
                        type="button"
                        onClick={() => issue.tab && onGoToTab?.(issue.tab)}
                        disabled={!issue.tab}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                          meta.box,
                          issue.tab ? 'hover:brightness-125' : 'cursor-default'
                        )}
                      >
                        <meta.icon size={14} className={cn('mt-0.5 shrink-0', meta.text)} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium text-fg">{issue.message}</span>
                          {issue.detail ? (
                            <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-fg-muted">
                              {issue.detail}
                            </span>
                          ) : null}
                        </span>
                        {issue.tab ? (
                          <span className="flex shrink-0 items-center gap-0.5 text-[0.625rem] capitalize text-fg-subtle">
                            {issue.tab}
                            <ChevronRight size={11} />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
