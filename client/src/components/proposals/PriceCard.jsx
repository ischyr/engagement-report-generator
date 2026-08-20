import { useState } from 'react';
import { BadgeCheck, Banknote, CircleSlash, Receipt } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Alert } from '../ui/Alert.jsx';
import { Input, Textarea } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';

/**
 * What we are charging, and whether anybody had to agree to it.
 *
 * The figures are computed by the server (`pricing.service.js`) and never by this component: a
 * price worked out twice is a price that will eventually be printed two ways, and one of the two
 * would be the one on the contract. So this renders `proposal.price` and does no arithmetic beyond
 * choosing what to show.
 *
 * The gate is the interesting part. A discount past the cap, or a rate under the floor, blocks the
 * offer from going out until a manager says otherwise — and the approval is recorded against the
 * *figures* it was given for, so raising the discount afterwards costs the signature rather than
 * quietly keeping it.
 */

/** A number and its label, right-aligned so the column of money reads as a column. */
function Line({ label, value, tone = 'text-fg-muted', strong = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-fg-subtle">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${strong ? 'text-fg' : tone}`}>{value}</span>
    </div>
  );
}

/**
 * An amount, grouped and with the currency after it.
 *
 * Split on the decimal point before grouping, rather than grouping the whole string: a single
 * thousands regex over "7200.00" groups the cents as well and prints "7 200.0 0".
 */
const amountText = (amount, currency) => {
  if (amount === null || amount === undefined) return '—';
  const [whole, cents] = Number(amount).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents} ${currency}`;
};

export default function PriceCard({ proposal, onSave }) {
  const toast = useToast();
  const price = proposal.price ?? {};
  const can = proposal.can ?? {};
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState('');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [poOpen, setPoOpen] = useState(false);
  const [po, setPo] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');

  /* Frozen at the same moment everything else is: the client is holding the figure. */
  const locked = ['sent', 'accepted', 'converted'].includes(proposal.status);

  const open = () => {
    setRate(proposal.pricing?.dayRate ?? '');
    setDiscount(proposal.pricing?.discountPercent || '');
    setNote(proposal.pricing?.note ?? '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/proposals/${proposal._id}/pricing`, {
        dayRate: String(rate).trim() === '' ? null : Number(rate),
        discountPercent: Number(discount || 0),
        note: note.trim(),
      });
      toast.success('Price saved');
      setEditing(false);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const review = async (approved) => {
    setSaving(true);
    try {
      const updated = await api.post(`/proposals/${proposal._id}/pricing/review`, {
        approved,
        note: reviewNote.trim(),
      });
      toast.success(approved ? 'Price approved' : 'Price sent back');
      setReviewing(null);
      setReviewNote('');
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const saveBilling = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/proposals/${proposal._id}/billing`, {
        poNumber: po.trim(),
        invoiceRef: invoiceRef.trim(),
      });
      toast.success('Saved');
      setPoOpen(false);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Banknote}
        title="The price"
        description={
          price.priced
            ? `${price.days} days at ${amountText(price.dayRate, price.currency)} — from ${
                price.rateFrom === 'proposal'
                  ? 'this proposal'
                  : price.rateFrom === 'client'
                    ? 'the client’s own rate'
                    : 'the rate card'
              }.`
            : 'No figure yet. A day rate on the rate card, or on this client, is what gives a proposal a price.'
        }
        actions={
          can.price && !locked ? (
            <Button size="sm" variant="ghost" onClick={open}>
              {price.priced ? 'Change' : 'Set a price'}
            </Button>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        {price.priced ? (
          <div className="flex flex-col gap-1.5">
            {price.discountPercent ? (
              <>
                <Line label="Before discount" value={amountText(price.gross, price.currency)} />
                <Line
                  label={`Discount, ${price.discountPercent}%`}
                  value={`− ${amountText(price.discount, price.currency)}`}
                  tone="text-warn"
                />
              </>
            ) : null}
            <Line label="Net" value={amountText(price.net, price.currency)} strong />
            {price.taxPercent ? (
              <Line
                label={`${price.taxLabel}, ${price.taxPercent}%`}
                value={amountText(price.tax, price.currency)}
              />
            ) : null}
            {price.taxPercent ? (
              <Line label="Total" value={amountText(price.total, price.currency)} strong />
            ) : null}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line-soft pt-2 text-[0.6875rem] text-fg-subtle">
              <span>
                Effective {amountText(price.effectiveRate, price.currency)} a day
                {price.floorDayRate ? ` · floor ${price.floorDayRate}` : ''}
              </span>
              {price.paymentTermsDays !== null && price.paymentTermsDays !== undefined ? (
                <span>{price.paymentTermsDays} days to pay</span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">
            {proposal.effortDays === null
              ? 'The effort has not been agreed yet either, and the price is the rate times the days.'
              : 'Ask an administrator to fill in Settings → The rate card, or give this client its own rate.'}
          </p>
        )}

        {proposal.pricing?.note ? (
          <p className="whitespace-pre-wrap text-xs text-fg-muted">{proposal.pricing.note}</p>
        ) : null}

        {/* The gate, said in the same words the server uses to refuse the send. */}
        {price.needsApproval ? (
          price.approvalState === 'approved' ? (
            <Alert tone="success" title="Signed off">
              <span className="inline-flex items-center gap-1.5">
                <BadgeCheck size={14} />
                Approved{price.approvedAt ? ` on ${formatDateTime(price.approvedAt)}` : ''}
                {price.approvalNote ? ` — ${price.approvalNote}` : ''}
              </span>
            </Alert>
          ) : price.approvalState === 'rejected' ? (
            <Alert tone="danger" title="The price was sent back">
              {price.approvalNote || 'Change it, or ask again with a reason.'}
            </Alert>
          ) : (
            <Alert tone="warning" title="This price needs a manager’s sign-off">
              {[
                price.belowFloor
                  ? `${amountText(price.effectiveRate, price.currency)} a day is under the floor of ${amountText(price.floorDayRate, price.currency)}`
                  : null,
                price.overDiscount
                  ? `a ${price.discountPercent}% discount is over the ${price.maxDiscountPercent}% a salesperson may give`
                  : null,
                price.approvalStale ? 'and the price changed after it was last approved' : null,
              ]
                .filter(Boolean)
                .join(', ')}
              . The offer cannot be sent until then.
            </Alert>
          )
        ) : null}

        {/* Whoever may sign it off gets the two buttons, wherever they are in the app. */}
        {can.approvePrice && price.needsApproval && price.approvalState !== 'approved' ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={BadgeCheck} onClick={() => setReviewing(true)}>
              Approve the price
            </Button>
            <Button size="sm" variant="ghost" icon={CircleSlash} onClick={() => setReviewing(false)}>
              Send it back
            </Button>
          </div>
        ) : null}

        {/* -------------------------------------------------------- the invoice -- */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-soft pt-3">
          <span className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Billing</span>
          {proposal.billing?.poNumber ? (
            <span className="text-xs text-fg">
              PO <span className="font-mono">{proposal.billing.poNumber}</span>
            </span>
          ) : proposal.company?.billing?.poRequired ? (
            <Badge tone="warning">No purchase order, and this client needs one</Badge>
          ) : (
            <span className="text-xs text-fg-subtle">No purchase order</span>
          )}
          {proposal.billing?.invoicedAt ? (
            <Badge tone="success">
              Invoiced {proposal.billing.invoiceRef ? `· ${proposal.billing.invoiceRef}` : ''}
            </Badge>
          ) : null}
          {can.billing ? (
            <Button
              size="sm"
              variant="ghost"
              icon={Receipt}
              className="ml-auto"
              onClick={() => {
                setPo(proposal.billing?.poNumber ?? '');
                setInvoiceRef(proposal.billing?.invoiceRef ?? '');
                setPoOpen(true);
              }}
            >
              Purchase order
            </Button>
          ) : null}
        </div>
      </CardBody>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="The price"
        description="A day rate and a discount. The total is those times the days the work side agreed, so it moves when the effort does — which is what stops the record and the contract disagreeing."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label={`Day rate, ${price.currency ?? ''}`}
            type="number"
            min="0"
            step="10"
            autoFocus
            placeholder={price.clientRate ?? price.standardRate ?? 'No rate card'}
            hint={
              price.clientRate
                ? `Empty uses this client’s rate of ${price.clientRate}.`
                : price.standardRate
                  ? `Empty uses the standard rate of ${price.standardRate}.`
                  : 'There is no rate card, so a figure here is the only price this proposal will have.'
            }
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
          <Input
            label="Discount, %"
            type="number"
            min="0"
            max="100"
            hint={
              price.maxDiscountPercent
                ? `Over ${price.maxDiscountPercent}% needs a manager’s sign-off before the offer can go out.`
                : 'Any discount needs a manager’s sign-off.'
            }
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
          />
          <Textarea
            label="Why this price"
            rows={2}
            placeholder="Third job this year, and they have committed to the retest."
            hint="The sentence a manager reads before signing it off."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title={reviewing ? 'Approve this price' : 'Send the price back'}
        description={
          reviewing
            ? 'Recorded against these exact figures. If the rate or the discount changes afterwards, the approval lapses and it comes back to you.'
            : 'Say what would make it acceptable — it goes back to whoever priced it.'
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant={reviewing ? 'primary' : 'secondary'}
              loading={saving}
              onClick={() => review(Boolean(reviewing))}
            >
              {reviewing ? 'Approve' : 'Send it back'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-xs text-fg-muted">
            {amountText(price.net, price.currency)} for {price.days} days ·{' '}
            {amountText(price.effectiveRate, price.currency)} a day
            {price.discountPercent ? ` after ${price.discountPercent}%` : ''}
          </div>
          <Textarea
            label="A note, if it needs one"
            rows={2}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={poOpen}
        onClose={() => setPoOpen(false)}
        title="Purchase order"
        description="Editable after acceptance, unlike everything else here: the number nearly always arrives afterwards, from somebody in the client’s finance team who was on none of the calls."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPoOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={saveBilling}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Their purchase order number"
            autoFocus
            placeholder="4500123456"
            hint={
              proposal.company?.billing?.poRequired
                ? 'This client will refuse an invoice without one.'
                : 'Printed on the offer and the invoice where a template asks for it.'
            }
            value={po}
            onChange={(event) => setPo(event.target.value)}
          />
          <Input
            label="Our invoice reference"
            placeholder="INV-2026-0142"
            hint="Filled in when it has actually been invoiced — the invoicing list reads this."
            value={invoiceRef}
            onChange={(event) => setInvoiceRef(event.target.value)}
          />
        </div>
      </Modal>
    </Card>
  );
}
