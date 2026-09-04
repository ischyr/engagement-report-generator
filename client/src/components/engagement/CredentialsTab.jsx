import { useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

const BLANK = { label: '', username: '', secret: '', url: '', notes: '', expiresAt: '' };

/** Options that are easier to mean than a date picker, since most are relative. */
const EXPIRY = [
  { value: '', label: 'until it is deleted' },
  { value: '7', label: 'in 7 days' },
  { value: '30', label: 'in 30 days' },
  { value: '90', label: 'in 90 days' },
];

const inDays = (days) =>
  days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null;

/**
 * The client's credentials, for the length of the engagement.
 *
 * These used to live in **notes** — plaintext in the database, in every backup, for ever.
 * Here they are encrypted at rest, they can be set to expire, revealing one is recorded in
 * the activity log, and the whole set can be purged the moment the job is over.
 */
export default function CredentialsTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/credentials`, {
    initial: null,
  });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [purging, setPurging] = useState(false);
  /** Secrets revealed in this tab, held in memory and never written anywhere. */
  const [shown, setShown] = useState({});

  const enabled = data?.enabled ?? false;
  const credentials = data?.credentials ?? [];

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        label: form.label,
        username: form.username,
        url: form.url,
        notes: form.notes,
        ...(form.secret ? { secret: form.secret } : {}),
        ...(form._id ? {} : { expiresAt: inDays(form.expiresAt) }),
      };
      if (form._id) await api.put(`/audits/${audit._id}/credentials/${form._id}`, payload);
      else await api.post(`/audits/${audit._id}/credentials`, payload);
      setForm(null);
      await reload({ quiet: true });
      toast.success(form._id ? 'Credential updated' : 'Credential stored');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (credential) => {
    if (shown[credential._id]) {
      setShown((current) => ({ ...current, [credential._id]: undefined }));
      return;
    }
    try {
      const result = await api.post(
        `/audits/${audit._id}/credentials/${credential._id}/reveal`,
        {}
      );
      setShown((current) => ({ ...current, [credential._id]: result.secret }));
      // Reloaded so the access trail on screen matches the one just written.
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const copy = async (credential) => {
    try {
      const secret =
        shown[credential._id] ??
        (await api.post(`/audits/${audit._id}/credentials/${credential._id}/reveal`, {})).secret;
      await navigator.clipboard.writeText(secret);
      toast.success('Copied', 'Clear your clipboard when you are done with it.');
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const remove = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/credentials/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Credential deleted',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const purge = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/credentials`);
      setPurging(false);
      setShown({});
      await reload({ quiet: true });
      toast.success(`${result.removed} credential(s) deleted`, 'Nothing borrowed was kept.');
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Loading credentials…" />;

  return (
    <div className="flex flex-col gap-4">
      {/* The vault needs a key, and a page that fails on save would not say why. */}
      {!enabled ? (
        <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-4 py-3 text-xs leading-relaxed text-fg-muted">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-med" />
          <span>{data?.disabledReason}</span>
        </p>
      ) : null}

      {/* Sign-off means the job is done, which is when borrowed credentials should go. */}
      {audit.state === 'APPROVED' && credentials.length ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-500/25 bg-brand-500/[0.06] px-4 py-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
            This engagement is signed off and still holds {credentials.length} credential
            {credentials.length === 1 ? '' : 's'}. They belonged to the client for the length of
            the job.
          </p>
          {editable ? (
            <Button variant="danger" size="sm" icon={Trash2} onClick={() => setPurging(true)}>
              Purge them
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon={KeyRound}
          title="Credentials"
          description="Test accounts, keys and VPN details the client provided. Encrypted at rest, never part of a report, and every reveal is in the activity log."
          actions={
            editable && enabled ? (
              <div className="flex items-center gap-2">
                {credentials.length ? (
                  <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setPurging(true)}>
                    Purge all
                  </Button>
                ) : null}
                <Button variant="primary" size="sm" icon={Plus} onClick={() => setForm({ ...BLANK })}>
                  Add
                </Button>
              </div>
            ) : null
          }
        />

        {credentials.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="Nothing stored"
            description="Anything the client lent you to do the job — a test account, an API key, a VPN profile — belongs here rather than in a note. Notes are plaintext and permanent; these are encrypted and can expire."
            actionLabel={editable && enabled ? 'Add one' : undefined}
            actionIcon={Plus}
            onAction={editable && enabled ? () => setForm({ ...BLANK }) : undefined}
          />
        ) : (
          <CardBody className="flex flex-col gap-1.5">
            {credentials.map((credential) => (
              <div
                key={credential._id}
                className="flex flex-col gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">
                        {credential.label}
                      </span>
                      {credential.expiresAt ? (
                        <Badge tone="neutral" title={formatDateTime(credential.expiresAt)}>
                          expires {timeAgo(credential.expiresAt)}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-muted">
                      {[credential.username, credential.url].filter(Boolean).join(' · ') ||
                        'no username recorded'}
                    </span>
                  </span>

                  <Button
                    variant="ghost"
                    size="sm"
                    icon={shown[credential._id] ? EyeOff : Eye}
                    onClick={() => reveal(credential)}
                  >
                    {shown[credential._id] ? 'Hide' : 'Reveal'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Copy}
                    title="Copy the secret"
                    onClick={() => copy(credential)}
                  />
                  {editable ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Pencil}
                        title="Edit"
                        onClick={() =>
                          setForm({
                            ...BLANK,
                            ...credential,
                            secret: '',
                            expiresAt: '',
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Delete"
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(credential)}
                      />
                    </>
                  ) : null}
                </div>

                {shown[credential._id] ? (
                  <p className="rounded-md bg-canvas px-2.5 py-2 font-mono text-xs break-all text-fg ring-1 ring-line">
                    {shown[credential._id]}
                  </p>
                ) : null}

                {credential.notes ? (
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
                    {credential.notes}
                  </p>
                ) : null}

                <p className="flex flex-wrap items-center gap-x-3 text-[0.625rem] text-fg-subtle">
                  <span>
                    Added by {displayName(credential.createdBy) || 'somebody'}{' '}
                    {timeAgo(credential.createdAt)}
                  </span>
                  {credential.reveals ? (
                    <span>
                      Revealed {credential.reveals} time{credential.reveals === 1 ? '' : 's'} · last
                      by {displayName(credential.lastRevealedBy) || 'somebody'}{' '}
                      {timeAgo(credential.lastRevealedAt)}
                    </span>
                  ) : (
                    <span>Never revealed</span>
                  )}
                </p>
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?._id ? 'Edit credential' : 'Store a credential'}
        description="The secret is encrypted before it is written. Everything else stays readable so the list is usable."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.label?.trim() || (!form?._id && !form?.secret)}
              onClick={save}
            >
              {form?._id ? 'Save' : 'Store it'}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="What is it"
              required
              placeholder="VPN account, staging admin, API key…"
              wrapperClassName="sm:col-span-2"
              value={form.label}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
            />
            <Input
              label="Username"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
            />
            <Input
              label="Where it is used"
              placeholder="https://staging.acme.example"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
            />
            <Input
              label={form._id ? 'New secret' : 'Secret'}
              type="password"
              autoComplete="new-password"
              required={!form._id}
              hint={form._id ? 'Leave empty to keep the current one.' : undefined}
              wrapperClassName="sm:col-span-2"
              value={form.secret}
              onChange={(event) => setForm({ ...form, secret: event.target.value })}
            />
            {!form._id ? (
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium text-fg-muted">Delete it automatically</span>
                <select
                  value={form.expiresAt}
                  onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                  className="h-9.5 rounded-lg bg-canvas/60 px-3 text-sm text-fg ring-1 ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none"
                >
                  {EXPIRY.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="text-[0.6875rem] text-fg-subtle">
                  The database removes it on its own, so this does not rely on anybody
                  remembering.
                </span>
              </label>
            ) : null}
            <Textarea
              label="Notes"
              rows={2}
              placeholder="Which environment, who provided it, anything about how it behaves."
              wrapperClassName="sm:col-span-2"
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Delete this credential?"
        message={`"${pendingDelete?.label}" is gone for good — there is no trash for secrets.`}
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={purging}
        onClose={() => setPurging(false)}
        onConfirm={purge}
        title="Purge every credential?"
        message={`All ${credentials.length} will be deleted permanently. Do this when the engagement is finished — they were the client's, not yours.`}
        confirmLabel="Purge them"
      />
    </div>
  );
}
