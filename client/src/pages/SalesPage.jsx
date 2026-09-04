import { Link } from 'react-router-dom';
import { Banknote, Building2, Clock, Lock, ScrollText } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useResource } from '../hooks/useResource.js';
import WinLossCard from '../components/proposals/WinLossCard.jsx';
import TargetCard from '../components/proposals/TargetCard.jsx';
import ResurrectCard from '../components/proposals/ResurrectCard.jsx';
import SourcesCard from '../components/proposals/SourcesCard.jsx';
import { timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { STATUS_TONE } from '../components/proposals/ProposalDetail.jsx';

/**
 * How often a page whose subject somebody else is changing checks back.
 *
 * A proposal is handed between two audiences, so the page a salesperson is looking at goes stale
 * the moment a manager signs a document off — and until this existed the only way to find out was
 * to leave the page and come back. Eight seconds is short enough to read as "it just updated" and
 * long enough that an open tab is not a load problem.
 */
const LIVE_MS = 8_000;

const STAGES = [
  { key: 'draft', label: 'Drafts' },
  { key: 'evaluating', label: 'Being evaluated' },
  { key: 'evaluated', label: 'Effort agreed' },
  { key: 'documents-review', label: 'Documents in review' },
  { key: 'sent', label: 'Sent' },
];

function Stat({ label, value, hint, tone }) {
  return (
    <Card>
      <CardBody>
        <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">{label}</p>
        <p className={`mt-1 text-2xl font-semibold ${tone ?? 'text-fg'}`}>{value}</p>
        {hint ? <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}

function ProposalRow({ row }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{row.title}</p>
        <p className="truncate text-xs text-fg-muted">
          {row.company} · <span className="font-mono">{row.reference}</span>
        </p>
      </div>
      {row.days === null ? null : (
        <span className="whitespace-nowrap text-xs text-fg-muted">
          {row.days}d{!row.effortAgreed ? <span className="ml-1 text-warn">unchecked</span> : null}
        </span>
      )}
      <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>
      <span className="whitespace-nowrap text-[0.6875rem] text-fg-subtle">{timeAgo(row.updatedAt)}</span>
    </div>
  );
}

/** An amount, grouped, currency after it. The cents are not grouped — see the split. */
const amountText = (amount, currency) => {
  if (amount === null || amount === undefined) return '—';
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`;
};

/**
 * The Sales dashboard.
 *
 * What is at each stage, which of them are yours, which are sitting with somebody else — that last
 * one being the usual answer to "why has this not gone out yet" — and, since there is a rate card,
 * what the live pipeline is worth.
 *
 * Every money figure on this page is null rather than zero when no rate card has been filled in. A
 * pipeline worth 0.00 reads as a disaster; "no rate card" reads as the question it is.
 */
export default function SalesPage() {
  const { isAdmin } = useAuth();
  const { data, error, loading, reload } = useResource('/sales/dashboard', {
    initial: null,
    poll: LIVE_MS,
  });

  const summary = data?.summary ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sales"
        description="The commercial side of the work: what has been asked for, what has been quoted, and what has been won."
        actions={
          <>
            <Button as={Link} to="/sales/clients" variant="ghost" icon={Building2}>
              Clients
            </Button>
            <Button as={Link} to="/sales/proposals" variant="primary" icon={ScrollText}>
              Proposals
            </Button>
          </>
        }
      />

      {isAdmin ? (
        <div className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface/60 px-3.5 py-3">
          <Lock size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
          <p className="text-xs leading-relaxed text-fg-muted">
            You are seeing this because you are an administrator. Accounts with the{' '}
            <span className="font-medium text-fg">Sales</span> role see this section and nothing
            else — no engagements, no findings, no clients' reports.
          </p>
        </div>
      ) : null}

      {data && !data.firmReady ? (
        <Alert tone="warning" title="Your own company details are not filled in">
          Every NDA and permission to attack names your firm as the first party. Until an
          administrator fills that in under Settings → Your firm, generated paperwork will have a
          blank where your company name should be.
        </Alert>
      ) : null}

      {loading ? (
        <Card>
          <SkeletonRows rows={3} columns={4} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Live proposals" value={summary?.open ?? 0} hint="not yet won or lost" />
            <Stat
              label="Won"
              value={(summary?.accepted ?? 0) + (summary?.converted ?? 0)}
              hint={`${summary?.accepted ?? 0} not yet started`}
              tone="text-ok"
            />
            {data?.pipelineValue === null || data?.pipelineValue === undefined ? (
              <Stat
                label="Days sold, waiting"
                value={summary?.daysInquired || '—'}
                hint="accepted and not yet a job"
              />
            ) : (
              <Stat
                label="Live pipeline"
                value={amountText(data.pipelineValue, data.currency)}
                hint={
                  data.unpriced
                    ? `${data.unpriced} of them have no figure yet`
                    : `${summary?.daysInquired || 0} days sold and waiting`
                }
              />
            )}
            <Stat label="Lost" value={summary?.declined ?? 0} tone="text-fg-muted" />
          </div>

          <Card>
            <CardHeader icon={Banknote} title="The pipeline" description="Where everything currently sits." />
            <CardBody className="flex flex-wrap gap-2">
              {STAGES.map((stage) => (
                <div
                  key={stage.key}
                  className="min-w-32 flex-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
                >
                  <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">
                    {stage.label}
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-fg">
                    {summary?.byStatus?.[stage.key] ?? 0}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* Above the pattern cards: what somebody is being measured on comes before why. */}
          <TargetCard />

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Beside the live pipeline, because one is this week and the other is the pattern. */}
            <WinLossCard />

            {/*
              Next to the reasons, on purpose. One card says we lose on timing; this one is the list
              of the people we lost that way, with the button that does something about it.
            */}
            <ResurrectCard onCloned={() => reload({ quiet: true })} />

            {/* Why we win, beside how they found us: the two halves of the same question. */}
            <SourcesCard />

            <Card>
              <CardHeader
                icon={ScrollText}
                title="Yours, still live"
                description="Open one to move it on."
                actions={
                  <Button as={Link} to="/sales/proposals" size="sm" variant="ghost">
                    All of them
                  </Button>
                }
              />
              <CardBody className="divide-y divide-line-soft">
                {(data?.mine ?? []).length === 0 ? (
                  <EmptyState
                    icon={ScrollText}
                    title="Nothing live"
                    description="Raise a proposal when a client asks for something."
                  />
                ) : (
                  data.mine.map((row) => <ProposalRow key={row.id} row={row} />)
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={Clock}
                title="Waiting on somebody else"
                description="With the delivery side for an estimate, or for the paperwork to be checked. Usually the answer to why something has not gone out."
              />
              <CardBody className="divide-y divide-line-soft">
                {(data?.waitingOnOthers ?? []).length === 0 ? (
                  <EmptyState
                    icon={Clock}
                    title="Nothing pending"
                    description="Nothing is sitting with anybody else."
                  />
                ) : (
                  data.waitingOnOthers.map((row) => <ProposalRow key={row.id} row={row} />)
                )}
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
