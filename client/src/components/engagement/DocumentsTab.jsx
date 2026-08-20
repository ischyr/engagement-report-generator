import { useRef, useState } from 'react';
import { Download, FileUp, Paperclip, Pencil, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, downloadBlob, formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

const KIND_LABELS = {
  authorisation: 'Authorisation to test',
  scope: 'Scope document',
  contract: 'Contract or NDA',
  questionnaire: 'Completed questionnaire',
  'previous-report': 'A previous report',
  'asset-list': 'Asset list',
  correspondence: 'Correspondence',
  other: 'Other',
};

/** Authorisation is the one somebody goes looking for in a hurry. */
const KIND_TONE = { authorisation: 'success', contract: 'brand' };

const bytes = (size) => {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const BLANK = { kind: 'other', note: '', receivedFrom: '', receivedOn: '' };

/**
 * The paperwork the client sent us.
 *
 * The signed authorisation, the scope document, their asset spreadsheet, last year's report from
 * another firm. All of it arrives by email and lives in whoever's inbox received it — which is
 * fine until that person is on leave and somebody needs to prove testing was authorised.
 *
 * Deliberately not report content: these are the client's inputs, not our output, and nothing
 * here reaches a template.
 */
export default function DocumentsTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/documents`, {
    initial: null,
  });

  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState('');

  const documents = data?.documents ?? [];
  const kinds = (data?.kinds ?? []).map((kind) => ({
    value: kind,
    label: KIND_LABELS[kind] ?? kind,
  }));

  const choose = (file) => {
    if (!file) return;
    setPending(file);
    setForm({ ...BLANK, receivedOn: todayIso() });
  };

  const upload = async () => {
    setSaving(true);
    try {
      const body = new FormData();
      body.append('file', pending);
      body.append('kind', form.kind);
      body.append('note', form.note);
      body.append('receivedFrom', form.receivedFrom);
      body.append('receivedOn', form.receivedOn);

      await api.post(`/audits/${audit._id}/documents`, body);
      setPending(null);
      setForm(BLANK);
      if (fileRef.current) fileRef.current.value = '';
      await reload({ quiet: true });
      toast.success('Saved', 'It is kept with the engagement rather than in somebody’s inbox.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  /*
   * Fetched and saved rather than linked.
   *
   * An `<a href>` cannot send the access token, so a plain link would mean either a new
   * cookie surface or an unauthenticated route. This is the same path the report download
   * already takes.
   */
  const download = async (document_) => {
    setBusy(String(document_._id));
    try {
      const response = await api.raw(
        `/audits/${audit._id}/documents/${document_._id}/download`
      );
      downloadBlob(await response.blob(), document_.filename);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const saveMeta = async () => {
    setSaving(true);
    try {
      await api.put(`/audits/${audit._id}/documents/${editing._id}`, {
        kind: editing.kind,
        note: editing.note,
        receivedFrom: editing.receivedFrom,
        receivedOn: editing.receivedOn,
      });
      setEditing(null);
      await reload({ quiet: true });
      toast.success('Updated');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/audits/${audit._id}/documents/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Removed', 'The file is gone from storage too.');
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading the documents…" />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={Paperclip}
          title="From the client"
          description="The authorisation, the scope document, their asset list, anything they sent. Kept with the engagement so it is still here when whoever received the email is not."
          actions={
            editable ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => choose(event.target.files?.[0])}
                />
                <Button
                  variant="primary"
                  size="sm"
                  icon={FileUp}
                  onClick={() => fileRef.current?.click()}
                >
                  Add a document
                </Button>
              </>
            ) : null
          }
        />

        {documents.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            title="Nothing filed yet"
            description="The signed authorisation is the one worth having here: it is the document somebody asks for at short notice, and the only copy is usually in an inbox."
            actionLabel={editable ? 'Add a document' : undefined}
            actionIcon={FileUp}
            onAction={editable ? () => fileRef.current?.click() : undefined}
          />
        ) : (
          <CardBody className="flex flex-col gap-1.5">
            {documents.map((document_) => (
              <div
                key={document_._id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">
                      {document_.filename}
                    </span>
                    <Badge tone={KIND_TONE[document_.kind] ?? 'neutral'}>
                      {KIND_LABELS[document_.kind] ?? document_.kind}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-fg-muted">
                    {[
                      document_.receivedFrom ? `from ${document_.receivedFrom}` : '',
                      document_.receivedOn ? formatDate(document_.receivedOn) : '',
                      bytes(document_.bytes),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {document_.note ? (
                    <span className="mt-0.5 block text-[0.625rem] leading-relaxed text-fg-subtle">
                      {document_.note}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                    Filed by {displayName(document_.uploadedBy) || 'somebody'}{' '}
                    {timeAgo(document_.createdAt)}
                    {document_.downloads
                      ? ` · downloaded ${document_.downloads} time${
                          document_.downloads === 1 ? '' : 's'
                        }, last by ${displayName(document_.lastDownloadBy) || 'somebody'}`
                      : ''}
                  </span>
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  icon={Download}
                  loading={busy === String(document_._id)}
                  onClick={() => download(document_)}
                >
                  Download
                </Button>
                {editable ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Pencil}
                      title="Edit what this is"
                      onClick={() => setEditing({ ...BLANK, ...document_ })}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Remove it"
                      className="hover:text-crit"
                      onClick={() => setPendingDelete(document_)}
                    />
                  </>
                ) : null}
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      {/* Asked once, when the file is chosen — filing it without saying what it is loses the point. */}
      <Modal
        open={Boolean(pending)}
        onClose={() => {
          setPending(null);
          if (fileRef.current) fileRef.current.value = '';
        }}
        title="What is this?"
        description={pending ? `${pending.name} · ${bytes(pending.size)}` : ''}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setPending(null);
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={upload}>
              Save it
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="What kind of document"
            value={form.kind}
            options={kinds}
            onChange={(event) => setForm({ ...form, kind: event.target.value })}
          />
          <Input
            label="Received on"
            type="date"
            value={form.receivedOn}
            onChange={(event) => setForm({ ...form, receivedOn: event.target.value })}
          />
          <Input
            label="Who sent it"
            placeholder="Dana Whitfield"
            wrapperClassName="sm:col-span-2"
            hint="Kept as you write it, so the record still reads correctly if a contact changes."
            value={form.receivedFrom}
            onChange={(event) => setForm({ ...form, receivedFrom: event.target.value })}
          />
          <Textarea
            label="Note"
            rows={2}
            wrapperClassName="sm:col-span-2"
            placeholder="Signed by their CISO, covers the external range only."
            value={form.note}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit this document"
        description={editing?.filename}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={saveMeta}>
              Save
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="What kind of document"
              value={editing.kind}
              options={kinds}
              onChange={(event) => setEditing({ ...editing, kind: event.target.value })}
            />
            <Input
              label="Received on"
              type="date"
              value={editing.receivedOn ?? ''}
              onChange={(event) => setEditing({ ...editing, receivedOn: event.target.value })}
            />
            <Input
              label="Who sent it"
              wrapperClassName="sm:col-span-2"
              value={editing.receivedFrom ?? ''}
              onChange={(event) => setEditing({ ...editing, receivedFrom: event.target.value })}
            />
            <Textarea
              label="Note"
              rows={2}
              wrapperClassName="sm:col-span-2"
              value={editing.note ?? ''}
              onChange={(event) => setEditing({ ...editing, note: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this document?"
        message={`"${pendingDelete?.filename}" and its stored copy are both deleted. If it is the only copy of an authorisation, get another one first.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
