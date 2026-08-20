import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, ScrollText, Trash2 } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { timeAgo } from '../lib/utils.js';

import { Card, CardBody } from '../components/ui/Card.jsx';
import { PageHeader, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select, Textarea } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import ProposalDetail, { STATUS_TONE } from '../components/proposals/ProposalDetail.jsx';
import Comparables from '../components/proposals/Comparables.jsx';

/**
 * Where the work came from. Kept in step with PROPOSAL_SOURCE_LABELS on the server.
 *
 * A list rather than free text because the only purpose of this field is being counted, and
 * "referral", "Referral" and "ref" are three rows in a tally that should have one.
 */
const SOURCES = [
  { value: 'referral', label: 'Somebody referred them' },
  { value: 'existing-client', label: 'Existing client' },
  { value: 'inbound', label: 'They came to us' },
  { value: 'outbound', label: 'We approached them' },
  { value: 'partner', label: 'Through a partner' },
  { value: 'event', label: 'Event or talk' },
  { value: 'tender', label: 'Tender' },
  { value: 'other', label: 'Something else' },
];

/**
 * How often a page whose subject somebody else is changing checks back.
 *
 * A proposal is handed between two audiences, so the page a salesperson is looking at goes stale
 * the moment a manager signs a document off — and until this existed the only way to find out was
 * to leave the page and come back. Eight seconds is short enough to read as "it just updated" and
 * long enough that an open tab is not a load problem.
 */
const LIVE_MS = 8_000;

const VIEWS = [
  { value: 'open', label: 'Live' },
  { value: 'accepted', label: 'Won' },
  { value: 'declined', label: 'Lost' },
  { value: 'all', label: 'Everything' },
];

const FILTERS = {
  open: 'draft,evaluating,evaluated,documents-review,sent',
  accepted: 'accepted,converted',
  declined: 'declined',
  all: '',
};

/** Raise or edit one. Sales' half of the record — the estimate is not on here. */
function ProposalForm({ open, proposal, formData, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = Boolean(proposal?._id);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setForm({
      title: proposal?.title ?? '',
      company: proposal?.company?._id ?? proposal?.company ?? '',
      contacts: (proposal?.contacts ?? []).map((c) => c._id ?? c),
      auditType: proposal?.auditType ?? '',
      summary: proposal?.summary ?? '',
      constraints: proposal?.constraints ?? '',
      requestedOn: proposal?.requestedOn ?? new Date().toISOString().slice(0, 10),
      expectedStart: proposal?.expectedStart ?? '',
      expectedEnd: proposal?.expectedEnd ?? '',
      validUntil: proposal?.validUntil ?? '',
      salesDays: proposal?.estimate?.salesDays ?? '',
      retainerEngagements: proposal?.retainer?.engagements || '',
      retainerEveryMonths: proposal?.retainer?.everyMonths || '',
      sourceKind: proposal?.source?.kind ?? '',
      sourceDetail: proposal?.source?.detail ?? '',
    });
    setErrors({});
  }, [open, proposal]);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  /** Only the people who work at the client this proposal is for. */
  const contactOptions = useMemo(
    () => (formData?.contacts ?? []).filter((contact) => contact.company === form.company),
    [formData, form.company]
  );

  const save = async () => {
    const next = {};
    if (!form.title?.trim()) next.title = 'Required';
    if (!form.company) next.company = 'Pick the client';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        company: form.company,
        contacts: form.contacts,
        auditType: form.auditType,
        summary: form.summary,
        constraints: form.constraints,
        requestedOn: form.requestedOn,
        expectedStart: form.expectedStart,
        expectedEnd: form.expectedEnd,
        validUntil: form.validUntil,
        salesDays: form.salesDays === '' ? null : Number(form.salesDays),
        /*
         * Both halves or neither. One engagement every three months is a one-off with a stray
         * number attached, and four engagements with no interval is a wish — everything downstream
         * tests for the pair, so a half-filled pair is cleared here rather than stored to confuse
         * somebody later.
         */
        retainer:
          Number(form.retainerEngagements) > 1 && Number(form.retainerEveryMonths) > 0
            ? {
                engagements: Number(form.retainerEngagements),
                everyMonths: Number(form.retainerEveryMonths),
              }
            : { engagements: 0, everyMonths: null },
        source: { kind: form.sourceKind ?? '', detail: (form.sourceDetail ?? '').trim() },
      };
      const saved = isEdit
        ? await api.put(`/proposals/${proposal._id}`, payload)
        : await api.post('/proposals', payload);
      toast.success(isEdit ? 'Saved' : `Raised as ${saved.reference}`);
      onSaved?.(saved);
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${proposal.reference}` : 'New proposal'}
      description="What was asked for, and by whom. The effort is agreed separately by whoever would do the work."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {isEdit ? 'Save' : 'Raise it'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="What is it"
          required
          autoFocus
          wrapperClassName="sm:col-span-2"
          placeholder="External web application test — customer portal"
          value={form.title ?? ''}
          onChange={(event) => set({ title: event.target.value })}
          error={errors.title}
        />
        <Select
          label="Client"
          required
          value={form.company ?? ''}
          onChange={(event) => set({ company: event.target.value, contacts: [] })}
          options={[
            { value: '', label: 'Pick a client…' },
            ...(formData?.companies ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
          error={errors.company}
          hint="Not there? Add it on the Clients page first."
        />
        <Select
          label="Type of work"
          value={form.auditType ?? ''}
          onChange={(event) => set({ auditType: event.target.value })}
          options={[
            { value: '', label: 'Not decided yet' },
            ...(formData?.types ?? []).map((t) => ({ value: t.name, label: t.name })),
          ]}
        />

        {/*
          A plain multi-select rather than a picker widget: the list is one client's contacts,
          which is rarely more than four people.
        */}
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-xs font-medium text-fg-muted">
            Who it is addressed to{' '}
            <span className="font-normal text-fg-subtle">— the first one goes on the paperwork</span>
          </p>
          {contactOptions.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              {form.company ? 'No contacts recorded for this client yet.' : 'Pick a client first.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {contactOptions.map((contact) => {
                const on = (form.contacts ?? []).includes(contact.id);
                return (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() =>
                      set({
                        contacts: on
                          ? form.contacts.filter((id) => id !== contact.id)
                          : [...(form.contacts ?? []), contact.id],
                      })
                    }
                    className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                      on
                        ? 'border-brand-500/40 bg-brand-500/12 text-brand-200'
                        : 'border-line-soft text-fg-muted hover:text-fg'
                    }`}
                  >
                    {contact.fullname}
                    {contact.title ? <span className="text-fg-subtle"> · {contact.title}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <Textarea
          label="What they asked for"
          rows={4}
          wrapperClassName="sm:col-span-2"
          placeholder="Two internal domains, roughly 400 hosts. They want the AD estate looked at as well."
          value={form.summary ?? ''}
          onChange={(event) => set({ summary: event.target.value })}
        />
        <Textarea
          label="Anything that changes the price"
          rows={3}
          wrapperClassName="sm:col-span-2"
          placeholder="Out of hours only. Retest included. Two sites."
          value={form.constraints ?? ''}
          onChange={(event) => set({ constraints: event.target.value })}
        />

        <Input
          label="They asked on"
          type="date"
          value={form.requestedOn ?? ''}
          onChange={(event) => set({ requestedOn: event.target.value })}
        />
        <Input
          label="Offer valid until"
          type="date"
          value={form.validUntil ?? ''}
          onChange={(event) => set({ validUntil: event.target.value })}
        />
        <Input
          label="Hoped start"
          type="date"
          value={form.expectedStart ?? ''}
          onChange={(event) => set({ expectedStart: event.target.value })}
        />
        <Input
          label="Hoped end"
          type="date"
          value={form.expectedEnd ?? ''}
          onChange={(event) => set({ expectedEnd: event.target.value })}
        />
        <Input
          label="Your estimate, in days"
          type="number"
          min="0"
          step="0.5"
          hint="A starting figure. Whoever would do the work agrees the real one, and both are kept."
          value={form.salesDays ?? ''}
          onChange={(event) => set({ salesDays: event.target.value })}
        />
        {/*
          Beside the box rather than after it: the point of showing what these jobs actually take is
          to be read *while* the number is being typed, not once it has been saved.
        */}
        <div className="flex items-end">
          <Comparables auditType={form.auditType} className="w-full" />
        </div>

        <Select
          label="How did this come to us"
          hint="Counted, so the win rate per channel is answerable. It cannot be reconstructed later."
          value={form.sourceKind ?? ''}
          onChange={(event) => set({ sourceKind: event.target.value })}
          options={[{ value: '', label: 'Not recorded' }, ...SOURCES]}
        />
        <Input
          label="Who or what, specifically"
          placeholder="Dana at Acme introduced them"
          hint="The half that makes the channel useful — who to thank, which event to go to again."
          value={form.sourceDetail ?? ''}
          onChange={(event) => set({ sourceDetail: event.target.value })}
        />

        {/*
          A retainer is not a different kind of proposal — it is this one with a schedule attached,
          which is why it is two fields at the bottom of the same form rather than a second flow.
          Left empty on nearly every proposal, and empty is what a one-off means.
        */}
        <div className="sm:col-span-2 border-t border-line-soft pt-4">
          <p className="text-xs font-medium text-fg-muted">
            Sold as several engagements?{' '}
            <span className="font-normal text-fg-subtle">
              — leave both blank for an ordinary one-off
            </span>
          </p>
        </div>
        <Input
          label="How many engagements"
          type="number"
          min="0"
          max="24"
          step="1"
          placeholder="4"
          hint="Including the first one."
          value={form.retainerEngagements ?? ''}
          onChange={(event) => set({ retainerEngagements: event.target.value })}
        />
        <Input
          label="One every, in months"
          type="number"
          min="1"
          max="24"
          step="1"
          placeholder="3"
          hint="Creating the engagement schedules a reminder for the next, rather than creating them all now."
          value={form.retainerEveryMonths ?? ''}
          onChange={(event) => set({ retainerEveryMonths: event.target.value })}
        />
      </div>
    </Modal>
  );
}

export default function SalesProposalsPage() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('open');
  /** Seeded from `?open=`, so a search result and the sales log both land on the right one. */
  const [selected, setSelected] = useState(searchParams.get('open'));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  /*
   * A proposal arrived at by link may not be in the current tab — a link to a lost deal while
   * "Live" is showing would open nothing. So the filter widens to everything until it is closed.
   */
  const deepLinked = searchParams.get('open');
  const query = deepLinked ? '' : FILTERS[view] ? `?status=${FILTERS[view]}` : '';
  const { data, error, loading, reload } = useResource(`/proposals${query}`, {
    initial: null,
    // Somebody else moves this record: a manager signing the paperwork off is what sales is
    // waiting for, and they should not have to leave the page to find out.
    poll: LIVE_MS,
  });
  const formData = useResource('/proposals/form-data', { initial: null });

  const proposals = data?.proposals ?? [];

  const remove = async () => {
    setDeleting(true);
    try {
      await api.del(`/proposals/${pendingDelete._id}`);
      toast.success(`${pendingDelete.reference} deleted`);
      // Back to the list if the open one is the one that just went.
      if (selected === pendingDelete._id) setSelected(null);
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * The open one, fetched in full.
   *
   * The list used to carry every proposal's whole record — its documents, its comments, its status
   * history — purely so that opening one needed no request. That made every page load of a hundred
   * proposals pay for ninety-nine records nobody was reading. The list is now rows, and this is the
   * one that is being read.
   *
   * Polled on the same interval the list is, because the reason a salesperson has this open is
   * usually that they are waiting for somebody else to sign the paperwork off.
   */
  const detail = useResource(selected ? `/proposals/${selected}` : null, {
    initial: null,
    poll: LIVE_MS,
  });
  const current = selected ? detail.data : null;

  /*
   * Declared once, rendered by both views.
   *
   * It used to live only inside the detail branch below, which meant the trash button on a list
   * row set the state and nothing appeared — the dialog that would have shown it was not on the
   * page. A single definition is the fix *and* the guard against it happening again: there is
   * nowhere left for the two copies to disagree.
   */
  const deleteDialog = (
    <ConfirmDialog
      open={Boolean(pendingDelete)}
      onClose={() => setPendingDelete(null)}
      onConfirm={remove}
      loading={deleting}
      title={`Delete ${pendingDelete?.reference ?? 'this proposal'}?`}
      confirmLabel="Delete"
      message={`${pendingDelete?.title ?? 'It'} and any paperwork generated for it are deleted for good. One that has become an engagement cannot be deleted — the app refuses.`}
    />
  );

  if (current) {
    return (
      <div className="flex flex-col gap-6">
        <Button
          variant="ghost"
          icon={ArrowLeft}
          className="self-start"
          onClick={() => {
            setSelected(null);
            // Drops `?open=` too, or the list would reopen it on the next render.
            if (deepLinked) setSearchParams({}, { replace: true });
          }}
        >
          Back to the pipeline
        </Button>
        <ProposalDetail
          proposal={current}
          onChange={() => {
            /* Both: the row's status and days change with it, and the detail is what is on screen. */
            detail.reload({ quiet: true });
            reload({ quiet: true });
          }}
          onEdit={(proposal) => setEditing(proposal)}
          onDelete={(proposal) => setPendingDelete(proposal)}
          /*
           * Straight to the clone. It is a draft, so the current tab would usually not contain it —
           * `?open=` is what widens the filter to everything, and it is set here for the same
           * reason a search result sets it.
           */
          onCloned={(created) => {
            reload({ quiet: true });
            setSelected(created._id);
            setSearchParams({ open: created._id }, { replace: true });
          }}
        />
        <ProposalForm
          open={Boolean(editing)}
          proposal={editing}
          formData={formData.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            detail.reload({ quiet: true });
            reload({ quiet: true });
          }}
        />
        {deleteDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Proposals"
        description="Work that has been asked for and not yet sold. Raise one, get the effort agreed, generate the paperwork, send it."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New proposal
          </Button>
        }
      />

      {formData.data && !formData.data.firmReady ? (
        <Alert tone="warning" title="Your own company details are not filled in">
          An NDA generated now would name a blank first party. An administrator can set them under
          Settings → Your firm.
        </Alert>
      ) : null}

      <Tabs options={VIEWS} value={view} onChange={setView} />

      <Card>
        {loading ? (
          <SkeletonRows rows={4} columns={5} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : proposals.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="Nothing here"
            description={
              view === 'open'
                ? 'Raise a proposal when a client asks for something.'
                : 'Nothing in this part of the pipeline.'
            }
            actionLabel={view === 'open' ? 'New proposal' : undefined}
            onAction={view === 'open' ? () => setCreating(true) : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH>Proposal</TH>
              <TH>Client</TH>
              <TH>Status</TH>
              <TH align="right">Effort</TH>
              <TH align="right">Last change</TH>
              <TH width="3rem" />
            </THead>
            <TBody>
              {proposals.map((proposal) => (
                <TR key={proposal._id} onClick={() => setSelected(proposal._id)} className="cursor-pointer">
                  <TD>
                    <p className="truncate text-sm font-medium text-fg">{proposal.title}</p>
                    <p className="font-mono text-[0.6875rem] text-fg-subtle">{proposal.reference}</p>
                  </TD>
                  <TD className="text-sm text-fg-muted">{proposal.company?.name}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[proposal.status] ?? 'neutral'}>{proposal.status}</Badge>
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-sm">
                    {proposal.effortDays === null ? (
                      <span className="text-fg-subtle">—</span>
                    ) : (
                      <>
                        <span className="text-fg">{proposal.effortDays}d</span>
                        {/* An unchecked figure is marked, so nobody quotes it by accident. */}
                        {!proposal.effortAgreed ? (
                          <span className="ml-1 text-[0.625rem] text-warn">unchecked</span>
                        ) : null}
                      </>
                    )}
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                    {timeAgo(proposal.updatedAt)}
                  </TD>
                  <TD align="right">
                    {/* Stops the row's own click, which would open the proposal underneath the
                        dialog asking whether to delete it. */}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={Trash2}
                      title={
                        proposal.audit && !proposal.audit.deletedAt
                          ? `${proposal.audit.name} was created from this — delete that first`
                          : 'Delete proposal'
                      }
                      // Live engagement only. One in the trash no longer holds this back, which
                      // is what somebody who just deleted it expects.
                      disabled={Boolean(proposal.audit && !proposal.audit.deletedAt)}
                      className="hover:text-crit"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDelete(proposal);
                      }}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <ProposalForm
        open={creating}
        formData={formData.data}
        onClose={() => setCreating(false)}
        onSaved={(saved) => {
          reload({ quiet: true });
          setSelected(saved._id);
        }}
      />
      {deleteDialog}
    </div>
  );
}
