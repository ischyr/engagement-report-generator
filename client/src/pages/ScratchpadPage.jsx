import { useEffect, useMemo, useState } from 'react';
import { NotebookPen, Pin, PinOff, Plus, Save, Send, Trash2 } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useUnsavedWork } from '../context/UnsavedContext.jsx';
import { cn, htmlToSnippet, timeAgo } from '../lib/utils.js';
import { saveShortcutLabel } from '../lib/keys.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { RichTextEditor } from '../components/editor/RichTextEditor.jsx';

/**
 * Your own notes, belonging to no engagement.
 *
 * The Notes tab is the record of what was tried on *that* target and goes with it. This is the
 * other half of a tester's memory: the payload that worked, a client's odd SSO behaviour worth
 * remembering next year, a half-formed idea at four in the afternoon. Until now that lived in
 * somebody's own text file outside the app, where it was neither searchable nor backed up nor
 * encrypted with everything else.
 *
 * Private, with no sharing flag — see the model for why. What makes a note public is moving it
 * onto an engagement, where it becomes an ordinary note, on the record and in the activity log.
 *
 * Searching is done here rather than on the server: a few hundred short notes filter faster in the
 * browser than a request per keystroke, and it means the search box works on the text you are
 * halfway through writing, which a server-side one would not.
 */
export default function ScratchpadPage() {
  const toast = useToast();
  const { data, loading, reload } = useResource('/scratch', { initial: { notes: [] } });
  const engagements = useResource('/audits', { initial: [] });

  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({ title: '', content: '', tags: [] });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [moving, setMoving] = useState(false);

  const notes = data?.notes ?? [];
  const selected = notes.find((note) => note._id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) {
      setDraft({ title: '', content: '', tags: [] });
      setDirty(false);
      return;
    }
    setDraft({ title: selected.title, content: selected.content, tags: selected.tags ?? [] });
    setDirty(false);
  }, [selectedId, selected?.updatedAt]);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.put(`/scratch/${selected._id}`, draft);
      setDirty(false);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  useUnsavedWork(dirty, 'This note', () => save());

  const create = async () => {
    try {
      const made = await api.post('/scratch', { title: 'Untitled', content: '' });
      await reload({ quiet: true });
      setSelectedId(made._id);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/scratch/${pendingDelete._id}`);
      if (selectedId === pendingDelete._id) setSelectedId(null);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Note deleted');
    } catch (error) {
      toast.fromError(error);
    }
  };

  const togglePin = async (note) => {
    try {
      await api.put(`/scratch/${note._id}`, { pinned: !note.pinned });
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const moveTo = async (auditId, keep) => {
    try {
      if (dirty) await save();
      const result = await api.post(`/scratch/${selected._id}/move`, { audit: auditId, keep });
      setMoving(false);
      await reload({ quiet: true });
      if (!keep) setSelectedId(null);
      toast.success(
        `Added to ${result.audit.name}`,
        keep ? 'Your copy stays here.' : 'It has left the scratchpad.'
      );
    } catch (error) {
      toast.fromError(error);
    }
  };

  /* Title, body text and tags, all lowercased once per note rather than per keystroke. */
  const haystacks = useMemo(
    () =>
      new Map(
        notes.map((note) => [
          note._id,
          `${note.title} ${htmlToSnippet(note.content, 4000)} ${(note.tags ?? []).join(' ')}`.toLowerCase(),
        ])
      ),
    [notes]
  );
  const needle = query.trim().toLowerCase();
  const visible = needle ? notes.filter((note) => haystacks.get(note._id)?.includes(needle)) : notes;

  if (loading) return <LoadingBlock label="Loading your notes…" />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Scratchpad"
        description="Yours, and nobody else's. Nothing here belongs to an engagement or reaches a report until you move it."
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={create}>
            New note
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card className="h-fit">
          <CardBody className="border-b border-line-soft">
            <Input
              placeholder="Search everything"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </CardBody>
          <CardBody className="max-h-[32rem] overflow-auto p-0">
            {visible.length ? (
              <ul className="divide-y divide-line-soft">
                {visible.map((note) => (
                  <li key={note._id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(note._id)}
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition hover:bg-white/[0.03]',
                        note._id === selectedId && 'bg-brand-500/10'
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
                        {note.pinned ? <Pin size={11} className="shrink-0 text-brand-300" /> : null}
                        {note.title || 'Untitled'}
                      </span>
                      <span className="truncate text-[0.6875rem] text-fg-subtle">
                        {htmlToSnippet(note.content, 60) || 'Empty'} · {timeAgo(note.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-fg-muted">
                {needle ? 'Nothing matches that.' : 'Nothing here yet.'}
              </p>
            )}
          </CardBody>
        </Card>

        {selected ? (
          <Card>
            <CardHeader
              title={
                <Input
                  value={draft.title}
                  placeholder="Untitled"
                  onChange={(event) => {
                    setDraft({ ...draft, title: event.target.value });
                    setDirty(true);
                  }}
                  className="h-8 border-0 bg-transparent px-0 text-sm font-semibold ring-0 focus:ring-0"
                  wrapperClassName="w-full"
                />
              }
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <span>edited {timeAgo(selected.updatedAt)}</span>
                  {dirty ? <Badge tone="warning">Unsaved</Badge> : null}
                  {selected.fromAudit ? <Badge tone="neutral">Shared to an engagement</Badge> : null}
                </span>
              }
              actions={
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={selected.pinned ? PinOff : Pin}
                    title={selected.pinned ? 'Unpin' : 'Pin to the top'}
                    onClick={() => togglePin(selected)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Send}
                    title="Put a copy on an engagement, where the team can see it"
                    onClick={() => setMoving(true)}
                  >
                    Move to an engagement
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    title="Delete"
                    className="hover:text-crit"
                    onClick={() => setPendingDelete(selected)}
                  />
                  <Button
                    variant={dirty ? 'primary' : 'ghost'}
                    size="sm"
                    icon={Save}
                    loading={saving}
                    disabled={!dirty}
                    title={`Save (${saveShortcutLabel()})`}
                    onClick={save}
                  >
                    {dirty ? 'Save' : 'Saved'}
                  </Button>
                </div>
              }
            />
            <CardBody>
              <RichTextEditor
                value={draft.content}
                onChange={(content) => {
                  setDraft((current) => ({ ...current, content }));
                  setDirty(true);
                }}
                placeholder="Paste it here. Nobody else can see this."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={NotebookPen}
              title="Nothing open"
              description="Pick a note, or start one. This is the place for the thing you will want on a different engagement tomorrow — a payload that worked, a client's quirk, an idea worth keeping."
              actionLabel="New note"
              actionIcon={Plus}
              onAction={create}
            />
          </Card>
        )}
      </div>

      <Modal
        open={moving}
        onClose={() => setMoving(false)}
        title="Move it to an engagement"
        description="It arrives as an ordinary note on that engagement's Notes tab — on the record, and visible to everybody on it."
      >
        <div className="max-h-80 overflow-auto">
          <ul className="divide-y divide-line-soft">
            {(engagements.data ?? [])
              .filter((audit) => audit.state !== 'APPROVED')
              .map((audit) => (
                <li key={audit._id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">{audit.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => moveTo(audit._id, true)}>
                    Copy
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => moveTo(audit._id, false)}>
                    Move
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Delete this note?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.title || 'Untitled'}" is only here. Nothing else has a copy.`}
      />
    </div>
  );
}
