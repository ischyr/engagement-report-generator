import { useState } from 'react';
import { Compass } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Tabs } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Where the work comes from, and which channel is worth the money.
 *
 * The win/loss card beside this says *why* we win; this says *how they found us*, and the two answer
 * different questions. A 70% win rate on referrals against 8% on cold approaches is the difference
 * between a marketing budget and a guess — and unlike almost everything else on these pages it
 * cannot be reconstructed after the fact, because six months on nobody remembers who introduced
 * whom. Which is the whole argument for the one extra field on the form.
 *
 * "Not recorded" is shown rather than hidden. A tally with a quarter of its rows missing and no sign
 * of it is worse than one that admits the gap.
 */

const LABELS = {
  referral: 'Referral',
  'existing-client': 'Existing client',
  inbound: 'Came to us',
  outbound: 'We approached',
  partner: 'Partner',
  event: 'Event or talk',
  tender: 'Tender',
  other: 'Something else',
  'not recorded': 'Not recorded',
};

const amountText = (amount, currency) => {
  if (amount === null || amount === undefined) return '';
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`;
};

export default function SourcesCard() {
  const [months, setMonths] = useState('12');
  const { data, loading } = useResource(`/proposals/sources?months=${months}`, { initial: null });

  const rows = data?.rows ?? [];
  const most = Math.max(1, ...rows.map((row) => row.proposals));

  return (
    <Card>
      <CardHeader
        icon={Compass}
        title="Where the work comes from"
        description="Recorded when a proposal is raised. The win rate is of the decisions, so open ones are not counted against it."
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
      <CardBody className="flex flex-col gap-2">
        {loading && !data ? (
          <LoadingBlock label="Counting…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Compass}
            title="Nothing raised in this window"
            description="Every proposal can say which channel it arrived through. This fills in from there."
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {rows.map((row) => (
              <li key={row.source} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2 text-xs">
                  <span className={row.source === 'not recorded' ? 'text-fg-subtle' : 'text-fg'}>
                    {LABELS[row.source] ?? row.source}
                  </span>
                  <span className="flex items-baseline gap-2 font-mono text-fg-muted">
                    {row.winRate === null ? (
                      <span className="text-fg-subtle">no decisions</span>
                    ) : (
                      <span className={row.winRate >= 50 ? 'text-low' : 'text-fg-muted'}>
                        {row.winRate}% won
                      </span>
                    )}
                    <span>{row.proposals}</span>
                  </span>
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-white/5">
                  <span
                    className="block h-full rounded-full bg-brand-500/60"
                    style={{ width: `${Math.max(3, Math.round((row.proposals / most) * 100))}%` }}
                  />
                </span>
                {/* Only where there is a rate card. Nothing here invents a figure. */}
                {row.wonValue ? (
                  <span className="text-[0.6875rem] text-fg-subtle">
                    {amountText(row.wonValue, data.currency)} won · {row.won} of{' '}
                    {row.won + row.lost} decisions
                    {row.open ? `, ${row.open} still live` : ''}
                  </span>
                ) : (
                  <span className="text-[0.6875rem] text-fg-subtle">
                    {row.won} won · {row.lost} lost
                    {row.open ? ` · ${row.open} still live` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
