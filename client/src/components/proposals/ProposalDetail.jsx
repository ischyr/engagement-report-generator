import { useState } from 'react';
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  MessageSquare,
  Paperclip,
  Repeat,
  Send,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { downloadBlob, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Alert } from '../ui/Alert.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import ProposalSteps from './ProposalSteps.jsx';
import PriceCard from './PriceCard.jsx';
import Comparables from './Comparables.jsx';

export const STATUS_TONE = {
  draft: 'neutral',
  evaluating: 'warning',
  evaluated: 'info',
  'documents-review': 'warning',
  sent: 'brand',
  accepted: 'success',
  declined: 'danger',
  converted: 'success',
};

/**
 * Kept in step with PROPOSAL_DOC_LABELS on the server.
 *
 * `pta` is a **permission to attack** — authorisation to touch the client's systems — not a
 * testing agreement, which is commercial terms. It was labelled the latter here, and of all the
 * words in this app it is the one worth getting right.
 */
export const DOC_LABELS = {
  nda: 'NDA',
  pta: 'Permission to attack',
  proposal: 'Proposal',
  sow: 'Statement of work',
  'pre-engagement': 'Pre-engagement',
  /** The older name for the same slot, so existing rows still read. */
  request: 'Pre-engagement',
  other: 'Other',
};

/** A label and a value, which is most of what this page is. */
function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">{label}</p>
      <p className="mt-0.5 truncate text-sm text-fg">{children || '—'}</p>
    </div>
  );
}

/**
 * The effort, both numbers.
 *
 * Showing what sales said next to what was agreed is the whole point of keeping two fields —
 * see the model. A single number would hide the disagreement, and the disagreement is the
 * useful part: "five days sold, nine days needed" is a fact somebody should see every time.
 */
function Effort({ proposal, onSave, canEdit }) {
  /*
   * The comparison sits in this card rather than in the dialog, so it is visible to whoever is
   * *arguing* about the figure as well as to whoever is typing it. Sales quoting five days and the
   * last three of these taking seven is a conversation, not a validation error.
   */
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const sales = proposal.estimate?.salesDays ?? null;
  const agreed = proposal.estimate?.days ?? null;
  const revised = agreed !== null && sales !== null && agreed !== sales;

  const open = () => {
    setDays(agreed ?? sales ?? '');
    setNote(proposal.estimate?.note ?? '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/proposals/${proposal._id}/estimate`, {
        days: days === '' ? null : Number(days),
        note,
      });
      toast.success('Effort recorded');
      setEditing(false);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Effort"
          description="What sales quoted, and what the work is actually reckoned to take."
          actions={
            canEdit ? (
              <Button size="sm" variant="secondary" onClick={open}>
                {agreed === null ? 'Set the effort' : 'Change it'}
              </Button>
            ) : null
          }
        />
        <CardBody className="flex flex-wrap items-end gap-8">
          <div>
            <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Sales quoted</p>
            <p className="mt-0.5 text-2xl font-semibold text-fg-muted">
              {sales === null ? '—' : sales}
              <span className="ml-1 text-sm font-normal text-fg-subtle">days</span>
            </p>
          </div>
          <ArrowRight size={16} className="mb-2 text-fg-subtle" />
          <div>
            <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Agreed</p>
            <p className="mt-0.5 text-2xl font-semibold text-fg">
              {agreed === null ? '—' : agreed}
              <span className="ml-1 text-sm font-normal text-fg-subtle">days</span>
            </p>
          </div>
          {revised ? (
            <Badge tone={agreed > sales ? 'warning' : 'info'}>
              {agreed > sales ? `${agreed - sales} more than quoted` : `${sales - agreed} fewer than quoted`}
            </Badge>
          ) : null}
          {agreed === null ? (
            <Badge tone="warning">nobody has checked this yet</Badge>
          ) : null}
          {proposal.estimate?.note ? (
            <p className="w-full text-xs leading-relaxed text-fg-muted">{proposal.estimate.note}</p>
          ) : null}
          {proposal.estimate?.at ? (
            <p className="w-full text-[0.6875rem] text-fg-subtle">
              Set by {proposal.estimate.by?.firstname ?? 'somebody'} {timeAgo(proposal.estimate.at)}
            </p>
          ) : null}
          {/* What jobs of this type have actually taken — the figure both sides are arguing past. */}
          <Comparables auditType={proposal.auditType} className="w-full" />
        </CardBody>
      </Card>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="How long will it take?"
        description="Sales' figure is kept as it was, so a change reads as a change."
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
        <div className="flex flex-col gap-4">
          <Input
            label="Days"
            type="number"
            min="0"
            step="0.5"
            autoFocus
            hint={sales === null ? undefined : `Sales quoted ${sales}.`}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
          <Textarea
            label="Why, if it differs"
            rows={3}
            placeholder="Two domains rather than one, and the AD estate is larger than the brief suggested."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}

/** The technical read, which is what the evaluating status is waiting on. */
function Evaluation({ proposal, onSave, canEdit }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState('');
  const [verdict, setVerdict] = useState('');
  const [saving, setSaving] = useState(false);

  const open = () => {
    setNotes(proposal.evaluation?.notes ?? '');
    setVerdict(proposal.evaluation?.verdict ?? '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/proposals/${proposal._id}/evaluation`, { notes, verdict });
      toast.success('Evaluation saved');
      setEditing(false);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Evaluation"
          description="Can we do this, and on what terms."
          actions={
            canEdit ? (
              <Button size="sm" variant="secondary" onClick={open}>
                {proposal.evaluation?.at ? 'Update' : 'Write it'}
              </Button>
            ) : null
          }
        />
        <CardBody>
          {proposal.evaluation?.at ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Badge
                  tone={
                    proposal.evaluation.verdict === 'feasible'
                      ? 'success'
                      : proposal.evaluation.verdict === 'not-for-us'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {proposal.evaluation.verdict || 'no verdict'}
                </Badge>
                <span className="text-[0.6875rem] text-fg-subtle">
                  {proposal.evaluation.by?.firstname ?? 'somebody'} · {formatDateTime(proposal.evaluation.at)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
                {proposal.evaluation.notes || 'No notes.'}
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-subtle">Nobody has looked at this yet.</p>
          )}
        </CardBody>
      </Card>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Evaluation"
        size="md"
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
        <div className="flex flex-col gap-4">
          <Select
            label="Verdict"
            value={verdict}
            onChange={(event) => setVerdict(event.target.value)}
            options={[
              { value: '', label: 'Not decided' },
              { value: 'feasible', label: 'We can do this' },
              { value: 'needs-more-info', label: 'Needs more information' },
              { value: 'not-for-us', label: 'Not work for us' },
            ]}
          />
          <Textarea
            label="Notes"
            rows={7}
            placeholder="What the work actually involves, what is missing from the brief, anything that changes the price."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}

/**
 * The kickoff call.
 *
 * Its own card because the permission to attack is written from it and nothing else in the app
 * records it. Either side can fill it in — the call is sales' to arrange and the technical people
 * ask the questions on it, so restricting it would mean whoever attended could not write it up.
 *
 * The emergency contact is the field that matters most and the one most likely to be skipped, so
 * it is marked when it is missing rather than left as an empty line.
 */
function Kickoff({ proposal, onSave }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  const kickoff = proposal.kickoff ?? {};
  const held = Boolean(kickoff.heldOn);

  const open = () => {
    setForm({
      heldOn: kickoff.heldOn ?? '',
      attendeesOurs: kickoff.attendeesOurs ?? '',
      attendeesTheirs: kickoff.attendeesTheirs ?? '',
      emergencyContact: kickoff.emergencyContact ?? '',
      notes: kickoff.notes ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put(`/proposals/${proposal._id}/kickoff`, form);
      toast.success('Kickoff recorded');
      setEditing(false);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          icon={CalendarCheck}
          title="Kickoff"
          description="What was agreed on the call. The permission to attack is generated from this."
          actions={
            <Button size="sm" variant="secondary" onClick={open}>
              {held ? 'Update' : 'Record it'}
            </Button>
          }
        />
        <CardBody>
          {held ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-4">
                <Fact label="Held on">{kickoff.heldOn}</Fact>
                <Fact label="Emergency contact">
                  {kickoff.emergencyContact || (
                    <span className="text-warn">nobody named yet</span>
                  )}
                </Fact>
                <Fact label="Ours">{kickoff.attendeesOurs}</Fact>
                <Fact label="Theirs">{kickoff.attendeesTheirs}</Fact>
              </div>
              {kickoff.notes ? (
                <p className="whitespace-pre-wrap border-t border-line-soft pt-3 text-sm leading-relaxed text-fg-muted">
                  {kickoff.notes}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">
              Not held yet. A permission to attack generated now will leave this section out.
            </p>
          )}
        </CardBody>
      </Card>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Kickoff call"
        description="Whoever was on the call can write this up. It feeds the permission to attack."
        size="md"
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Held on"
            type="date"
            autoFocus
            hint="Until this is set, the paperwork treats the call as not having happened."
            value={form.heldOn ?? ''}
            onChange={(event) => setForm({ ...form, heldOn: event.target.value })}
          />
          <Input
            label="Emergency contact"
            placeholder="Dana Reyes — +44 7700 900000"
            hint="Who to ring during testing if something breaks."
            value={form.emergencyContact ?? ''}
            onChange={(event) => setForm({ ...form, emergencyContact: event.target.value })}
          />
          <Input
            label="Present from us"
            placeholder="Olive Probe, Sam Probe"
            value={form.attendeesOurs ?? ''}
            onChange={(event) => setForm({ ...form, attendeesOurs: event.target.value })}
          />
          <Input
            label="Present from the client"
            placeholder="Dana Reyes (CISO), Marcus Ellery (IT)"
            value={form.attendeesTheirs ?? ''}
            onChange={(event) => setForm({ ...form, attendeesTheirs: event.target.value })}
          />
          <Textarea
            label="What was agreed"
            rows={6}
            wrapperClassName="sm:col-span-2"
            placeholder="In scope: the two internal domains. Out of hours only, from 20:00. No social engineering. They will provide a domain account on day one."
            value={form.notes ?? ''}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
        </div>
      </Modal>
    </>
  );
}

/** Generated paperwork and whatever the client sent, with the sign-off on each. */
function Documents({ proposal, onChange, can }) {
  const toast = useToast();
  const templates = useResource(can.generate ? '/proposals/templates' : null, { initial: [] });
  const [busy, setBusy] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);

  const generate = async (templateId) => {
    setBusy(templateId);
    try {
      const updated = await api.post(`/proposals/${proposal._id}/documents/generate`, {
        template: templateId,
      });
      toast.success('Generated', 'Somebody on the delivery side needs to sign it off.');
      onChange?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const review = async (doc, approved, why) => {
    setBusy(doc._id);
    try {
      const updated = await api.post(`/proposals/${proposal._id}/documents/${doc._id}/review`, {
        approved,
        ...(why ? { reason: why } : {}),
      });
      toast.success(approved ? 'Signed off' : 'Sent back');
      setRejecting(null);
      setReason('');
      onChange?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    // The pre-engagement document: what sales wrote up from the request, and what the NDA, the
    // permission and the offer are all drawn from.
    form.append('docType', 'pre-engagement');
    setBusy('upload');
    try {
      const updated = await api.post(`/proposals/${proposal._id}/documents`, form);
      toast.success('Attached');
      onChange?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  /*
   * Fetched with the access token and handed to the browser as a blob, rather than linked.
   * The same path the report and a client's engagement documents take: a plain <a href> would
   * need either a cookie the download route does not accept or an unauthenticated URL.
   */
  const download = async (doc) => {
    setBusy(doc._id);
    try {
      const response = await api.raw(`/proposals/${proposal._id}/documents/${doc._id}/download`);
      downloadBlob(await response.blob(), doc.filename);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy(pendingDelete._id);
    try {
      const updated = await api.del(`/proposals/${proposal._id}/documents/${pendingDelete._id}`);
      setPendingDelete(null);
      onChange?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const docs = proposal.documents ?? [];
  const list = Array.isArray(templates.data) ? templates.data : [];

  return (
    <>
      <Card>
        <CardHeader
          icon={FileText}
          title="Paperwork"
          description="The pre-engagement document you upload, and the NDA, permission to attack and offer generated from it — each checked by somebody other than whoever generated it."
          actions={
            can.edit ? (
              <label className="cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    upload(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <Button as="span" size="sm" variant="ghost" icon={Upload} loading={busy === 'upload'}>
                  Upload the pre-engagement
                </Button>
              </label>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-3">
          {docs.length === 0 ? (
            <p className="text-sm text-fg-subtle">Nothing yet.</p>
          ) : (
            docs.map((doc) => (
              <div
                key={doc._id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                {doc.generated ? <FileText size={15} className="text-brand-400" /> : <Paperclip size={15} className="text-fg-subtle" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {DOC_LABELS[doc.docType] ?? doc.docType}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {doc.filename} · {Math.max(1, Math.round(doc.bytes / 1024))} KB ·{' '}
                    {doc.generated ? 'generated' : 'from the client'} {timeAgo(doc.addedAt)}
                  </p>
                </div>

                {!doc.generated ? null : doc.approvedAt ? (
                  <Badge tone="success" icon={CheckCircle2}>
                    signed off
                  </Badge>
                ) : doc.rejectedAt ? (
                  <Badge tone="danger" icon={XCircle}>
                    sent back
                  </Badge>
                ) : (
                  <Badge tone="warning">waiting for sign-off</Badge>
                )}

                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={Download}
                    title="Download"
                    loading={busy === doc._id}
                    onClick={() => download(doc)}
                  />
                  {doc.generated && can.approveDocuments ? (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={CheckCircle2}
                        title="Sign it off"
                        className="hover:text-ok"
                        loading={busy === doc._id}
                        onClick={() => review(doc, true)}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={XCircle}
                        title="Send it back"
                        className="hover:text-crit"
                        onClick={() => setRejecting(doc)}
                      />
                    </>
                  ) : null}
                  {can.edit ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={Trash2}
                      title="Remove"
                      className="hover:text-crit"
                      onClick={() => setPendingDelete(doc)}
                    />
                  ) : null}
                </div>

                {doc.rejectedReason ? (
                  <p className="w-full text-xs text-crit">
                    Sent back by {doc.rejectedBy?.firstname ?? 'somebody'}: {doc.rejectedReason}
                  </p>
                ) : null}
              </div>
            ))
          )}

          {/*
            Why there is no button, rather than a row of documents and no way to act on them.
            Somebody staring at "waiting for sign-off" with nothing to press assumes the app is
            broken; the honest answer is that it is not their decision.
          */}
          {!can.approveDocuments && docs.some((doc) => doc.generated && !doc.approvedAt) ? (
            <Alert tone="info" title="Waiting on a manager">
              Signing a client's paperwork off takes the Manager role. Anybody who holds it can do
              this — ask an administrator if nobody does yet.
            </Alert>
          ) : null}

          {can.generate && list.length ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
              <span className="text-xs text-fg-subtle">Generate:</span>
              {list.map((template) => (
                <Button
                  key={template.id}
                  size="sm"
                  variant="secondary"
                  loading={busy === template.id}
                  onClick={() => generate(template.id)}
                >
                  {DOC_LABELS[template.docType] ?? template.name}
                </Button>
              ))}
            </div>
          ) : can.generate ? (
            <Alert tone="info" title="No proposal templates uploaded yet">
              Run <code className="font-mono text-xs">npm run make:proposal-templates</code> for a
              starter NDA, permission to attack and proposal, then upload them on the Templates page
              with the purpose set to "Proposal paperwork".
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <Modal
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        title="Send it back"
        description="Say what is wrong, so whoever fixes it knows what to change."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              onClick={() => review(rejecting, false, reason.trim())}
            >
              Send back
            </Button>
          </>
        }
      >
        <Textarea
          label="What is wrong with it"
          rows={4}
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this document?"
        confirmLabel="Remove"
        message={`${pendingDelete?.filename ?? 'It'} is deleted from storage. A generated one can be produced again; anything the client sent cannot.`}
      />
    </>
  );
}

/**
 * One proposal, in full.
 *
 * The same component for both audiences. What differs is `can` and `transitions`, which the
 * API works out from the reader's role — so the buttons on the page are exactly the moves the
 * server will accept, rather than a second guess at the same rules.
 */
/**
 * Why it closed, in the words the reporting counts.
 *
 * Kept in step with LOSS_REASONS and WIN_REASONS on the server, which validates them — so a list that
 * drifts here shows up as a refused move rather than as a quietly uncounted reason.
 */
const LOSS_REASONS = [
  { value: 'price', label: 'Too expensive' },
  { value: 'timing', label: 'Could not do it when they needed it' },
  { value: 'budget', label: 'No budget this cycle' },
  { value: 'competitor', label: 'Went to a competitor' },
  { value: 'in-house', label: 'Doing it themselves' },
  { value: 'scope', label: 'Wanted something we do not do' },
  { value: 'no-response', label: 'Went quiet' },
  { value: 'other', label: 'Something else' },
];

const WIN_REASONS = [
  { value: 'relationship', label: 'They know us' },
  { value: 'price', label: 'Price' },
  { value: 'availability', label: 'We could start when they needed' },
  { value: 'specialism', label: 'The specific expertise' },
  { value: 'referral', label: 'Referred to us' },
  { value: 'incumbent', label: 'We did the last one' },
  { value: 'other', label: 'Something else' },
];

/**
 * The argument about the estimate, kept where the estimate is.
 *
 * Sales asks why it is five days and not three; whoever wrote the figure answers. Until this existed
 * that exchange happened in email, which meant the next person to pick the proposal up could not see
 * it — and the evaluation note is one person's verdict rather than a conversation.
 *
 * Open to both audiences on purpose. Every other panel on this page belongs to one side or the
 * other, and this is the one place they are meant to disagree in writing.
 */
function Comments({ proposal, onSave }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState(null);

  const comments = proposal.comments ?? [];

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      const updated = await api.post(`/proposals/${proposal._id}/comments`, { body: text });
      setBody('');
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSending(false);
    }
  };

  const remove = async (comment) => {
    setRemoving(comment._id);
    try {
      const updated = await api.del(`/proposals/${proposal._id}/comments/${comment._id}`);
      onSave?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={MessageSquare}
        title="Discussion"
        description={
          comments.length
            ? `${comments.length} comment${comments.length === 1 ? '' : 's'} — sales and delivery, in one place.`
            : 'Ask about the estimate, the scope or the dates here rather than in email.'
        }
      />
      <CardBody className="flex flex-col gap-3">
        {comments.length ? (
          <ul className="flex flex-col gap-3">
            {comments.map((comment) => (
              <li key={comment._id} className="flex flex-col gap-0.5">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium text-fg">
                    {comment.author?.name ?? 'Somebody'}
                  </span>
                  <span
                    className="text-[0.6875rem] text-fg-subtle"
                    title={formatDateTime(comment.createdAt)}
                  >
                    {timeAgo(comment.createdAt)}
                  </span>
                  {comment.canDelete ? (
                    <button
                      type="button"
                      disabled={removing === comment._id}
                      onClick={() => remove(comment)}
                      className="text-[0.6875rem] text-fg-subtle underline decoration-dotted transition hover:text-crit disabled:opacity-50"
                    >
                      remove
                    </button>
                  ) : null}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
                  {comment.body}
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <Textarea
            label="Say something"
            rows={2}
            placeholder="Five days feels high for 40 hosts — is the AD estate in this figure?"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            /* Ctrl+Enter sends: this is a chat box in a page full of forms. */
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
            }}
          />
          <div className="flex items-center gap-2 self-end">
            <span className="text-[0.6875rem] text-fg-subtle">Ctrl+Enter</span>
            <Button
              size="sm"
              variant="secondary"
              icon={Send}
              loading={sending}
              disabled={!body.trim()}
              onClick={send}
            >
              Post
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export default function ProposalDetail({ proposal, onChange, onEdit, onDelete, onCloned }) {
  const toast = useToast();
  const [moving, setMoving] = useState(null);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(null);
  /** The structured half of "why", which is what makes six months of these worth reading. */
  const [reason, setReason] = useState('');
  const [competitor, setCompetitor] = useState('');

  const can = proposal.can ?? {};

  const move = async (to, why, outcome = {}) => {
    setMoving(to);
    try {
      const updated = await api.post(`/proposals/${proposal._id}/status`, {
        status: to,
        ...(why ? { note: why } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.competitor ? { competitor: outcome.competitor } : {}),
      });
      toast.success(`Moved to ${updated.status}`);
      setAsking(null);
      setNote('');
      setReason('');
      setCompetitor('');
      onChange?.(updated);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMoving(null);
    }
  };

  /**
   * Next year's, from last year's.
   *
   * A repeat client's annual test is the same proposal with the dates moved. Retyping it is half an
   * hour and a chance to leave a constraint out. The server deliberately does not copy the agreed
   * estimate or any paperwork — see the route — so what appears is a draft of the *request*, which
   * then goes round the loop again like any other.
   */
  const clone = async () => {
    setMoving('clone');
    try {
      const created = await api.post(`/proposals/${proposal._id}/clone`, {});
      toast.success(`Raised as ${created.reference}`, 'Dates moved a year on. No estimate yet.');
      onCloned?.(created);
      onChange?.(created);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMoving(null);
    }
  };

  const convert = async () => {
    setMoving('convert');
    try {
      const result = await api.post(`/proposals/${proposal._id}/convert`, {});
      toast.success('Engagement created', result.audit?.name);
      onChange?.(result.proposal);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMoving(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Where it is, and whose turn it is. The badge alone answers neither. */}
      <ProposalSteps status={proposal.status} />

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[proposal.status] ?? 'neutral'}>{proposal.status}</Badge>
                <span className="font-mono text-xs text-fg-subtle">{proposal.reference}</span>
              </div>
              <h2 className="mt-1.5 truncate text-lg font-semibold text-fg">{proposal.title}</h2>
              <p className="text-sm text-fg-muted">{proposal.company?.name}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {can.edit && !['sent', 'accepted', 'converted'].includes(proposal.status) && onEdit ? (
                <Button size="sm" variant="ghost" onClick={() => onEdit(proposal)}>
                  Edit details
                </Button>
              ) : null}
              {/*
                Offered on a closed proposal only. Cloning a draft duplicates something nobody has
                even sent; cloning last year's won job is the annual retest, which is most of the
                repeat business a firm like this has.
              */}
              {can.clone && ['accepted', 'converted', 'declined'].includes(proposal.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Copy}
                  loading={moving === 'clone'}
                  onClick={clone}
                  title="Raise the same proposal again, dates a year on"
                >
                  Clone for next time
                </Button>
              ) : null}
              {/* Only where deleting is somebody's to do, and not while a live engagement
                  depends on it. One in the trash does not hold it back. */}
              {can.edit && onDelete && !(proposal.audit && !proposal.audit.deletedAt) ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={Trash2}
                  title="Delete this proposal"
                  className="hover:text-crit"
                  onClick={() => onDelete(proposal)}
                />
              ) : null}
              {/* Only for whoever will run the job — see `can.convert`. A button that answers
                  403 is how people learn to distrust the page. */}
              {can.convert && proposal.status === 'accepted' && !proposal.audit ? (
                <Button size="sm" variant="primary" loading={moving === 'convert'} onClick={convert}>
                  Create the engagement
                </Button>
              ) : null}
              {(proposal.transitions ?? []).map((entry) =>
                entry.problem ? (
                  <Button key={entry.to} size="sm" variant="ghost" disabled title={entry.problem}>
                    {entry.label}
                  </Button>
                ) : (
                  <Button
                    key={entry.to}
                    size="sm"
                    variant={entry.to === 'declined' ? 'ghost' : 'secondary'}
                    loading={moving === entry.to}
                    className={entry.to === 'declined' ? 'hover:text-crit' : undefined}
                    onClick={() =>
                      /*
                       * Both closing moves ask. A loss must give a reason — the server refuses
                       * without one — and a win is offered the same question because "why did we win
                       * this" is the half of the picture nobody ever writes down.
                       */
                      entry.to === 'declined' || entry.to === 'accepted'
                        ? setAsking(entry)
                        : move(entry.to)
                    }
                  >
                    {entry.label}
                  </Button>
                )
              )}
            </div>
          </div>

          {/* Why a move cannot be made yet, said once at the top rather than only in a tooltip. */}
          {(proposal.transitions ?? []).some((entry) => entry.problem) ? (
            <Alert tone="info" title="Not ready to move on">
              {proposal.transitions.find((entry) => entry.problem).problem}
            </Alert>
          ) : null}

          <div className="grid grid-cols-2 gap-4 border-t border-line-soft pt-4 sm:grid-cols-4">
            <Fact label="Type">{proposal.auditType}</Fact>
            <Fact label="Requested">{proposal.requestedOn}</Fact>
            <Fact label="Window">
              {[proposal.expectedStart, proposal.expectedEnd].filter(Boolean).join(' → ')}
            </Fact>
            <Fact label="Valid until">{proposal.validUntil}</Fact>
            <Fact label="Sales owner">
              {[proposal.owner?.firstname, proposal.owner?.lastname].filter(Boolean).join(' ')}
            </Fact>
            <Fact label="Contacts">
              {(proposal.contacts ?? [])
                .map((c) => [c.firstname, c.lastname].filter(Boolean).join(' ') || c.email)
                .join(', ')}
            </Fact>
            {proposal.retainer?.engagements > 1 && proposal.retainer?.everyMonths ? (
              <Fact label="Sold as">
                <span className="inline-flex items-center gap-1.5">
                  <Repeat size={13} className="shrink-0 text-brand-300" />
                  {proposal.retainer.engagements} engagements, every{' '}
                  {proposal.retainer.everyMonths}m
                </span>
              </Fact>
            ) : null}
            <Fact label="Engagement">{proposal.audit?.name}</Fact>
            <Fact label="Last change">{timeAgo(proposal.updatedAt)}</Fact>
          </div>

          {proposal.summary ? (
            <div className="border-t border-line-soft pt-4">
              <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">What they asked for</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
                {proposal.summary}
              </p>
            </div>
          ) : null}
          {proposal.constraints ? (
            <div>
              <p className="text-[0.625rem] uppercase tracking-wider text-fg-subtle">Constraints</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
                {proposal.constraints}
              </p>
            </div>
          ) : null}
          {/*
            Said in full where it changes what somebody does next: converting a retainer creates the
            first engagement and sets it to nudge for the next, rather than creating all of them now.
            Somebody expecting four engagements to appear should read this before they wonder.
          */}
          {proposal.retainer?.engagements > 1 && proposal.retainer?.everyMonths ? (
            <Alert tone="info" title="Sold as a retainer">
              {proposal.retainer.engagements} engagements, one every {proposal.retainer.everyMonths}{' '}
              month{proposal.retainer.everyMonths === 1 ? '' : 's'}. Creating the engagement makes the
              first one and schedules a reminder for the next — the rest are not created up front, so
              nothing is booked on the team's behalf.
            </Alert>
          ) : null}
          {proposal.declineReason ? (
            <Alert tone="warning" title="Declined">
              {proposal.declineReason}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Effort proposal={proposal} onSave={onChange} canEdit={can.estimate} />
        <Evaluation proposal={proposal} onSave={onChange} canEdit={can.evaluate} />
        {/*
          The price under the effort it is computed from, and beside the evaluation that argues
          about it. It is the same conversation: how long, and therefore how much.
        */}
        <PriceCard proposal={proposal} onSave={onChange} />
      </div>

      <Kickoff proposal={proposal} onSave={onChange} />

      <Documents proposal={proposal} onChange={onChange} can={can} />

      <Comments proposal={proposal} onSave={onChange} />

      {(proposal.history ?? []).length ? (
        <Card>
          <CardHeader title="How it got here" />
          <CardBody className="flex flex-col gap-1.5">
            {[...proposal.history].reverse().map((entry, index) => (
              <p key={index} className="text-xs text-fg-muted">
                <span className="text-fg">{entry.to}</span>
                {entry.from ? ` from ${entry.from}` : ''} ·{' '}
                {entry.by?.firstname ?? 'somebody'} · {formatDateTime(entry.at)}
                {entry.note ? ` — ${entry.note}` : ''}
              </p>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Modal
        open={Boolean(asking)}
        onClose={() => setAsking(null)}
        title={`Mark it ${asking?.label?.toLowerCase() ?? ''}`}
        description={
          asking?.to === 'declined'
            ? 'A reason is required. Six months of these is the most useful thing this section can tell you.'
            : 'Worth a moment: why we win is the half nobody writes down.'
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={asking?.to === 'declined' && !reason}
              onClick={() => move(asking.to, note.trim(), { reason, competitor: competitor.trim() })}
            >
              Confirm
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select
            label={asking?.to === 'declined' ? 'Why we lost it' : 'Why we won it'}
            required={asking?.to === 'declined'}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            options={(asking?.to === 'declined' ? LOSS_REASONS : WIN_REASONS).map((entry) => ({
              value: entry.value,
              label: entry.label,
            }))}
            placeholder="Pick one"
          />
          {reason === 'competitor' ? (
            <Input
              label="Who to"
              placeholder="The firm's name"
              hint="Counted, so the same three names showing up is something you get to see."
              value={competitor}
              onChange={(event) => setCompetitor(event.target.value)}
            />
          ) : null}
          <Textarea
            label="Anything else worth recording"
            rows={3}
            placeholder="They liked the report format but the lead time killed it."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
