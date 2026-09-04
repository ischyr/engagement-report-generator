import { useState } from 'react';
import { Trophy, TrendingDown } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Tabs } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Why we win and why we lose, counted.
 *
 * The point of asking for a reason at the moment a proposal closes is this card. It is the difference
 * between "we lose a lot" and "we lose on lead time, and to the same two firms" — the first is a
 * feeling, the second is something a rate card or a hiring plan can answer.
 *
 * Bars rather than a chart library: with eight reasons and one dimension, a proportional bar says
 * everything a pie would and reads at a glance in a sidebar. Counts are always shown beside them,
 * because a bar without a number is a shape.
 */

const LABELS = {
  price: 'Too expensive',
  timing: 'Timing',
  budget: 'No budget',
  competitor: 'Competitor',
  'in-house': 'In-house',
  scope: 'Out of scope for us',
  'no-response': 'Went quiet',
  relationship: 'They know us',
  availability: 'Availability',
  specialism: 'Specialism',
  referral: 'Referral',
  incumbent: 'Did the last one',
  other: 'Something else',
  'not recorded': 'Not recorded',
};

function Bars({ rows, tone }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length) return <p className="text-xs text-fg-subtle">Nothing closed in this window.</p>;

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.reason} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2 text-xs">
            <span className={row.reason === 'not recorded' ? 'text-fg-subtle' : 'text-fg'}>
              {LABELS[row.reason] ?? row.reason}
            </span>
            <span className="font-mono text-fg-muted">{row.count}</span>
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-white/5">
            <span
              className={`block h-full rounded-full ${tone}`}
              style={{ width: `${total ? Math.max(4, Math.round((row.count / total) * 100)) : 0}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function WinLossCard() {
  const [months, setMonths] = useState('12');
  const { data, loading } = useResource(`/proposals/outcomes?months=${months}`, { initial: null });
  const [side, setSide] = useState('losses');

  const totals = data?.totals ?? {};
  const rows = side === 'losses' ? (data?.losses ?? []) : (data?.wins ?? []);

  return (
    <Card>
      <CardHeader
        icon={side === 'losses' ? TrendingDown : Trophy}
        title="Why we win and lose"
        description="From the reason recorded when a proposal closed."
        actions={
          <Tabs
            size="sm"
            value={months}
            onChange={setMonths}
            options={[
              { value: '3', label: '3m' },
              { value: '12', label: '12m' },
              { value: '36', label: '3y' },
            ]}
          />
        }
      />
      <CardBody className="flex flex-col gap-3">
        {loading && !data ? (
          <LoadingBlock label="Counting…" />
        ) : (totals.closed ?? 0) === 0 ? (
          <EmptyState
            icon={Trophy}
            title="Nothing has closed yet"
            description="Reasons are recorded when a proposal is marked won or lost. This fills in from there."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
              <span className="text-fg">
                <span className="font-mono text-base text-fg">{totals.winRate ?? '—'}%</span> won
              </span>
              <span className="text-fg-muted">
                {totals.won} of {totals.closed} decisions
              </span>
              {totals.medianDecisionDays !== null && totals.medianDecisionDays !== undefined ? (
                <span className="text-fg-muted">
                  {totals.medianDecisionDays} days to a decision, typically
                </span>
              ) : null}
            </div>

            <Tabs
              size="sm"
              value={side}
              onChange={setSide}
              options={[
                { value: 'losses', label: `Lost ${totals.lost ?? 0}` },
                { value: 'wins', label: `Won ${totals.won ?? 0}` },
              ]}
            />

            <Bars rows={rows} tone={side === 'losses' ? 'bg-crit/70' : 'bg-low/70'} />

            {side === 'losses' && (data?.competitors ?? []).length ? (
              <p className="text-xs text-fg-muted">
                Lost to:{' '}
                {data.competitors
                  .slice(0, 5)
                  .map((entry) => `${entry.name} (${entry.count})`)
                  .join(' · ')}
              </p>
            ) : null}

            {(data?.recent ?? []).length ? (
              <ul className="flex flex-col gap-1 border-t border-line-soft pt-2">
                {data.recent.slice(0, 5).map((entry) => (
                  <li key={entry.id} className="flex items-baseline gap-2 text-xs">
                    <span
                      className={
                        entry.status === 'declined' ? 'shrink-0 text-crit' : 'shrink-0 text-low'
                      }
                    >
                      {entry.status === 'declined' ? 'lost' : 'won'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg-muted">
                      {entry.company || entry.title}
                      {entry.reason ? ` — ${LABELS[entry.reason] ?? entry.reason}` : ''}
                      {entry.competitor ? ` (${entry.competitor})` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
