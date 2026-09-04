import { useEffect, useMemo, useState } from 'react';
import { Bug, NotebookPen, Pin, PinOff, Plus, Save, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { saveShortcutLabel } from '../../lib/keys.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useUnsaved, useUnsavedWork } from '../../context/UnsavedContext.jsx';
import { cn, displayName, htmlToSnippet, timeAgo } from '../../lib/utils.js';
import { announceMentions } from '../../lib/mentions.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Field.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import ConflictDialog from '../ui/ConflictDialog.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Badge } from '../ui/Badge.jsx';
import { RichTextEditor } from '../editor/RichTextEditor.jsx';

/**
 * Working notes for an engagement: command output, credentials to try, leads not
 * yet worth writing up.
 *
 * These are internal. The server strips them from report data, so nothing here can
 * end up in a client deliverable — which is what makes it safe to paste anything.
 */
export default function NotesTab({ audit, editable, onOpenFinding }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/notes`, { initial: [] });

  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({ title: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [conflict, setConflict] = useState(null);
  /** The note waiting on a "write this up" confirmation, and whether it is in flight. */
  const [pendingPromote, setPendingPromote] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const { guard } = useUnsaved();

  useUnsavedWork(dirty, 'This note', () => save());

  const notes = useMemo(() => {
    const list = Array.isArray(data) ? [...data] : [];
    // Pinned first, then by explicit order (newest note has the lowest order).
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.order ?? 0) - (b.order ?? 0));
    return list;
  }, [data]);

  const selected = notes.find((n) => n._id === selectedId) ?? null;

  // Open the first note automatically; there is nothing else to look at.
  useEffect(() => {
    if (!selectedId && notes.length) setSelectedId(notes[0]._id);
  }, [notes, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setDraft({ title: selected.title ?? '', content: selected.content ?? '' });
    setDirty(false);
  }, [selected?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const note = await api.post(`/audits/${audit._id}/notes`, { title: 'Untitled note' });
      await reload({ quiet: true });
      setSelectedId(note._id);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const save = async ({ force = false } = {}) => {
    if (!selected) return;
    setSaving(true);
    try {
      const saved = await api.put(`/audits/${audit._id}/notes/${selected._id}`, {
        ...draft,
        // Two people in the same note is common; refuse a stale write rather than
        // silently replacing whatever they typed.
        ...(selected.updatedAt && !force ? { expectedUpdatedAt: selected.updatedAt } : {}),
      });
      announceMentions(toast, saved);
      setConflict(null);
      setDirty(false);
      await reload({ quiet: true });
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const takeTheirs = async () => {
    if (conflict) setDraft({ title: conflict.title ?? '', content: conflict.content ?? '' });
    setConflict(null);
    setDirty(false);
    await reload({ quiet: true });
    toast.info('Loaded the saved version', 'Your unsaved changes were discarded.');
  };

  const togglePin = async (note) => {
    try {
      await api.put(`/audits/${audit._id}/notes/${note._id}`, { pinned: !note.pinned });
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  /**
   * Turns the note into a finding, keeping the note.
   *
   * Saves first if there are unsaved edits: promoting the version on the server while the
   * newer text sits in the editor would write up the wrong thing, which is precisely the
   * mistake copy-and-paste already made.
   */
  const promote = async () => {
    const note = pendingPromote;
    if (!note) return;
    setPromoting(true);
    try {
      if (dirty && note._id === selected?._id) await save();
      const result = await api.post(
        `/audits/${audit._id}/notes/${note._id}/promote`,
        { title: (dirty ? draft.title : note.title) || undefined }
      );
      setPendingPromote(null);
      await reload({ quiet: true });
      toast.withAction(
        'Written up as a finding',
        `"${result?.finding?.title ?? 'The finding'}" is on the Findings tab. The note stays here.`,
        { label: 'Open it', onClick: () => onOpenFinding?.(result?.finding?._id) }
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setPromoting(false);
    }
  };

  const confirmDelete = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/notes/${pendingDelete._id}`);
      if (selectedId === pendingDelete._id) setSelectedId(null);
      setPendingDelete(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Note deleted',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading) return <LoadingBlock label="Loading notes…" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          Internal working notes. Never included in a generated report.
        </p>
        {editable ? (
          <Button variant="primary" size="sm" icon={Plus} onClick={create}>
            New note
          </Button>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <Card>
          <EmptyState
            icon={NotebookPen}
            title="No notes yet"
            description="Somewhere to keep command output, credentials and half-formed leads while you test. Nothing here reaches the report."
            actionLabel={editable ? 'New note' : undefined}
            actionIcon={Plus}
            onAction={editable ? create : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <Card className="h-fit overflow-hidden">
            <ul className="divide-y divide-line-soft">
              {notes.map((note) => (
                <li key={note._id}>
                  <button
                    type="button"
                    onClick={() => guard(() => setSelectedId(note._id))}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2.5 text-left transition',
                      note._id === selectedId ? 'bg-brand-500/10' : 'hover:bg-white/[0.035]'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {note.pinned ? <Pin size={11} className="shrink-0 text-med" /> : null}
                        <span
                          className={cn(
                            'truncate text-xs font-medium',
                            note._id === selectedId ? 'text-brand-300' : 'text-fg'
                          )}
                        >
                          {note.title || 'Untitled note'}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                        {htmlToSnippet(note.content, 40) || 'Empty'}
                      </span>
                      {/* So two people reading the same scratchpad do not write the same
                          lead up twice. */}
                      {note.promotedTo ? (
                        <span className="mt-1 inline-flex items-center gap-1 text-[0.5625rem] text-low">
                          <Bug size={9} />
                          written up
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selected ? (
            <Card>
              <CardHeader
                title={
                  <Input
                    value={draft.title}
                    disabled={!editable}
                    placeholder="Note title"
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
                    {selected.author ? <span>{displayName(selected.author)}</span> : null}
                    <span>· edited {timeAgo(selected.updatedAt)}</span>
                    {dirty ? <Badge tone="warning">Unsaved</Badge> : null}
                  </span>
                }
                actions={
                  editable ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={selected.pinned ? PinOff : Pin}
                        title={selected.pinned ? 'Unpin' : 'Pin to the top'}
                        onClick={() => togglePin(selected)}
                      />
                      {/* The way out of the scratchpad. A note that has already become a
                          finding says so rather than offering to do it twice. */}
                      {selected.promotedTo ? (
                        <Badge tone="success" icon={Bug} title="This note has been written up already">
                          a finding
                        </Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Bug}
                          title="Start a finding from this note"
                          onClick={() => setPendingPromote(selected)}
                        >
                          Write up
                        </Button>
                      )}
                      <Button
                        variant={dirty ? 'primary' : 'ghost'}
                        size="sm"
                        icon={Save}
                        loading={saving}
                        disabled={!dirty}
                        title={`Save (${saveShortcutLabel()})`}
                        onClick={() => save()}
                      >
                        {dirty ? 'Save' : 'Saved'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Delete note"
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(selected)}
                      />
                    </>
                  ) : null
                }
              />
              <CardBody>
                <RichTextEditor
                  key={selected._id}
                  value={draft.content}
                  onChange={(html) => {
                    setDraft((current) => ({ ...current, content: html }));
                    setDirty(true);
                  }}
                  editable={editable}
                  minHeight={340}
                  placeholder="Paste output, jot a lead, drop a screenshot…"
                />
              </CardBody>
            </Card>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete this note?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.title || 'Untitled note'}" will be removed. This cannot be undone.`}
      />

      <ConfirmDialog
        open={Boolean(pendingPromote)}
        onClose={() => setPendingPromote(null)}
        onConfirm={promote}
        loading={promoting}
        title="Write this up as a finding?"
        confirmLabel="Write it up"
        message={`"${
          pendingPromote?.title || 'Untitled note'
        }" becomes the description of a new finding, screenshots and all. The note stays here — it is the record of what you tried.`}
      />

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={takeTheirs}
        onOverwrite={() => save({ force: true })}
        label={`the note “${draft.title || 'Untitled note'}”`}
        current={conflict}
        loading={saving}
      />
    </div>
  );
}
