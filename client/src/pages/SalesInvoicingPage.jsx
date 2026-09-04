import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Receipt, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { downloadBlob, formatDate } from '../lib/utils.js';

import { Card, CardBody } from '../components/ui/Card.jsx';
import { PageHeader, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';

/**
 * The handoff to whoever raises the invoices.
 *
 * Until now this was a conversation: somebody in finance asks what was sold this month and somebody
 * in sales goes through the pipeline by hand. Everything on this page was already on the record —
 * what was won, at what price, whether a report has actually gone out, and whether the client will
 * refuse an invoice without a purchase order.
 *
 * "Delivered" is read from the deliveries rather than from the engagement's status, because that is
 * the moment most firms are willing to bill: a job can be marked finished internally while the
 * client still has nothing in their hands.
 *
 * The CSV is deliberate rather than an integration. This app cannot know which accounts package you
 * use, and a column of numbers somebody can paste is worth more than a connector nobody can
 * configure.
 */

const VIEWS = [
  { value: 'outstanding', label: 'Not invoiced' },
  { value: 'invoiced', label: 'Invoiced' },
  { value: 'all', label: 'Everything' },
];

const amountText = (amount, currency) => {
  if (amount === null || amount === undefined) return '—';
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`;
};

export default function SalesInvoicingPage() {
  const toast = useToast();
  const [view, setView] = useState('outstanding');
  const [marking, setMarking] = useState(null);
  const [invoiceRef, setInvoiceRef] = useState('');
  const [po, setPo] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const { data, error, loading, reload } = useResource(`/proposals/invoicing?state=${view}`, {
    initial: null,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals ?? {};

  const csv = async () => {
    setDownloading(true);
    try {
      /*
       * Fetched with the access token and handed over as a blob, like every other download here: a
       * plain link would need either a cookie this route does not accept or an unauthenticated URL.
       */
      const response = await api.raw(`/proposals/invoicing?state=${view}&format=csv`);
      downloadBlob(await response.blob(), `invoicing-${view}.csv`);
    } catch (problem) {
      toast.fromError(problem);
    } finally {
      setDownloading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/proposals/${marking.id}/billing`, {
        poNumber: po.trim(),
        invoiceRef: invoiceRef.trim(),
        /* Marking it invoiced is the point of the dialog, so the date is now. */
        invoicedAt: new Date().toISOString(),
      });
      toast.success(`${marking.reference} marked invoiced`);
      setMarking(null);
      reload({ quiet: true });
    } catch (problem) {
      toast.fromError(problem);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoicing"
        description="Won work, what it was worth, and whether it has been billed. The list finance asks for."
        actions={
          <>
            <Tabs value={view} onChange={setView} options={VIEWS} />
            <Button variant="secondary" icon={Download} loading={downloading} onClick={csv}>
              CSV
            </Button>
          </>
        }
      />

      {loading && !data ? (
        <Card>
          <SkeletonRows rows={4} columns={5} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={reload} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Receipt}
            title={view === 'invoiced' ? 'Nothing invoiced yet' : 'Nothing waiting to be billed'}
            description="Proposals appear here once a client has accepted them."
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl border border-line-soft bg-surface/60 px-4 py-3 text-sm">
            <span className="text-fg">
              <span className="font-mono text-lg">{totals.rows}</span> proposal
              {totals.rows === 1 ? '' : 's'}
            </span>
            {/* Null rather than zero when nothing is priced: 0.00 reads as "we sold nothing". */}
            <span className="text-fg-muted">
              {totals.net === null
                ? 'no rate card, so no figures'
                : `${amountText(totals.net, totals.currency)} net`}
            </span>
            <span className="text-fg-muted">{totals.delivered} delivered</span>
            {totals.blocked ? (
              <span className="inline-flex items-center gap-1.5 text-warn">
                <TriangleAlert size={14} />
                {totals.blocked} cannot be invoiced yet
              </span>
            ) : null}
          </div>

          <Card>
            <Table>
              <THead>
                <TH>Reference</TH>
                <TH>Client</TH>
                <TH>Won</TH>
                <TH>Delivered</TH>
                <TH align="right">Days</TH>
                <TH align="right">Net</TH>
                <TH>PO</TH>
                <TH>Invoiced</TH>
                <TH />
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <Link
                        to={`/sales/proposals?open=${row.id}`}
                        className="font-mono text-xs text-fg transition hover:text-brand-300"
                      >
                        {row.reference}
                      </Link>
                      <p className="max-w-56 truncate text-[0.6875rem] text-fg-subtle">
                        {row.title}
                      </p>
                    </TD>
                    <TD className="text-sm">{row.company}</TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">
                      {row.wonAt ? formatDate(row.wonAt) : '—'}
                    </TD>
                    <TD className="whitespace-nowrap text-xs">
                      {row.deliveredAt ? (
                        <span className="text-fg-muted">{formatDate(row.deliveredAt)}</span>
                      ) : (
                        <span className="text-fg-subtle">not yet</span>
                      )}
                    </TD>
                    <TD className="text-right font-mono text-xs tabular-nums">
                      {row.days ?? '—'}
                    </TD>
                    <TD className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                      {amountText(row.net, row.currency)}
                    </TD>
                    <TD className="text-xs">
                      {row.poNumber ? (
                        <span className="font-mono text-fg-muted">{row.poNumber}</span>
                      ) : row.poRequired ? (
                        <Badge tone="warning">needed</Badge>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {row.invoicedAt ? (
                        <span className="text-low">
                          {formatDate(row.invoicedAt)}
                          {row.invoiceRef ? ` · ${row.invoiceRef}` : ''}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">no</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {row.invoicedAt ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setMarking(row);
                            setPo(row.poNumber ?? '');
                            setInvoiceRef('');
                          }}
                        >
                          Mark invoiced
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      )}

      <Modal
        open={Boolean(marking)}
        onClose={() => setMarking(null)}
        title={`Mark ${marking?.reference ?? ''} invoiced`}
        description="Recorded on the proposal, because what gets invoiced is what was sold."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMarking(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Mark it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {marking?.blocked ? (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {marking.company} will refuse an invoice without a purchase order. Fill it in below and
              it goes on the record.
            </p>
          ) : null}
          <Input
            label="Their purchase order"
            placeholder="4500123456"
            value={po}
            onChange={(event) => setPo(event.target.value)}
          />
          <Input
            label="Our invoice reference"
            autoFocus
            placeholder="INV-2026-0142"
            value={invoiceRef}
            onChange={(event) => setInvoiceRef(event.target.value)}
          />
          {marking?.invoiceEmail ? (
            <p className="text-[0.6875rem] text-fg-subtle">
              Their invoices go to <span className="text-fg-muted">{marking.invoiceEmail}</span>
              {marking.paymentTermsDays ? ` · ${marking.paymentTermsDays} days to pay` : ''}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
