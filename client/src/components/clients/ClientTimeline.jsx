import { Link } from 'react-router-dom';
import {
  ArrowRightLeft,
  Banknote,
  FileSignature,
  Send,
  ScrollText,
  Trophy,
  TrendingDown,
  UserPlus,
} from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { formatDateTime, timeAgo } from '../../lib/utils.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * The whole relationship with one client, in order.
 *
 * What somebody wants before a call is the history: when we last spoke, what we quoted, what we lost
 * and why, which report they have and which version. That story is spread over four pages, and
 * reassembling it in the thirty seconds before dialling is how people end up asking a client something
 * the client already told them.
 *
 * Nothing here is a new record. The server builds it from the proposals and their status history, the
 * engagements, the deliveries that say what actually went out, the contacts as they were added, and the
 * sales log for the rest — so it cannot fall out of step with the pages it summarises, which a
 * purpose-built timeline table would do within a month.
 */

const KINDS = {
  proposal: { icon: FileSignature, tone: 'text-brand-300', ring: 'ring-brand-500/30' },
  won: { icon: Trophy, tone: 'text-low', ring: 'ring-low/30' },
  lost: { icon: TrendingDown, tone: 'text-crit', ring: 'ring-crit/30' },
  engagement: { icon: ScrollText, tone: 'text-fg', ring: 'ring-line' },
  delivery: { icon: Send, tone: 'text-info', ring: 'ring-info/30' },
  contact: { icon: UserPlus, tone: 'text-fg-muted', ring: 'ring-line' },
  note: { icon: ArrowRightLeft, tone: 'text-fg-subtle', ring: 'ring-line' },
};

export default function ClientTimeline({ companyId }) {
  const { data, error, loading, reload } = useResource(`/data/companies/${companyId}/timeline`, {
    initial: null,
  });

  const events = data?.events ?? [];
  const counts = data?.counts ?? {};

  return (
    <Card>
      <CardHeader
        icon={Banknote}
        title="The relationship, in order"
        description={
          events.length
            ? [
                [counts.proposals ?? 0, 'proposal'],
                [counts.engagements ?? 0, 'engagement'],
                [counts.deliveries ?? 0, 'report sent'],
              ]
                // "1 engagements" is the sort of thing that makes a page look unfinished.
                .map(([count, word]) => `${count} ${word}${count === 1 ? '' : 's'}`)
                .join(' · ')
            : 'Proposals, engagements, reports sent and contacts added — newest first.'
        }
      />
      {loading && !data ? (
        <LoadingBlock label="Reading the history…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={Banknote}
          title="Nothing recorded yet"
          description="Raise a proposal or start an engagement for this client and it will read back from here."
        />
      ) : (
        <CardBody>
          {/* One rail down the left, so the eye follows time rather than the boxes. */}
          <ol className="relative flex flex-col gap-3 border-l border-line-soft pl-4">
            {events.map((event, index) => {
              const kind = KINDS[event.kind] ?? KINDS.note;
              const Icon = kind.icon;
              return (
                <li key={`${event.at}-${index}`} className="relative">
                  <span
                    className={`absolute -left-[1.4rem] top-0.5 grid size-5 place-items-center rounded-full bg-surface ring-1 ${kind.ring}`}
                  >
                    <Icon size={11} className={kind.tone} />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      {event.link ? (
                        <Link to={event.link} className="text-fg transition hover:text-brand-300">
                          {event.title}
                        </Link>
                      ) : (
                        <span className="text-fg">{event.title}</span>
                      )}
                      <span
                        className="text-[0.6875rem] text-fg-subtle"
                        title={formatDateTime(event.at)}
                      >
                        {timeAgo(event.at)}
                      </span>
                    </p>
                    {event.detail || event.actor ? (
                      <p className="text-xs text-fg-muted">
                        {event.detail}
                        {event.detail && event.actor ? ' · ' : ''}
                        {event.actor}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </CardBody>
      )}
    </Card>
  );
}
