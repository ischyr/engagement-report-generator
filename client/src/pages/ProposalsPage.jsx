import { useState } from 'react';
import { ArrowLeft, ClipboardList, FileCheck2, Timer } from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import ProposalDetail, { STATUS_TONE } from '../components/proposals/ProposalDetail.jsx';

/**
 * Proposals, from the side that has to do the work.
 *
 * Two pages out of one component, because they are the same records read for two different
 * reasons and sharing the table is what keeps them consistent:
 *
 *   queue      what is waiting on us — an estimate, or a contract to check
 *   inquiries  what has been won and is not yet a job, with the days it will cost
 *
 * Neither is a copy of the sales pipeline. Sales sees everything including its own drafts;
 * this sees only what somebody here has to act on, which is the point of it being separate.
 */
/**
 * How often a page whose subject somebody else is changing checks back.
 *
 * A proposal is handed between two audiences, so the page a salesperson is looking at goes stale
 * the moment a manager signs a document off — and until this existed the only way to find out was
 * to leave the page and come back. Eight seconds is short enough to read as "it just updated" and
 * long enough that an open tab is not a load problem.
 */
const LIVE_MS = 8_000;

export default function ProposalsPage({ view = 'queue' }) {
  const [selected, setSelected] = useState(null);

  const path = view === 'queue' ? '/proposals/queue' : '/proposals?status=accepted,converted';
  const { data, error, loading, reload } = useResource(path, { initial: null, poll: LIVE_MS });

  const rows =
    view === 'queue'
      ? [...(data?.evaluating ?? []), ...(data?.reviewing ?? [])]
      : (data?.proposals ?? []);

  /*
   * Fetched rather than picked out of the list: the list is rows now, and the detail is the record.
   * See the note on the sales side of the same change.
   */
  const detail = useResource(selected ? `/proposals/${selected}` : null, {
    initial: null,
    poll: LIVE_MS,
  });
  const current = selected ? detail.data : null;

  if (current) {
    return (
      <div className="flex flex-col gap-6">
        <Button variant="ghost" icon={ArrowLeft} className="self-start" onClick={() => setSelected(null)}>
          Back
        </Button>
        <ProposalDetail
          proposal={current}
          onChange={() => {
            detail.reload({ quiet: true });
            reload({ quiet: true });
          }}
        />
      </div>
    );
  }

  if (view === 'inquiries') {
    const waiting = rows.filter((row) => row.status === 'accepted');
    const done = rows.filter((row) => row.status === 'converted');
    const days = waiting.reduce((total, row) => total + (row.effortDays ?? 0), 0);

    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Inquired engagements"
          description="Work that has been won and is not yet a job. The days here are what the schedule has to absorb."
        />

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardBody>
              <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Waiting to start</p>
              <p className="mt-1 text-2xl font-semibold text-fg">{waiting.length}</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Days sold</p>
              <p className="mt-1 text-2xl font-semibold text-fg">{days || '—'}</p>
              <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">across the ones not yet started</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Turned into engagements</p>
              <p className="mt-1 text-2xl font-semibold text-fg">{done.length}</p>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            icon={ClipboardList}
            title="Accepted"
            description="Open one to create the engagement, or to correct the effort before anybody is booked."
          />
          {loading ? (
            <SkeletonRows rows={3} columns={5} />
          ) : error ? (
            <ErrorState error={error} onRetry={reload} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="Nothing won yet"
              description="Accepted proposals appear here, with the effort agreed for them."
            />
          ) : (
            <Table>
              <THead>
                <TH>Work</TH>
                <TH>Client</TH>
                <TH align="right">Days</TH>
                <TH>Window</TH>
                <TH>State</TH>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row._id} className="cursor-pointer" onClick={() => setSelected(row._id)}>
                    <TD>
                      <p className="truncate text-sm font-medium text-fg">{row.title}</p>
                      <p className="font-mono text-[0.6875rem] text-fg-subtle">{row.reference}</p>
                    </TD>
                    <TD className="text-sm text-fg-muted">{row.company?.name}</TD>
                    <TD align="right" className="whitespace-nowrap text-sm text-fg">
                      {row.effortDays ?? '—'}
                      {row.effortDays !== null && !row.effortAgreed ? (
                        <span className="ml-1 text-[0.625rem] text-warn">unchecked</span>
                      ) : null}
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">
                      {[row.expectedStart, row.expectedEnd].filter(Boolean).join(' → ') || '—'}
                    </TD>
                    <TD>
                      {row.audit ? (
                        <Badge tone="success">{row.audit.name}</Badge>
                      ) : (
                        <Badge tone="warning">no engagement yet</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    );
  }

  const evaluating = data?.evaluating ?? [];
  const reviewing = data?.reviewing ?? [];

  const queueTable = (list, empty) =>
    list.length === 0 ? (
      <EmptyState icon={ClipboardList} title="Nothing waiting" description={empty} />
    ) : (
      <Table>
        <THead>
          <TH>Work</TH>
          <TH>Client</TH>
          <TH align="right">Sales says</TH>
          <TH>Type</TH>
          <TH align="right">Waiting</TH>
        </THead>
        <TBody>
          {list.map((row) => (
            <TR key={row._id} className="cursor-pointer" onClick={() => setSelected(row._id)}>
              <TD>
                <p className="truncate text-sm font-medium text-fg">{row.title}</p>
                <p className="font-mono text-[0.6875rem] text-fg-subtle">{row.reference}</p>
              </TD>
              <TD className="text-sm text-fg-muted">{row.company?.name}</TD>
              <TD align="right" className="whitespace-nowrap text-sm text-fg-muted">
                {row.estimate?.salesDays ?? '—'}
                {row.estimate?.salesDays !== null && row.estimate?.salesDays !== undefined ? 'd' : ''}
              </TD>
              <TD className="text-xs text-fg-muted">{row.auditType || '—'}</TD>
              <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                {timeAgo(row.updatedAt)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Proposal queue"
        description="What sales has asked of us: how long the work would take, and whether the paperwork is fit to send."
      />

      {loading ? (
        <Card>
          <SkeletonRows rows={3} columns={5} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              icon={Timer}
              title="Needs an estimate"
              description="Somebody has been asked how long this would take. Sales' own figure is shown, and it is not binding."
              actions={evaluating.length ? <Badge tone="warning">{evaluating.length}</Badge> : null}
            />
            {queueTable(evaluating, 'No proposal is waiting on an estimate.')}
          </Card>

          <Card>
            <CardHeader
              icon={FileCheck2}
              title="Paperwork to check"
              description="Generated documents waiting to be signed off before they leave the building."
              actions={reviewing.length ? <Badge tone="warning">{reviewing.length}</Badge> : null}
            />
            {queueTable(reviewing, 'Nothing to check.')}
          </Card>
        </>
      )}
    </div>
  );
}
