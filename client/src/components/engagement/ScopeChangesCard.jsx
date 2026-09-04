import { useState } from 'react';
import { GitCompareArrows, Info, Plus, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

const KINDS = [
  { value: 'added', label: 'Added to scope' },
  { value: 'removed', label: 'Taken out of scope' },
  { value: 'clarified', label: 'Clarified' },
];

const KIND_LABEL = Object.fromEntries(KINDS.map((entry) => [entry.value, entry.label]));
const KIND_TONE = { added: 'success', removed: 'warning', clarified: 'neutral' };

const todayIso = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const BLANK = {
  kind: 'added',
  agreedOn: '',
  summary: '',
  targets: '',
  agreedByName: '',
  agreedByClient: '',
  channel: '',
  note: '',
};

/**
 * What the client agreed to change about the scope, and when.
 *
 * The scope above is the *end state*: whatever the hosts are on the day the report is
 * generated. So a host added on day three and another dropped on day four leave no trace, and
 * "you never tested X" has no answer but somebody's memory of a call. This is that answer, and
 * a template can print it as a table.
 */
export default function ScopeChangesCard({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/scope-changes`, {
    initial: null,
  });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const changes = data?.scopeChanges ?? [];

  /** The engagement's own contacts, since it is usually one of them who agreed it. */
  const contacts = (audit.recipients?.length ? audit.recipients : [audit.client].filter(Boolean))
    .filter(Boolean)
    .map((contact) => ({
      value: String(contact._id ?? contact),
      label: displayName(contact) || contact.email || 'A contact',
    }));

  const open = (change) => {
    if (change) {
      setForm({
        ...BLANK,
        ...change,
        _id: change._id,
        targets: (change.targets ?? []).join(', '),
        agreedByName: change.agreedBy?.name ?? '',
        agreedByClient: change.agreedBy?.client ? String(change.agreedBy.client) : '',
      });
      return;
    }
    setForm({ ...BLANK, agreedOn: todayIso() });
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        kind: form.kind,
        agreedOn: form.agreedOn,
        summary: form.summary,
        targets: form.targets
          .split(/[,\n]/)
          .map((entry) => entry.trim())
          .filter(Boolean),
        agreedBy: {
          client: form.agreedByClient || null,
          // The name is stored literally, so the record still reads correctly after a
          // contact is renamed or deleted.
          name:
            form.agreedByName ||
            contacts.find((contact) => contact.value === form.agreedByClient)?.label ||
            '',
        },
        channel: form.channel,
        note: form.note,
      };
      if (form._id) {
        await api.put(`/audits/${audit._id}/scope-changes/${form._id}`, payload);
      } else {
        await api.post(`/audits/${audit._id}/scope-changes`, payload);
      }
      setForm(null);
      await reload({ quiet: true });
      toast.success(form._id ? 'Scope change updated' : 'Scope change recorded');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/scope-changes/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Scope change removed',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading the scope changes…" />;

  return (
    <Card>
      <CardHeader
        icon={GitCompareArrows}
        title="What was agreed"
        description="Changes to the scope while testing was under way — what changed, when, and who agreed it. The scope above only shows where it ended up."
        actions={
          editable ? (
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => open(null)}>
              Record a change
            </Button>
          ) : null
        }
      />

      {changes.length === 0 ? (
        <EmptyState
          icon={GitCompareArrows}
          title="No changes recorded"
          description="If a host is added or dropped mid-engagement, record it here with the date and who agreed it. It is the answer to “you never tested that”, and a template can print it as a table."
          actionLabel={editable ? 'Record a change' : undefined}
          actionIcon={Plus}
          onAction={editable ? () => open(null) : undefined}
        />
      ) : (
        <Table>
          <THead>
            <TH width="9rem">Agreed</TH>
            <TH>What changed</TH>
            <TH>Agreed by</TH>
            <TH>Recorded by</TH>
            <TH width="5rem" />
          </THead>
          <TBody>
            {changes.map((change) => (
              <TR key={change._id}>
                <TD className="whitespace-nowrap">
                  <span className="block text-xs text-fg-muted">{formatDate(change.agreedOn)}</span>
                  <Badge tone={KIND_TONE[change.kind] ?? 'neutral'} className="mt-0.5">
                    {KIND_LABEL[change.kind] ?? change.kind}
                  </Badge>
                </TD>
                <TD className="max-w-md">
                  <span className="block text-xs text-fg">{change.summary}</span>
                  {change.targets?.length ? (
                    <span className="mt-0.5 block truncate font-mono text-[0.625rem] text-fg-subtle">
                      {change.targets.join(', ')}
                    </span>
                  ) : null}
                  {change.note ? (
                    <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                      {change.note}
                    </span>
                  ) : null}
                </TD>
                <TD className="whitespace-nowrap text-xs text-fg-muted">
                  {change.agreedBy?.name || '—'}
                  {change.channel ? (
                    <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                      {change.channel}
                    </span>
                  ) : null}
                </TD>
                <TD className="whitespace-nowrap text-xs text-fg-subtle">
                  {displayName(change.recordedBy) || 'somebody'}
                </TD>
                <TD align="right">
                  {editable ? (
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Info}
                        title="Edit this record"
                        onClick={() => open(change)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Remove this record"
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(change)}
                      />
                    </span>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?._id ? 'Edit a scope change' : 'Record a scope change'}
        description="What the client agreed, and when they agreed it — not when you got round to writing it down."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.agreedOn || !form?.summary?.trim()}
              onClick={save}
            >
              {form?._id ? 'Save' : 'Record it'}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="What kind of change"
              value={form.kind}
              options={KINDS}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            />
            <Input
              label="Agreed on"
              type="date"
              required
              value={form.agreedOn}
              onChange={(event) => setForm({ ...form, agreedOn: event.target.value })}
            />
            <Textarea
              label="What changed"
              required
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="The staging API host was brought into scope for the rest of the window."
              value={form.summary}
              onChange={(event) => setForm({ ...form, summary: event.target.value })}
            />
            <Input
              label="Hosts, URLs or ranges"
              wrapperClassName="sm:col-span-2"
              hint="Optional, comma separated. Some changes are a sentence rather than an address."
              placeholder="api-staging.acme.example, 10.0.5.0/24"
              value={form.targets}
              onChange={(event) => setForm({ ...form, targets: event.target.value })}
            />
            {contacts.length ? (
              <Select
                label="Agreed by"
                hint="Their name is stored as it is now, so the record still reads correctly later."
                value={form.agreedByClient}
                onChange={(event) =>
                  setForm({ ...form, agreedByClient: event.target.value, agreedByName: '' })
                }
                options={[{ value: '', label: 'Somebody else…' }, ...contacts]}
              />
            ) : null}
            {!form.agreedByClient ? (
              <Input
                label="Their name"
                placeholder="Dana Whitfield"
                value={form.agreedByName}
                onChange={(event) => setForm({ ...form, agreedByName: event.target.value })}
              />
            ) : null}
            <Input
              label="How"
              placeholder="Email, call, kick-off meeting"
              value={form.channel}
              onChange={(event) => setForm({ ...form, channel: event.target.value })}
            />
            <Textarea
              label="Note"
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="Anything the report should not say but the next tester should know."
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this record?"
        message={`"${pendingDelete?.summary}" — agreed ${
          pendingDelete ? formatDate(pendingDelete.agreedOn) : ''
        }. It disappears from the report's table of what was agreed.`}
        confirmLabel="Remove"
      />
    </Card>
  );
}
