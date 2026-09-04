import { useEffect, useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';

import { api } from '../../lib/api.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { ErrorState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * The finding as the report will print it.
 *
 * Not a second renderer: the draft is posted to the server, substituted into the engagement in
 * memory, and put through the same `buildReportData` a real generation uses. So the figure numbers
 * are the ones the document will carry, the severity words are this client's own if they renamed
 * them, and a table that will come out without a header row comes out without one here.
 *
 * What it deliberately does not imitate is the template's page furniture — fonts, margins, the
 * house heading styles. That lives in the customer's .docx and pretending to know it would be a
 * worse lie than not showing it: the questions this answers are "is my markup right" and "does this
 * read", both of which survive being shown in the app's own type.
 */

/** The order and the names the shipped templates use. */
const BLOCKS = [
  ['description', 'Description'],
  ['scope', 'Affected assets'],
  ['poc', 'Proof of concept'],
  ['observation', 'Impact'],
  ['remediation', 'Remediation'],
];

export default function FindingPreview({ auditId, findingId, draft }) {
  const [state, setState] = useState({ loading: true, error: null, finding: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));

    /*
     * The draft is sent whole rather than diffed against what is stored. A preview that shows a
     * mixture of saved and unsaved text would be the one thing worse than no preview.
     */
    api
      .post(`/audits/${auditId}/findings/${findingId || 'new'}/preview`, draft)
      .then((data) => {
        if (!cancelled) setState({ loading: false, error: null, finding: data.finding });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error, finding: null });
      });

    return () => {
      cancelled = true;
    };
    // `draft` is deliberately not a dependency: re-rendering on every keystroke would be a request
    // per keystroke. The refresh button, and reopening the preview, are when it re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId, findingId, nonce]);

  const { loading, error, finding } = state;

  return (
    <Card>
      <CardHeader
        title="As it will render"
        icon={Eye}
        description="Your draft through the report pipeline — figure numbers, severity words and markup exactly as the document will have them."
        actions={
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-fg-muted transition hover:bg-white/5 hover:text-fg"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
      />
      <CardBody>
        {loading ? (
          <LoadingBlock label="Rendering…" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />
        ) : (
          <article className="flex flex-col gap-4">
            <header className="flex flex-col gap-2">
              <h3 className="text-base font-semibold text-fg">
                {finding.positionId ? `${finding.positionId} ` : ''}
                {finding.title || 'Untitled finding'}
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {finding.severityLabel ? (
                  <span
                    className="rounded-full px-2.5 py-1 font-medium ring-1"
                    style={{
                      color: `#${finding.severityColor || '9aa4b2'}`,
                      borderColor: `#${finding.severityColor || '9aa4b2'}`,
                      boxShadow: `inset 0 0 0 1px #${finding.severityColor || '9aa4b2'}33`,
                    }}
                  >
                    {finding.severityLabel}
                  </span>
                ) : null}
                {finding.cvssScore !== '' && finding.cvssScore !== null ? (
                  <Badge tone="neutral">Score {finding.cvssScore}</Badge>
                ) : null}
                {finding.category ? <Badge tone="neutral">{finding.category}</Badge> : null}
                {finding.priorityLabel ? <Badge tone="neutral">{finding.priorityLabel}</Badge> : null}
                {finding.remediationStatusLabel ? (
                  <Badge tone="neutral">{finding.remediationStatusLabel}</Badge>
                ) : null}
              </div>
              {finding.cvssVector ? (
                <p className="break-all font-mono text-[0.6875rem] text-fg-subtle">
                  {finding.cvssVector}
                </p>
              ) : null}
              {finding.previously ? (
                <p className="text-xs text-med">{finding.previously}</p>
              ) : null}
            </header>

            {BLOCKS.map(([key, label]) =>
              finding.rich?.[key] ? (
                <section key={key} className="flex flex-col gap-1.5">
                  <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    {label}
                  </h4>
                  {/*
                    * The server sanitised this on the way out — the same sanitiser the HTML report
                    * uses — so what is injected here is what a rendered report would contain.
                    */}
                  <div
                    className="engy-prose max-w-none"
                    dangerouslySetInnerHTML={{ __html: finding.rich[key] }}
                  />
                </section>
              ) : (
                <section key={key} className="flex flex-col gap-1.5">
                  <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                    {label}
                  </h4>
                  <p className="text-xs italic text-fg-subtle">
                    Empty — this section will not appear.
                  </p>
                </section>
              )
            )}

            {finding.references?.length ? (
              <section className="flex flex-col gap-1.5">
                <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  References
                </h4>
                <ul className="flex flex-col gap-0.5 text-xs text-brand-300">
                  {finding.references.map((reference) => (
                    <li key={reference} className="break-all">
                      {reference}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        )}
      </CardBody>
    </Card>
  );
}
