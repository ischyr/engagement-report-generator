import { CalendarRange, CheckCircle2, ClipboardList, Clock } from 'lucide-react';

import { formatDate } from '../../lib/utils.js';
import { Card, CardBody } from '../ui/Card.jsx';
import { EmptyState } from '../ui/Feedback.jsx';

/**
 * Everything the firm has done for one client, on a link they can open.
 *
 * The other two shares answer a question about one engagement. This answers the one a client asks
 * at renewal and nobody could answer without a meeting: *is it getting better, and what is still
 * open across all of it*. The team's own version of this view exists — the programme page — and
 * the client has never been able to see anything like it.
 *
 * It shows less than that page does, deliberately, and the omissions are the design:
 *
 * - **Work in progress has no numbers.** An engagement that has not been signed off is a name and
 *   a date. Counting findings on a report the client has not been given would tell them a result
 *   the team has not finished deciding — and on a red team, before they are meant to know it is
 *   running.
 * - **No finding text anywhere.** Counts by severity and nothing else. The detail lives behind a
 *   link made for one engagement and one reader.
 * - **No trend line and no score.** The bars are in date order and a reader draws their own
 *   conclusion. A number saying their security is 34 invites the question what 34 means, and there
 *   is no honest answer to it.
 */
export default function SharedPortfolio({ data }) {
  const { client, engagements, totals } = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-brand-300">{data.firm}</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">{client}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {totals.engagements === 0
            ? 'Nothing here yet.'
            : `${totals.engagements} engagement${totals.engagements === 1 ? '' : 's'}${
                totals.delivered ? `, ${totals.delivered} reported` : ''
              }.`}
        </p>
      </header>

      {totals.outstanding ? (
        <Card className="mb-5">
          <CardBody className="flex items-center gap-3">
            <ClipboardList size={18} className="shrink-0 text-fg-muted" />
            <p className="text-sm text-fg">
              <strong>{totals.outstanding}</strong> finding
              {totals.outstanding === 1 ? ' is' : 's are'} still waiting to be marked as fixed.
              <span className="block text-xs text-fg-muted">
                Use the link for that engagement to tell us what you have done.
              </span>
            </p>
          </CardBody>
        </Card>
      ) : null}

      {engagements.length === 0 ? (
        <Card>
          <CardBody className="py-10">
            <EmptyState
              icon={CalendarRange}
              title="Nothing to show yet"
              description="When work has been reported it will appear here."
            />
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {engagements.map((engagement) => (
            <Card key={engagement.id}>
              <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{engagement.name}</p>
                    <p className="text-xs text-fg-muted">
                      {[engagement.reference, engagement.type].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <p className="text-xs text-fg-subtle">
                    {engagement.from ? formatDate(engagement.from) : ''}
                    {engagement.to ? ` – ${formatDate(engagement.to)}` : ''}
                  </p>
                </div>

                {engagement.delivered ? (
                  <>
                    {/*
                      One pill per severity, sized by share. The same shape the report's own chart
                      uses, and for the same reason: five numbers in a table is not a thing anybody
                      reads first.
                    */}
                    <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
                      {engagement.bySeverity
                        .filter((band) => band.count > 0)
                        .map((band) => (
                          <span
                            key={band.severity}
                            title={`${band.count} ${band.severity}`}
                            style={{
                              backgroundColor: `#${band.color}`,
                              width: `${(band.count / Math.max(engagement.findings, 1)) * 100}%`,
                            }}
                          />
                        ))}
                    </div>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                      <span>
                        {engagement.findings} finding{engagement.findings === 1 ? '' : 's'}
                      </span>
                      {engagement.open === 0 ? (
                        <span className="flex items-center gap-1 text-low">
                          <CheckCircle2 size={12} />
                          all marked fixed
                        </span>
                      ) : (
                        <span>{engagement.open} still open</span>
                      )}
                      {engagement.bySeverity
                        .filter((band) => band.count > 0)
                        .map((band) => (
                          <span key={band.severity} className="flex items-center gap-1">
                            <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: `#${band.color}` }}
                            />
                            {band.count} {band.severity}
                          </span>
                        ))}
                    </p>
                  </>
                ) : (
                  /*
                    No numbers, and the sentence says why rather than leaving a gap that reads like
                    a page that failed to load.
                  */
                  <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
                    <Clock size={12} />
                    In progress — the findings appear here once the report has gone.
                  </p>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-8 text-center text-[0.6875rem] text-fg-subtle">
        This link is private to you and stops working on {formatDate(data.expiresAt)}. It is
        read-only — nothing here can be changed.
      </p>
    </div>
  );
}
