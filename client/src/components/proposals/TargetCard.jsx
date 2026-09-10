import { useState } from 'react';
import { Target } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useToast } from '../../context/ToastContext.jsx';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * The quarter's target, and how far along it is.
 *
 * Counted in wins rather than in money, and it is worth saying why where somebody will look for the
 * missing currency: nothing in this app has a price. A proposal carries days. A target in euros
 * would be a figure nobody could compute progress against, which is worse than no target at all —
 * so this counts the thing that is real today, and the server keeps a `value` field for the day a
 * rate card exists.
 *
 * A quarter, not a month: a pentest sale takes weeks to decide, so a monthly target is mostly noise
 * about when a client happened to reply. The median decision time on the card beside this one is
 * usually the argument for that.
 */

/** Whether a quarter has run out, which changes "on track" into "missed". */
function quarterProgress(from, to) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || now >= end) return 1;
  if (now <= start) return 0;
  return (now - start) / (end - start);
}

/**
 * One person's line.
 *
 * The bar is against the target; the thin marker is where the quarter itself has got to. Somebody
 * on four of eight wins is either exactly on track or in trouble depending entirely on the date,
 * and a bar without that marker cannot tell the two apart.
 */
/** An amount, grouped, with the currency after it. The cents are not grouped. */
const amountText = (amount, currency) => {
  if (amount === null || amount === undefined) return '';
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`;
};

function Line({ row, elapsed, onEdit, currency }) {
  const hasTarget = row.target !== null && row.target > 0;
  const percent = hasTarget ? Math.min(100, Math.round((row.wins / row.target) * 100)) : 0;
  const behind = hasTarget && percent < Math.round(elapsed * 100) - 10;

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 truncate text-sm text-fg">{row.user.name}</span>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs">
          <span className="font-mono text-sm text-fg">{row.wins}</span>
          {hasTarget ? (
            <>
              <span className="text-fg-subtle">of {row.target}</span>
              <span className={behind ? 'text-warn' : 'text-fg-muted'}>· {percent}%</span>
            </>
          ) : (
            <span className="text-fg-subtle">no target set</span>
          )}
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="text-[0.6875rem] text-fg-subtle underline decoration-dotted transition hover:text-fg"
            >
              {hasTarget ? 'change' : 'set'}
            </button>
          ) : null}
        </span>
      </div>
      {hasTarget ? (
        <span className="relative block h-1.5 overflow-hidden rounded-full bg-white/5">
          <span
            className={`block h-full rounded-full ${
              percent >= 100 ? 'bg-low/80' : behind ? 'bg-warn/70' : 'bg-brand-500/70'
            }`}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
          {/* Where the quarter has got to, so "behind" is visible rather than inferred. */}
          <span
            className="absolute top-0 h-full w-px bg-fg/40"
            style={{ left: `${Math.round(elapsed * 100)}%` }}
            title="Where the quarter has got to"
          />
        </span>
      ) : null}
      {/*
        The money, only where a rate card makes it real. Under the bar rather than in it: the bar is
        against the target, which is counted in wins, and two scales in one bar reads as neither.
      */}
      {row.value !== null && row.value !== undefined ? (
        <p className="text-[0.6875rem] text-fg-subtle">
          {amountText(row.value, currency)} won
          {row.targetValue ? ` of ${amountText(row.targetValue, currency)}` : ''}
          {row.valuePercent !== null && row.valuePercent !== undefined
            ? ` · ${row.valuePercent}%`
            : ''}
        </p>
      ) : null}
      {row.note ? <p className="text-[0.6875rem] text-fg-subtle">{row.note}</p> : null}
    </li>
  );
}

export default function TargetCard() {
  const toast = useToast();
  const { isManager } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [quarter, setQuarter] = useState(String(Math.floor(now.getMonth() / 3) + 1));
  const [editing, setEditing] = useState(null);
  const [wins, setWins] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const { data, loading, reload } = useResource(
    `/proposals/targets?year=${year}&quarter=${quarter}`,
    { initial: null }
  );

  const elapsed = data ? quarterProgress(data.from, data.to) : 0;
  const rows = data?.rows ?? [];
  const mine = data?.mine ?? null;

  const open = (row) => {
    setEditing(row);
    setWins(row.target === null ? '' : String(row.target));
    setNote(row.note ?? '');
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/proposals/targets', {
        user: editing.user.id,
        year: Number(year),
        quarter: Number(quarter),
        wins: Number(wins || 0),
        note: note.trim(),
      });
      toast.success(`Target set for ${editing.user.name}`);
      setEditing(null);
      reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Target}
        title="The quarter's target"
        description={
          data?.team
            ? 'Wins against target, per person. The line across each bar is where the quarter has got to.'
            : 'Proposals won this quarter, against what was asked of you.'
        }
        actions={
          <div className="flex items-center gap-1.5">
            {/* `size` is a real select attribute meaning "rows visible", so the small variant is
                a class rather than a prop it would collide with. */}
            <Select
              className="h-8 pl-2.5 text-xs"
              value={quarter}
              onChange={(event) => setQuarter(event.target.value)}
              options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }))}
            />
            <Select
              className="h-8 pl-2.5 text-xs"
              value={year}
              onChange={(event) => setYear(event.target.value)}
              options={[now.getFullYear(), now.getFullYear() - 1].map((y) => ({
                value: String(y),
                label: String(y),
              }))}
            />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {loading && !data ? (
          <LoadingBlock label="Counting wins…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Target}
            title="Nobody has a target this quarter"
            description={
              isManager
                ? 'Set one from here once there is somebody selling.'
                : 'A manager sets these. Your wins are still counted.'
            }
          />
        ) : (
          <>
            {/* Yours first and in words, because the number a salesperson wants is their own. */}
            {mine && !data.team ? (
              <p className="text-sm text-fg-muted">
                <span className="font-mono text-lg text-fg">{mine.wins}</span>{' '}
                {mine.target === null ? (
                  <>won this quarter. Nobody has set you a target.</>
                ) : mine.remaining === 0 ? (
                  <span className="text-low">won — target met.</span>
                ) : (
                  <>
                    won, {mine.remaining} to go{mine.percent !== null ? ` (${mine.percent}%)` : ''}.
                  </>
                )}
              </p>
            ) : null}

            <ul className="divide-y divide-line-soft">
              {rows.map((row) => (
                <Line
                  key={row.user.id}
                  row={row}
                  elapsed={elapsed}
                  currency={data.currency}
                  onEdit={isManager ? open : null}
                />
              ))}
            </ul>

            {data.team && data.totals.target ? (
              <p className="border-t border-line-soft pt-2 text-xs text-fg-muted">
                {data.totals.wins} of {data.totals.target} across the team ·{' '}
                {Math.round(elapsed * 100)}% of the quarter gone
              </p>
            ) : null}
          </>
        )}
      </CardBody>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={`Q${quarter} ${year} target${editing ? ` — ${editing.user.name}` : ''}`}
        description="How many proposals they are expected to win this quarter. Wins are counted from the date a client accepted, not from when the paperwork caught up."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Set it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Wins"
            type="number"
            min="0"
            step="1"
            autoFocus
            value={wins}
            onChange={(event) => setWins(event.target.value)}
            hint={editing ? `They have ${editing.wins} so far this quarter.` : ''}
          />
          <Textarea
            label="Anything worth saying about it"
            rows={2}
            placeholder="Two of these should be retainers."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </Modal>
    </Card>
  );
}
