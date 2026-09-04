import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2,
  FileSignature,
  FileText,
  History,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { formatDateTime, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Tabs, Avatar } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';

const AREAS = [
  { value: '', label: 'Everything' },
  { value: 'proposals', label: 'Proposals' },
  { value: 'effort', label: 'Effort' },
  { value: 'documents', label: 'Documents' },
  { value: 'clients', label: 'Clients' },
];

const AREA_ICON = {
  proposals: FileSignature,
  effort: Timer,
  documents: FileText,
  clients: Building2,
  other: History,
};

/** Deletions are the entries somebody comes here looking for, so they are marked. */
const isDeletion = (action) => action.endsWith('.deleted') || action.endsWith('.removed');

/** How many rows a tab starts with. Ten is a screenful; the rest is on request. */
const PAGE = 10;

/**
 * The Sales log — administrators only.
 *
 * The engagement activity tab and this page answer different questions, which is why one is for
 * everybody on the job and this one is not. That one says "who changed this finding", asked by
 * somebody looking at the finding. This says whose estimates get revised and by how much, who
 * moved which deal, and what was deleted last Tuesday — a managerial view, and not something
 * colleagues should be reading about each other.
 *
 * A flat list rather than one row per record: the proposal page already carries its own status
 * trail. What this adds is the cross-cutting read, which is the only way to notice a pattern.
 */
export default function SalesActivityPage() {
  const [area, setArea] = useState('');
  const [limit, setLimit] = useState(PAGE);

  /*
   * The limit belongs to the tab, not to the page.
   *
   * Switching tabs starts again at ten: somebody who expanded the proposal log to sixty rows and
   * then clicked Clients was asking a new question, and answering it with sixty rows of a
   * different thing is not what they asked for.
   */
  const show = (next) => {
    setArea(next);
    setLimit(PAGE);
  };

  const query = `/sales/activity?limit=${limit}${area ? `&area=${area}` : ''}`;
  const { data, error, loading, reload } = useResource(query, { initial: null });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sales activity"
        description="Every change made in the Sales section, newest first. Visible to administrators only."
      />

      <Tabs options={AREAS} value={area} onChange={show} />

      <Card>
        <CardHeader
          icon={History}
          title={area ? AREAS.find((a) => a.value === area).label : 'Everything'}
          description={
            total
              ? entries.length < total
                ? // Both numbers, so "showing the most recent" is not left as a guess at how many.
                  `Showing the ${entries.length} most recent of ${total}.`
                : `${total} entr${total === 1 ? 'y' : 'ies'}, all shown.`
              : undefined
          }
        />
        {loading ? (
          <SkeletonRows rows={6} columns={3} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="Nothing recorded"
            description="Changes to clients, contacts and proposals appear here as they happen."
          />
        ) : (
          <CardBody className="flex flex-col divide-y divide-line-soft">
            {entries.map((entry) => {
              const Icon = AREA_ICON[entry.area] ?? History;
              return (
                <div key={entry.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${
                      isDeletion(entry.action)
                        ? 'bg-crit/12 text-crit'
                        : 'bg-white/5 text-fg-subtle'
                    }`}
                  >
                    {isDeletion(entry.action) ? <Trash2 size={14} /> : <Icon size={14} />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-fg">{entry.summary}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-fg-subtle">
                      <span title={formatDateTime(entry.at)}>{timeAgo(entry.at)}</span>
                      {entry.company ? <span>· {entry.company}</span> : null}
                      {/*
                        Which hat they were wearing. An admin acting in the Sales section is worth
                        telling apart from a salesperson, and the role can change afterwards.
                      */}
                      {entry.actorRole ? (
                        <Badge tone={entry.actorRole === 'admin' ? 'brand' : 'neutral'}>
                          {entry.actorRole}
                        </Badge>
                      ) : null}
                      {/* Only when the record still exists — half of what is logged here is
                          deletions, and a dead link would be worse than plain text. */}
                      {entry.proposal ? (
                        <Link
                          to={`/sales/proposals?open=${entry.proposal.id}`}
                          className="font-mono text-brand-300 hover:underline"
                        >
                          {entry.proposal.reference}
                        </Link>
                      ) : entry.proposalRef ? (
                        <span className="font-mono">{entry.proposalRef} (deleted)</span>
                      ) : null}
                    </p>

                    {/* The numbers behind an effort change, which is the entry most worth
                        reading twice. */}
                    {entry.action === 'estimate.set' && entry.meta ? (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem]">
                        {entry.meta.salesDays !== null && entry.meta.salesDays !== undefined ? (
                          <span className="text-fg-subtle">sales quoted {entry.meta.salesDays}d</span>
                        ) : null}
                        {entry.meta.previous !== null && entry.meta.previous !== undefined ? (
                          <span className="text-fg-subtle">was {entry.meta.previous}d</span>
                        ) : null}
                        <Badge tone="info">now {entry.meta.days ?? '—'}d</Badge>
                      </p>
                    ) : null}
                  </div>

                  {entry.actor ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Avatar user={{ username: entry.actor.username, firstname: entry.actor.fullname }} size={22} />
                      <span className="hidden text-xs text-fg-muted sm:inline">
                        {entry.actor.fullname}
                      </span>
                    </div>
                  ) : (
                    <UserRound size={14} className="shrink-0 text-fg-subtle" />
                  )}
                </div>
              );
            })}
          </CardBody>
        )}
      </Card>

      {entries.length < total ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
            Show {Math.min(PAGE, total - entries.length)} more
          </Button>
          {/* One press to the end, for somebody going back through a whole afternoon rather
              than a screenful at a time. */}
          {total - entries.length > PAGE ? (
            <Button variant="ghost" onClick={() => setLimit(total)}>
              Show all {total}
            </Button>
          ) : null}
          <span className="text-xs text-fg-subtle">{total - entries.length} older</span>
        </div>
      ) : null}
    </div>
  );
}
