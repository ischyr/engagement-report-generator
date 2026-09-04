import { useState } from 'react';
import { PhoneCall, Copy } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useResource } from '../../hooks/useResource.js';
import { useToast } from '../../context/ToastContext.jsx';
import { timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Tabs } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * The ones worth ringing again.
 *
 * A proposal lost on timing or on budget was never a "no" — it was a "not now", and the not-now
 * expires. Six months later this is the warmest list a sales section has, and it was unobtainable
 * until the reason was being recorded: "everything we lost" is a graveyard, "everything we lost
 * because the money was in next year's budget" is a morning's phone calls.
 *
 * Clients who came back on their own are left out by the server. Cloning is the action rather than
 * "open it", because what somebody wants is not to read last year's proposal — it is to send this
 * year's, which is the same one with the dates moved.
 */

const REASONS = {
  timing: 'wrong time',
  budget: 'no budget then',
  'no-response': 'went quiet',
};

export default function ResurrectCard({ onCloned }) {
  const toast = useToast();
  const [months, setMonths] = useState('6');
  const [cloning, setCloning] = useState(null);
  const { data, loading, reload } = useResource(`/proposals/resurrect?months=${months}`, {
    initial: null,
  });

  const rows = data?.proposals ?? [];

  const clone = async (row) => {
    setCloning(row.id);
    try {
      const created = await api.post(`/proposals/${row.id}/clone`, {});
      toast.success(`Raised as ${created.reference}`, 'Same scope, dates a year on, no estimate yet.');
      reload({ quiet: true });
      onCloned?.(created);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setCloning(null);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={PhoneCall}
        title="Worth another call"
        description="Lost on timing, budget or silence — long enough ago that the answer may have changed."
        actions={
          <Tabs
            size="sm"
            value={months}
            onChange={setMonths}
            options={[
              { value: '6', label: '6m+' },
              { value: '12', label: '1y+' },
              { value: '24', label: '2y+' },
            ]}
          />
        }
      />
      <CardBody className="flex flex-col">
        {loading && !data ? (
          <LoadingBlock label="Looking back…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={PhoneCall}
            title="Nothing to chase"
            description="Nobody was lost on timing or budget that long ago — or everybody who was is already back in the pipeline."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{row.company || row.title}</p>
                  <p className="truncate text-xs text-fg-muted">
                    {row.title} · {REASONS[row.reason] ?? row.reason} · {timeAgo(row.lostAt)}
                  </p>
                  {/* The name and address, because the point of the card is a phone call. */}
                  {row.contact ? (
                    <p className="truncate text-[0.6875rem] text-fg-subtle">
                      {row.contact.name}
                      {row.contact.email ? ` · ${row.contact.email}` : ''}
                      {row.owner ? ` · was ${row.owner}'s` : ''}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Copy}
                  loading={cloning === row.id}
                  onClick={() => clone(row)}
                  title="Raise this year's from last year's"
                >
                  Raise it again
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
