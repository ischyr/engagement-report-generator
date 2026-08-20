import { useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  CircleAlert,
  FileCheck2,
  Fingerprint,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import RenderHistory from './RenderHistory.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDateTime, sha256OfFile, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'portal', label: 'Client portal' },
  { value: 'share', label: 'Shared drive or file transfer' },
  { value: 'person', label: 'In person' },
  { value: 'other', label: 'Something else' },
];

const CHANNEL_LABEL = Object.fromEntries(CHANNELS.map((entry) => [entry.value, entry.label]));

const HEX64 = /^[a-f0-9]{64}$/i;

/** `datetime-local` wants `yyyy-MM-ddTHH:mm` in local time, with no zone on the end. */
function localInputValue(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/* Hashing lives in lib/utils.js now: the render history asks the same question of the same code. */
const sha256 = sha256OfFile;

const bytes = (size) => {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const BLANK = {
  version: '',
  sentAt: '',
  channel: 'email',
  recipients: [],
  filename: '',
  fileHash: '',
  fileSize: null,
  kind: '',
  note: '',
};

/**
 * What was sent, to whom, and which file exactly.
 *
 * The app could say what a report contained and who was *meant* to get it; it could not say
 * anything was sent. This is the record — version, moment, recipients, and the SHA-256 of
 * the file — so "which version does the client actually have" has an answer six months
 * later, and a file somebody produces in an argument can be checked against it.
 */
export default function DeliveryTab({ audit, editable, lastGenerated }) {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/deliveries`, {
    initial: null,
  });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hashing, setHashing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  /** The result of checking a file against the record: { name, hash, match }. */
  const [checked, setChecked] = useState(null);
  const checkInput = useRef(null);
  const formInput = useRef(null);

  const deliveries = data?.deliveries ?? [];
  const me = String(user?.id ?? user?._id ?? '');
  const mayRemove = isAdmin || String(audit.creator?._id ?? audit.creator ?? '') === me;

  /** The engagement's own contact list, primary first — usually the whole answer. */
  const contacts = useMemo(() => {
    const list = audit.recipients?.length ? audit.recipients : [audit.client].filter(Boolean);
    return list.filter(Boolean).map((contact) => ({
      client: String(contact._id ?? contact),
      name: displayName(contact) || '',
      email: contact.email ?? '',
    }));
  }, [audit.recipients, audit.client]);

  const open = (delivery) => {
    setChecked(null);
    if (delivery) {
      setForm({
        ...BLANK,
        ...delivery,
        _id: delivery._id,
        sentAt: localInputValue(new Date(delivery.sentAt)),
      });
      return;
    }
    /*
     * A new record starts from the file this browser just downloaded, when there is one.
     * The alternative is retyping a 64-character hash, which nobody does twice — and the
     * value is the digest of exactly the bytes the server sent, not of whatever is sitting
     * in a downloads folder.
     */
    setForm({
      ...BLANK,
      version: data?.suggestedVersion ?? '',
      sentAt: localInputValue(),
      recipients: contacts,
      filename: lastGenerated?.filename ?? '',
      fileHash: lastGenerated?.hash ?? '',
      fileSize: lastGenerated?.size ?? null,
      kind: lastGenerated?.kind ?? 'docx',
      _fromGenerated: Boolean(lastGenerated?.hash),
    });
  };

  const hashInto = async (file, onDone) => {
    setHashing(true);
    try {
      const hash = await sha256(file);
      onDone(hash, file);
    } catch (error) {
      toast.fromError(
        error.message === 'insecure-context'
          ? new Error(
              'This browser will only hash files on a secure connection. Paste the hash instead — `Get-FileHash file.docx` on Windows, `sha256sum` elsewhere.'
            )
          : error
      );
    } finally {
      setHashing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        version: form.version,
        sentAt: form.sentAt,
        channel: form.channel,
        recipients: form.recipients.map((entry) => ({
          client: entry.client || null,
          name: entry.name,
          email: entry.email,
        })),
        filename: form.filename,
        fileHash: form.fileHash,
        fileSize: form.fileSize ?? null,
        kind: form.kind,
        note: form.note,
      };
      if (form._id) await api.put(`/audits/${audit._id}/deliveries/${form._id}`, payload);
      else await api.post(`/audits/${audit._id}/deliveries`, payload);
      setForm(null);
      await reload({ quiet: true });
      toast.success(form._id ? 'Delivery record updated' : 'Delivery recorded');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/audits/${audit._id}/deliveries/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Delivery record removed');
    } catch (error) {
      toast.fromError(error);
    }
  };

  /** Checks a file against every record — the reason for storing a hash at all. */
  const check = (file) => {
    if (!file) return;
    hashInto(file, (hash) => {
      const match = deliveries.find((delivery) => delivery.fileHash === hash);
      setChecked({ name: file.name, hash, match: match ?? null });
    });
  };

  if (loading && !data) return <LoadingBlock label="Reading the delivery record…" />;

  return (
    <div className="flex flex-col gap-4">
      {/* A report was generated in this session and not yet recorded: the moment to offer it. */}
      {editable && lastGenerated?.hash && !deliveries.some((d) => d.fileHash === lastGenerated.hash) ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-500/25 bg-brand-500/[0.06] px-4 py-3">
          <FileCheck2 size={15} className="shrink-0 text-brand-300" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
            You generated <span className="text-fg">{lastGenerated.filename}</span>{' '}
            {timeAgo(lastGenerated.at)} and it has not been recorded as sent. Its hash is already
            known, so recording it is one form.
          </p>
          <Button variant="primary" size="sm" icon={Send} onClick={() => open(null)}>
            Record it as sent
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon={Send}
          title="Delivery record"
          description="Every version of this report that left the building: when, to whom, and the SHA-256 of the exact file. Nothing here is automatic — a report is sent by a person, so a person records it."
          actions={
            editable ? (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => open(null)}>
                Record a delivery
              </Button>
            ) : null
          }
        />

        {deliveries.length === 0 ? (
          <EmptyState
            icon={Send}
            title="Nothing recorded as sent"
            description="Record each version as it goes out and this becomes the answer to “which report does the client actually have”, months later, with a hash that settles it. A template can print the same table as document control."
            actionLabel={editable ? 'Record a delivery' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => open(null) : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH width="5rem">Version</TH>
              <TH>Sent</TH>
              <TH>To</TH>
              <TH>File</TH>
              <TH>Recorded by</TH>
              <TH width="5rem" />
            </THead>
            <TBody>
              {deliveries.map((delivery) => (
                <TR key={delivery._id}>
                  <TD className="whitespace-nowrap font-mono text-xs text-fg">
                    {delivery.version || '—'}
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDateTime(delivery.sentAt)}
                    <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                      {CHANNEL_LABEL[delivery.channel] ?? delivery.channel}
                    </span>
                  </TD>
                  <TD className="max-w-xs">
                    {delivery.recipients.length ? (
                      <span className="flex flex-col gap-0.5">
                        {delivery.recipients.map((entry, index) => (
                          <span
                            key={`${entry.email}-${index}`}
                            className="truncate text-xs text-fg-muted"
                          >
                            {entry.name || entry.email}
                            {entry.name && entry.email ? (
                              <span className="text-fg-subtle"> · {entry.email}</span>
                            ) : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-xs text-fg-subtle">not recorded</span>
                    )}
                  </TD>
                  <TD className="max-w-xs">
                    <span className="block truncate text-xs text-fg-muted">
                      {delivery.filename || '—'}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[0.625rem] text-fg-subtle">
                      {delivery.fileHash ? (
                        <>
                          <Fingerprint size={10} className="shrink-0" />
                          <span className="font-mono" title={`sha256:${delivery.fileHash}`}>
                            {delivery.fileHash.slice(0, 16)}…
                          </span>
                        </>
                      ) : (
                        <span className="text-med">no hash recorded</span>
                      )}
                      {delivery.fileSize ? <span>{bytes(delivery.fileSize)}</span> : null}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-subtle">
                    {displayName(delivery.sentBy) || 'somebody'}
                    <span className="mt-0.5 block text-[0.625rem]">
                      {timeAgo(delivery.createdAt)}
                    </span>
                  </TD>
                  <TD align="right">
                    <span className="flex items-center justify-end gap-1">
                      {editable ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Pencil}
                          title="Correct this record"
                          onClick={() => open(delivery)}
                        />
                      ) : null}
                      {editable && mayRemove ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Remove this record"
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(delivery)}
                        />
                      ) : null}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {deliveries.some((delivery) => delivery.note) ? (
          <CardBody className="flex flex-col gap-1.5 border-t border-line-soft">
            {deliveries
              .filter((delivery) => delivery.note)
              .map((delivery) => (
                <p key={`${delivery._id}-note`} className="text-[0.6875rem] text-fg-subtle">
                  <span className="font-mono text-fg-muted">{delivery.version || '—'}</span>{' '}
                  {delivery.note}
                </p>
              ))}
          </CardBody>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------- verifying */}
      {deliveries.some((delivery) => delivery.fileHash) ? (
        <Card>
          <CardHeader
            icon={BadgeCheck}
            title="Check a file against the record"
            description="Somebody produces a document and says this is what you sent us. Drop it here: it is hashed in your browser, never uploaded, and matched against the versions above."
          />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={checkInput}
                type="file"
                className="hidden"
                onChange={(event) => check(event.target.files?.[0])}
              />
              <Button
                variant="secondary"
                size="sm"
                icon={Upload}
                loading={hashing}
                onClick={() => checkInput.current?.click()}
              >
                Choose a file
              </Button>
              {checked ? (
                <span className="font-mono text-[0.625rem] text-fg-subtle">
                  sha256 {checked.hash.slice(0, 24)}…
                </span>
              ) : null}
            </div>

            {checked ? (
              checked.match ? (
                <p className="flex items-start gap-2 rounded-lg border border-low/25 bg-low/[0.06] px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
                  <BadgeCheck size={14} className="mt-0.5 shrink-0 text-low" />
                  <span>
                    <span className="text-fg">{checked.name}</span> is byte-for-byte the file
                    recorded as version{' '}
                    <span className="font-mono text-fg">{checked.match.version || '—'}</span>, sent{' '}
                    {formatDateTime(checked.match.sentAt)}
                    {checked.match.recipients.length
                      ? ` to ${checked.match.recipients
                          .map((entry) => entry.name || entry.email)
                          .join(', ')}`
                      : ''}
                    .
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
                  <CircleAlert size={14} className="mt-0.5 shrink-0 text-med" />
                  <span>
                    <span className="text-fg">{checked.name}</span> does not match any recorded
                    delivery. It may be a version that was never recorded, an edited copy, or a
                    file that was re-saved — Word rewrites a document on open-and-save even when
                    nothing was typed, which changes the hash without changing a word.
                  </span>
                </p>
              )
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* --------------------------------------------------------------- form */}
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?._id ? 'Correct a delivery record' : 'Record a delivery'}
        description="What actually left the building. The hash is what makes this evidence rather than a note — attach the file you sent and it is computed here, without uploading it."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.sentAt || (Boolean(form?.fileHash) && !HEX64.test(form.fileHash))}
              onClick={save}
            >
              {form?._id ? 'Save' : 'Record it'}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {form._fromGenerated ? (
              <p className="sm:col-span-2 flex items-start gap-2 rounded-lg border border-brand-500/25 bg-brand-500/[0.06] px-3 py-2 text-[0.6875rem] leading-relaxed text-fg-muted">
                <FileCheck2 size={13} className="mt-0.5 shrink-0 text-brand-300" />
                Filled in from the report you generated in this session — the hash is of the exact
                bytes the server produced.
              </p>
            ) : null}

            <Input
              label="Version"
              placeholder="1.0"
              hint="Whatever the client knows it by. Suggested from the last one recorded."
              value={form.version}
              onChange={(event) => setForm({ ...form, version: event.target.value })}
            />
            <Input
              label="Sent at"
              type="datetime-local"
              required
              hint="When it went, not when you are typing this."
              value={form.sentAt}
              onChange={(event) => setForm({ ...form, sentAt: event.target.value })}
            />
            <Select
              label="How"
              value={form.channel}
              options={CHANNELS}
              onChange={(event) => setForm({ ...form, channel: event.target.value })}
            />
            <Input
              label="Format"
              placeholder="docx"
              hint="What you actually handed over: docx, pdf, xlsx."
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            />

            {/* Recipients: the engagement's contacts as toggles, plus anybody else by hand. */}
            <div className="sm:col-span-2 flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-muted">Who it went to</span>
              {contacts.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {contacts.map((contact) => {
                    const on = form.recipients.some((entry) => entry.client === contact.client);
                    return (
                      <button
                        key={contact.client}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setForm({
                            ...form,
                            recipients: on
                              ? form.recipients.filter((entry) => entry.client !== contact.client)
                              : [...form.recipients, contact],
                          })
                        }
                        className={
                          on
                            ? 'flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-2 py-1 text-xs text-brand-300 ring-1 ring-brand-500/30'
                            : 'flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1 text-xs text-fg-muted ring-1 ring-line-soft transition hover:text-fg'
                        }
                      >
                        <Mail size={11} />
                        {contact.name || contact.email}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[0.6875rem] text-fg-subtle">
                  This engagement has no contacts recorded, so add the addresses by hand.
                </p>
              )}

              {/* Anybody off the contact list — a procurement mailbox, an auditor. */}
              {form.recipients
                .filter((entry) => !entry.client)
                .map((entry, index) => (
                  <div key={`extra-${index}`} className="flex items-center gap-2">
                    <Input
                      wrapperClassName="flex-1"
                      placeholder="Name (optional)"
                      value={entry.name}
                      onChange={(event) => {
                        const next = [...form.recipients];
                        const at = next.indexOf(entry);
                        next[at] = { ...entry, name: event.target.value };
                        setForm({ ...form, recipients: next });
                      }}
                    />
                    <Input
                      wrapperClassName="flex-1"
                      placeholder="email@example.com"
                      value={entry.email}
                      onChange={(event) => {
                        const next = [...form.recipients];
                        const at = next.indexOf(entry);
                        next[at] = { ...entry, email: event.target.value };
                        setForm({ ...form, recipients: next });
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Remove"
                      className="hover:text-crit"
                      onClick={() =>
                        setForm({
                          ...form,
                          recipients: form.recipients.filter((other) => other !== entry),
                        })
                      }
                    />
                  </div>
                ))}
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                className="self-start"
                onClick={() =>
                  setForm({
                    ...form,
                    recipients: [...form.recipients, { client: null, name: '', email: '' }],
                  })
                }
              >
                Somebody else
              </Button>
            </div>

            {/* ------------------------------------------------------- the file */}
            <Input
              label="Filename"
              wrapperClassName="sm:col-span-2"
              placeholder="Acme — Web Application Assessment v1.0.docx"
              value={form.filename}
              onChange={(event) => setForm({ ...form, filename: event.target.value })}
            />
            <div className="sm:col-span-2 flex flex-col gap-2">
              <Input
                label="SHA-256 of the file"
                placeholder="64 hexadecimal characters"
                error={
                  form.fileHash && !HEX64.test(form.fileHash)
                    ? 'A SHA-256 hash is 64 hexadecimal characters'
                    : undefined
                }
                hint="Attach the file you sent to compute it here, or paste it: Get-FileHash on Windows, sha256sum elsewhere."
                className="font-mono text-xs"
                value={form.fileHash}
                onChange={(event) =>
                  setForm({ ...form, fileHash: event.target.value.trim().toLowerCase() })
                }
              />
              <div className="flex items-center gap-3">
                <input
                  ref={formInput}
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    hashInto(file, (hash) =>
                      setForm((current) => ({
                        ...current,
                        fileHash: hash,
                        filename: current.filename || file.name,
                        fileSize: file.size,
                        _fromGenerated: false,
                      }))
                    );
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Upload}
                  loading={hashing}
                  onClick={() => formInput.current?.click()}
                >
                  Hash the file you sent
                </Button>
                <span className="text-[0.6875rem] text-fg-subtle">
                  It is read in your browser and never uploaded.
                </span>
              </div>
            </div>

            <Textarea
              label="Note"
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="Draft for technical review · resent after a bounce · final, post-retest"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      {/*
        What produced each document, under the record of what was sent.
        The two are different questions — most renders are never sent — and this is the one that
        answers "the last report had a table of contents, did it?".
      */}
      <RenderHistory audit={audit} />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this delivery record?"
        message={`Version ${pendingDelete?.version || '—'}, sent ${
          pendingDelete ? formatDateTime(pendingDelete.sentAt) : ''
        }. Removing it removes the evidence that this version was ever sent, and the removal is written to the activity log.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
