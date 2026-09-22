import { useState } from 'react';
import { Clock, Check } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';

/** The amounts people actually type, so the common case is one click rather than a keyboard. */
const QUICK = [2, 4, 6, 8];

/**
 * The days you worked on something and never said how long for.
 *
 * Hours are the one record in this app that nothing ever asks for. A booking is made in advance
 * and a finding announces itself; a timesheet is a thing somebody has to *remember*, at the end of
 * a week in which remembering is the last thing on their mind. So the difference between what was
 * sold, what was planned and what it took — the one figure that lets the next job of the same
 * shape be quoted honestly — is the figure most likely to be missing, and it is missing in exactly
 * the weeks that were worst.
 *
 * The evidence is the activity log: it already knows who did what on which engagement and when.
 * "You edited four findings on Thursday" is as close to "you worked on Thursday" as anything in
 * the database gets, which makes this a prompt and not a claim — the hours are still yours to
 * state, and a day spent reading rather than typing will not appear here at all.
 *
 * Logged from here rather than by sending somebody to the engagement, because the whole reason the
 * number is missing is that getting to the form was four clicks and a tab nobody had open.
 */
export default function UnloggedDays() {
  const toast = useToast();
  const { data, loading, reload } = useResource('/time/unlogged', { initial: null });
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(() => new Set());

  const gaps = (data?.gaps ?? []).filter((gap) => !done.has(`${gap.auditId}:${gap.day}`));
  if (loading || !gaps.length) return null;

  const log = async (gap, hours) => {
    const key = `${gap.auditId}:${gap.day}`;
    setBusy(key);
    try {
      await api.post('/time', { audit: gap.auditId, day: gap.day, hours });
      /*
       * Marked done here rather than by refetching: the list is a question, and a question that
       * re-sorts itself under the cursor after every answer is one people stop answering.
       */
      setDone((current) => new Set(current).add(key));
      toast.success(`${hours} h logged`, `${gap.auditName} on ${formatDate(gap.day)}`);
    } catch (error) {
      toast.fromError(error);
      await reload({ quiet: true });
    } finally {
      setBusy('');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Clock}
        title="Days you worked and did not log"
        description="Taken from what you actually did, over the last three weeks. Oldest first — the day you are least likely to still remember is the one worth answering."
        actions={
          <Badge tone="neutral">
            {gaps.length} day{gaps.length === 1 ? '' : 's'}
          </Badge>
        }
      />
      <CardBody className="flex flex-col gap-1.5">
        {gaps.map((gap) => {
          const key = `${gap.auditId}:${gap.day}`;
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
            >
              <span className="shrink-0 text-[0.6875rem] tabular-nums text-fg">
                {formatDate(gap.day)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                {gap.auditName}
                {gap.reference ? (
                  <span className="text-fg-subtle"> · {gap.reference}</span>
                ) : null}
              </span>
              {/* How much you did that day. Not hours — it is the reason this row is here. */}
              <span className="shrink-0 text-[0.625rem] text-fg-subtle" title="Entries in the log">
                {gap.actions} action{gap.actions === 1 ? '' : 's'}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {QUICK.map((hours) => (
                  <Button
                    key={hours}
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(busy)}
                    loading={busy === key}
                    className={cn('px-2 tabular-nums')}
                    title={`Log ${hours} hours`}
                    onClick={() => log(gap, hours)}
                  >
                    {hours}h
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Nothing billable — stop asking about this one"
                  onClick={() => setDone((current) => new Set(current).add(key))}
                >
                  <Check size={13} />
                </Button>
              </span>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
