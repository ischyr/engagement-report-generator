import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck,
  Copy,
  FolderOpen,
  ListChecks,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { cn, displayName, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Input, Select, Textarea } from '../components/ui/Field.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import ConflictDialog from '../components/ui/ConflictDialog.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';

const UNGROUPED = 'Ungrouped';

/** New checklist, optionally starting from a paste. */
function NewChecklistModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm({ name: '', description: '' });
  }, [open]);

  const submit = async (event) => {
    event?.preventDefault();
    if (!form.name.trim()) {
      toast.error('Give the checklist a name');
      return;
    }
    setSaving(true);
    try {
      const created = await api.post('/checklists', form);
      toast.success(`"${created.name}" created`, 'Add checks to it, or paste a list.');
      onCreated?.(created);
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
      title="New checklist"
      description="A methodology of your own — the list of things you set out to test."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Name"
          required
          autoFocus
          placeholder="Mobile application (iOS)"
          value={form.name}
          onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
        />
        <Textarea
          label="Description"
          rows={2}
          placeholder="What this methodology covers, and when to use it."
          value={form.description}
          onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
        />
      </form>
    </Modal>
  );
}

/**
 * Paste a methodology in.
 *
 * Adding forty items through a one-line form is the friction that stops people
 * curating their checklists at all, and a methodology almost always arrives as a
 * list already.
 */
function BulkAddModal({ open, onClose, checklistId, onAdded }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setText('');
      setCategory('');
    }
  }, [open]);

  const submit = async () => {
    if (!text.trim()) {
      toast.error('Paste at least one line');
      return;
    }
    setSaving(true);
    try {
      const result = await api.post(`/checklists/${checklistId}/checks/bulk`, { text, category });
      toast.success(
        `${result.added} check${result.added === 1 ? '' : 's'} added`,
        result.skipped ? `${result.skipped} already there and skipped.` : undefined
      );
      onAdded?.();
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
      title="Paste a list of checks"
      description="One per line. Bullets and numbering are stripped."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            Add them
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Category for these"
          hint="Optional. A line ending in a colon, or wrapped in [brackets], starts a new category from there on."
          placeholder="Authentication"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        />
        <Textarea
          label="Checks"
          rows={12}
          className="font-mono text-xs"
          placeholder={
            'Authentication:\n- Test for username enumeration\n- Check password policy\n\n[Session management]\n1. Verify session fixation is not possible\n2. Check logout invalidates the session'
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </Modal>
  );
}

/**
 * One row: tick it against an engagement, view, inline-edit, or delete.
 *
 * The tick belongs to an engagement, never to the library. A methodology item has
 * no "done" of its own — and in a shared tool a tick with nobody's name on it would
 * read as verification of work that may not have happened. With no engagement
 * selected the row is plainly the methodology; with one selected, ticking records
 * who and when against that engagement, exactly as its Checks tab does.
 */
function CheckRow({ check, checklistId, editable, onChanged, onConflict, tracking }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', category: '' });
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);

  const tracked = tracking?.matchOf(check) ?? null;
  const done = Boolean(tracked?.done);

  const toggle = async (next) => {
    setToggling(true);
    try {
      await tracking.onToggle(check, next);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setToggling(false);
    }
  };

  const startEditing = () => {
    setDraft({
      title: check.title ?? '',
      description: check.description ?? '',
      category: check.category ?? '',
    });
    setEditing(true);
  };

  const save = async ({ force = false } = {}) => {
    if (!draft.title.trim()) {
      toast.error('A check needs a title');
      return;
    }
    setBusy(true);
    try {
      await api.put(`/checklists/${checklistId}/checks/${check._id}`, {
        ...draft,
        // Refused if somebody has rewritten this same check meanwhile.
        ...(check.updatedAt && !force ? { expectedUpdatedAt: check.updatedAt } : {}),
      });
      setEditing(false);
      await onChanged?.();
    } catch (error) {
      if (error?.isConflict) {
        onConflict?.({
          error,
          label: `the check “${check.title}”`,
          retry: () => save({ force: true }),
        });
      } else {
        toast.fromError(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async ({ force = false } = {}) => {
    setBusy(true);
    try {
      const token = check.updatedAt && !force ? `?expectedUpdatedAt=${encodeURIComponent(check.updatedAt)}` : '';
      await api.del(`/checklists/${checklistId}/checks/${check._id}${token}`);
      await onChanged?.();
    } catch (error) {
      if (error?.isConflict) {
        onConflict?.({
          error,
          label: `the check “${check.title}”`,
          retry: () => remove({ force: true }),
        });
      } else {
        toast.fromError(error);
      }
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-brand-500/40 bg-canvas/60 px-3 py-2.5">
        <Input
          autoFocus
          value={draft.title}
          onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
          placeholder="What should be checked"
        />
        <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
          <Input
            value={draft.category}
            onChange={(event) => setDraft((d) => ({ ...d, category: event.target.value }))}
            placeholder="Category"
          />
          <Input
            value={draft.description}
            onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))}
            placeholder="What “verified” means here (optional)"
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" icon={X} onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" icon={Save} onClick={() => save()} loading={busy}>
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        'group flex items-start gap-3 rounded-lg px-3 py-2 transition hover:bg-white/[0.03]',
        done && 'bg-low/[0.05]'
      )}
    >
      {tracking ? (
        <input
          type="checkbox"
          checked={done}
          disabled={toggling}
          onChange={(event) => toggle(event.target.checked)}
          aria-label={`Mark "${check.title}" as verified on ${tracking.auditName}`}
          title={
            done
              ? `Verified${tracked?.doneBy ? ` by ${displayName(tracked.doneBy)}` : ''}${
                  tracked?.doneAt ? ` ${timeAgo(tracked.doneAt)}` : ''
                } — click to un-verify`
              : `Mark as verified on ${tracking.auditName}`
          }
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line bg-canvas accent-brand-500 disabled:cursor-wait"
        />
      ) : (
        <ListChecks size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', done ? 'text-fg-muted line-through decoration-low/50' : 'text-fg')}>
          {check.title}
        </p>
        {check.description ? (
          <p className="mt-0.5 text-xs text-fg-muted">{check.description}</p>
        ) : null}
        {/* Accountability, where it is useful: not just that it was done. */}
        {done && tracked?.doneBy ? (
          <p className="mt-0.5 text-[0.625rem] text-low">
            Verified by {displayName(tracked.doneBy)}
            {tracked.doneAt ? ` · ${timeAgo(tracked.doneAt)}` : ''}
          </p>
        ) : null}
      </div>
      {editable ? (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="icon-sm" icon={Pencil} title="Edit" onClick={startEditing} />
          <Button
            variant="ghost"
            size="icon-sm"
            icon={Trash2}
            title="Delete this check"
            className="hover:text-crit"
            loading={busy}
            onClick={() => remove()}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The checklist library.
 *
 * These used to be four lists in a source file, so a team could not add their own
 * without editing the code and redeploying. The shipped ones are seeded rather than
 * special — the same add, edit and delete work on all of them, and `npm run seed`
 * puts a deleted one back.
 */
export default function ChecklistsPage() {
  const toast = useToast();
  const { canWrite, isAdmin, user } = useAuth();

  const list = useResource('/checklists', { initial: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingCategory, setPendingCategory] = useState(null);
  const [newCheck, setNewCheck] = useState({ title: '', category: '' });
  const [addingCheck, setAddingCheck] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  /** Set when a write was refused because somebody edited the same thing first. */
  const [conflict, setConflict] = useState(null);

  /**
   * Which engagement ticks are recorded against. Remembered, because working
   * through a methodology spans sessions and re-picking it every time is friction.
   */
  const [auditId, setAuditId] = useState(() => {
    try {
      return localStorage.getItem('engy.checklists.audit') ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    try {
      if (auditId) localStorage.setItem('engy.checklists.audit', auditId);
      else localStorage.removeItem('engy.checklists.audit');
    } catch {
      /* private mode — the selection just will not persist */
    }
  }, [auditId]);

  const engagements = useResource('/audits', { initial: [] });
  const tracked = useResource(auditId ? `/audits/${auditId}/test-checks` : null, { initial: [] });

  const checklists = list.data ?? [];
  const audit = (engagements.data ?? []).find((a) => a._id === auditId) ?? null;

  // A remembered engagement that has since been deleted or trashed must not leave
  // the page pointing at nothing.
  useEffect(() => {
    if (auditId && engagements.data?.length && !audit) setAuditId('');
  }, [auditId, engagements.data, audit]);

  /** Engagement checks by wording, which is how a library row finds its match. */
  const trackedByKey = useMemo(() => {
    const map = new Map();
    for (const check of tracked.data ?? []) {
      map.set(`${check.category ?? ''}|${check.title}`.trim().toLowerCase(), check);
    }
    return map;
  }, [tracked.data]);

  const tracking = useMemo(() => {
    if (!audit || !canWrite) return null;
    return {
      auditId,
      auditName: audit.name,
      matchOf: (check) =>
        trackedByKey.get(`${check.category ?? ''}|${check.title}`.trim().toLowerCase()) ?? null,
      onToggle: async (check, done) => {
        await api.post(`/audits/${auditId}/test-checks/toggle`, {
          title: check.title,
          category: check.category ?? '',
          description: check.description ?? '',
          done,
        });
        await tracked.reload({ quiet: true });
      },
    };
  }, [audit, auditId, canWrite, trackedByKey, tracked]);

  // Open the first checklist automatically; an empty right-hand pane looks broken.
  useEffect(() => {
    if (!selectedId && checklists.length) setSelectedId(checklists[0].id ?? checklists[0]._id);
  }, [checklists, selectedId]);

  const detail = useResource(selectedId ? `/checklists/${selectedId}` : null, { initial: null });
  const selected = detail.data;

  const reloadBoth = async () => {
    await Promise.all([list.reload({ quiet: true }), detail.reload({ quiet: true })]);
  };

  /** Checks grouped by category, in the order they were added. */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const out = [];
    for (const check of selected?.checks ?? []) {
      if (
        needle &&
        !`${check.title} ${check.description} ${check.category}`.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const category = check.category?.trim() || UNGROUPED;
      let group = out.find((g) => g.category === category);
      if (!group) {
        group = { category, checks: [] };
        out.push(group);
      }
      group.checks.push(check);
    }
    return out;
  }, [selected?.checks, search]);

  /** Everything on the engagement, however it got there. Shown in the top bar. */
  const auditProgress = useMemo(() => {
    const checks = tracked.data ?? [];
    const done = checks.filter((check) => check.done).length;
    return { done, total: checks.length };
  }, [tracked.data]);

  /** How much of *this* checklist is verified on the selected engagement. */
  const progress = useMemo(() => {
    const checks = selected?.checks ?? [];
    if (!tracking || checks.length === 0) return { done: 0, total: checks.length, percent: 0 };
    const done = checks.filter((check) => tracking.matchOf(check)?.done).length;
    return { done, total: checks.length, percent: Math.round((done / checks.length) * 100) };
  }, [selected?.checks, tracking]);

  const addCheck = async (event) => {
    event?.preventDefault();
    if (!newCheck.title.trim()) return;
    setAddingCheck(true);
    try {
      await api.post(`/checklists/${selectedId}/checks`, newCheck);
      // Keep the category so adding several to one section is not repetitive.
      setNewCheck((c) => ({ title: '', category: c.category }));
      await reloadBoth();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setAddingCheck(false);
    }
  };

  const saveName = async ({ force = false } = {}) => {
    if (!nameDraft.trim()) return;
    try {
      await api.put(`/checklists/${selectedId}`, {
        name: nameDraft,
        // The details marker, so a colleague adding a check does not block a rename.
        ...(selected?.detailsUpdatedAt && !force
          ? { expectedUpdatedAt: selected.detailsUpdatedAt }
          : {}),
      });
      setRenaming(false);
      await reloadBoth();
    } catch (error) {
      if (error?.isConflict) {
        setConflict({
          error,
          label: `the checklist “${selected?.name}”`,
          retry: () => saveName({ force: true }),
        });
      } else {
        toast.fromError(error);
      }
    }
  };

  const duplicate = async () => {
    try {
      const copy = await api.post(`/checklists/${selectedId}/duplicate`, {});
      toast.success(`Copied to "${copy.name}"`, 'Edit the copy freely.');
      await list.reload({ quiet: true });
      setSelectedId(copy._id);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const confirmDeleteChecklist = async () => {
    try {
      await api.del(`/checklists/${pendingDelete.id ?? pendingDelete._id}`);
      toast.success('Checklist deleted');
      setPendingDelete(null);
      setSelectedId(null);
      await list.reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const confirmDeleteCategory = async ({ force = false } = {}) => {
    try {
      // Guarded against the whole checklist: this removes many checks at once, so a
      // needless retry beats deleting something a colleague just added.
      const token =
        selected?.updatedAt && !force
          ? `?expectedUpdatedAt=${encodeURIComponent(selected.updatedAt)}`
          : '';
      const result = await api.del(
        `/checklists/${selectedId}/categories/${encodeURIComponent(pendingCategory)}${token}`
      );
      toast.success(`Removed ${result.removed} check${result.removed === 1 ? '' : 's'}`);
      setPendingCategory(null);
      await reloadBoth();
    } catch (error) {
      if (error?.isConflict) {
        setPendingCategory(null);
        setConflict({
          error,
          label: `the “${pendingCategory}” category`,
          retry: () => confirmDeleteCategory({ force: true }),
        });
      } else {
        toast.fromError(error);
      }
    }
  };

  const mayDelete = (checklist) =>
    isAdmin ||
    (checklist?.createdBy &&
      (checklist.createdBy._id ?? checklist.createdBy) === (user?.id ?? user?._id));

  if (list.loading && !checklists.length) return <LoadingBlock label="Loading checklists…" />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Checklists"
        description="The methodologies an engagement's test list is started from. Add your own, prune the shipped ones."
        actions={
          canWrite ? (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New checklist
            </Button>
          ) : null
        }
      />

      {/* One control, above everything it scopes: which engagement a tick belongs to. */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line-soft bg-surface/60 px-4 py-3">
        <ClipboardCheck size={15} className="shrink-0 text-fg-subtle" />
        <span className="text-xs text-fg-muted">Tick these off against</span>
        <Select
          value={auditId}
          onChange={(event) => setAuditId(event.target.value)}
          placeholder="no engagement — just viewing"
          options={(engagements.data ?? []).map((engagement) => ({
            value: engagement._id,
            label: engagement.company?.name
              ? `${engagement.name} · ${engagement.company.name}`
              : engagement.name,
          }))}
          className="h-9 w-72"
          wrapperClassName="w-72"
        />
        {audit ? (
          <>
            <Badge
              tone={
                auditProgress.total && auditProgress.done === auditProgress.total
                  ? 'success'
                  : 'brand'
              }
            >
              {auditProgress.done}/{auditProgress.total} verified on this engagement
            </Badge>
            <Link
              to={`/engagements/${auditId}?tab=checks`}
              className="text-[0.6875rem] text-fg-muted underline-offset-2 transition hover:text-brand-300 hover:underline"
            >
              open its Checks tab
            </Link>
          </>
        ) : (
          <span className="text-[0.6875rem] text-fg-subtle">
            A tick belongs to an engagement, not to the methodology — pick one and the
            checkboxes appear, recording who verified each item and when.
          </span>
        )}
      </div>

      {checklists.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title="No checklists yet"
            description="Run npm run seed to restore the four that ship with the app, or create your own."
            actionLabel={canWrite ? 'New checklist' : undefined}
            actionIcon={Plus}
            onAction={canWrite ? () => setCreating(true) : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          {/* The library */}
          <Card className="self-start">
            <CardHeader title="Library" description={`${checklists.length} methodologies`} />
            <CardBody className="flex flex-col gap-1 p-2">
              {checklists.map((checklist) => {
                const id = checklist.id ?? checklist._id;
                const active = id === selectedId;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className={cn(
                      'rounded-lg px-3 py-2 text-left transition',
                      active ? 'bg-brand-500/12 ring-1 ring-brand-500/30' : 'hover:bg-white/5'
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm font-medium',
                          active ? 'text-brand-300' : 'text-fg'
                        )}
                      >
                        {checklist.name}
                      </span>
                      <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                        {checklist.count}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {checklist.builtin ? (
                        <Badge tone="neutral">built in</Badge>
                      ) : (
                        <Badge tone="brand">yours</Badge>
                      )}
                      <span className="truncate text-[0.625rem] text-fg-subtle">
                        {checklist.categories.length} categor
                        {checklist.categories.length === 1 ? 'y' : 'ies'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </CardBody>
          </Card>

          {/* The selected checklist */}
          {detail.loading && !selected ? (
            <LoadingBlock label="Loading checks…" />
          ) : selected ? (
            <div className="flex min-w-0 flex-col gap-4">
              <Card>
                <CardHeader
                  icon={ClipboardCheck}
                  title={
                    renaming ? (
                      <span className="flex items-center gap-2">
                        <Input
                          autoFocus
                          value={nameDraft}
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => event.key === 'Enter' && saveName()}
                          wrapperClassName="w-64"
                        />
                        <Button variant="primary" size="sm" icon={Save} onClick={saveName}>
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      selected.name
                    )
                  }
                  description={
                    selected.description ||
                    `${selected.checks?.length ?? 0} checks · updated ${timeAgo(selected.updatedAt)}`
                  }
                  actions={
                    canWrite ? (
                      <div className="flex items-center gap-2">
                        {!renaming ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={Pencil}
                            title="Rename"
                            onClick={() => {
                              setNameDraft(selected.name);
                              setRenaming(true);
                            }}
                          />
                        ) : null}
                        <Button variant="ghost" size="sm" icon={Copy} onClick={duplicate}>
                          Duplicate
                        </Button>
                        <Button variant="secondary" size="sm" icon={Plus} onClick={() => setBulkOpen(true)}>
                          Paste a list
                        </Button>
                        {mayDelete(selected) ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={Trash2}
                            title="Delete this checklist"
                            className="hover:text-crit"
                            onClick={() => setPendingDelete(selected)}
                          />
                        ) : null}
                      </div>
                    ) : null
                  }
                />

                {canWrite ? (
                  <CardBody className="border-b border-line-soft">
                    {/* Add one, inline. The category persists so adding several to
                        the same section is not repetitive. */}
                    <form onSubmit={addCheck} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                      <Input
                        placeholder="Category"
                        value={newCheck.category}
                        onChange={(event) =>
                          setNewCheck((c) => ({ ...c, category: event.target.value }))
                        }
                      />
                      <Input
                        placeholder="Add a check — what should be verified?"
                        value={newCheck.title}
                        onChange={(event) => setNewCheck((c) => ({ ...c, title: event.target.value }))}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        icon={Plus}
                        loading={addingCheck}
                        disabled={!newCheck.title.trim()}
                      >
                        Add
                      </Button>
                    </form>
                  </CardBody>
                ) : null}

                {/* Progress on the selected engagement, for this methodology. */}
                {tracking && progress.total ? (
                  <CardBody className="border-b border-line-soft">
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/6">
                        <span
                          aria-hidden
                          style={{ width: `${progress.percent}%` }}
                          className="block h-full rounded-full bg-low transition-[width]"
                        />
                      </div>
                      <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-fg-muted">
                        {progress.done}/{progress.total}
                      </span>
                      <span className="shrink-0 text-[0.6875rem] text-fg-subtle">
                        verified on {audit.name}
                      </span>
                    </div>
                  </CardBody>
                ) : null}

                <CardBody>
                  {(selected.checks?.length ?? 0) > 8 ? (
                    <SearchInput
                      value={search}
                      onChange={setSearch}
                      placeholder="Filter these checks…"
                      className="mb-4 w-full sm:w-72"
                    />
                  ) : null}

                  {groups.length === 0 ? (
                    <EmptyState
                      icon={ListChecks}
                      title={search ? 'Nothing matches' : 'No checks yet'}
                      description={
                        search
                          ? 'Try a different term.'
                          : 'Add them one at a time above, or paste a whole methodology.'
                      }
                    />
                  ) : (
                    <div className="flex flex-col gap-5">
                      {groups.map((group) => (
                        <div key={group.category}>
                          <div className="mb-1.5 flex items-center gap-2 border-b border-line-soft pb-1.5">
                            <FolderOpen size={13} className="shrink-0 text-fg-subtle" />
                            <h3 className="flex-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-muted">
                              {group.category}
                            </h3>
                            <span className="font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                              {tracking
                                ? `${group.checks.filter((c) => tracking.matchOf(c)?.done).length}/${group.checks.length}`
                                : group.checks.length}
                            </span>
                            {canWrite && !search ? (
                              <button
                                type="button"
                                onClick={() => setPendingCategory(group.category)}
                                title={`Remove every check in ${group.category}`}
                                className="text-[0.625rem] text-fg-subtle transition hover:text-crit"
                              >
                                remove all
                              </button>
                            ) : null}
                          </div>
                          <ul className="flex flex-col">
                            {group.checks.map((check) => (
                              <CheckRow
                                key={check._id}
                                check={check}
                                checklistId={selectedId}
                                editable={canWrite}
                                onChanged={reloadBoth}
                                onConflict={setConflict}
                                tracking={tracking}
                              />
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>

              <p className="text-[0.6875rem] text-fg-subtle">
                Add a checklist to an engagement from its <strong>Checks</strong> tab. Adding the
                same one twice tops it up rather than duplicating, so you can pull in a second
                methodology alongside the first.
              </p>
            </div>
          ) : null}
        </div>
      )}

      <NewChecklistModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (created) => {
          await list.reload({ quiet: true });
          setSelectedId(created._id);
        }}
      />

      <BulkAddModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        checklistId={selectedId}
        onAdded={reloadBoth}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDeleteChecklist}
        title="Delete this checklist?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.name}" and its ${pendingDelete?.checks?.length ?? pendingDelete?.count ?? 0} checks will be removed. Engagements that already used it keep their own copies.${
          pendingDelete?.builtin ? ' It ships with the app, so npm run seed would restore it.' : ''
        }`}
      />

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={async () => {
          setConflict(null);
          await reloadBoth();
        }}
        onOverwrite={async () => {
          const retry = conflict?.retry;
          setConflict(null);
          await retry?.();
        }}
        label={conflict?.label ?? 'this checklist'}
        current={conflict?.error?.current}
      />

      <ConfirmDialog
        open={Boolean(pendingCategory)}
        onClose={() => setPendingCategory(null)}
        onConfirm={confirmDeleteCategory}
        title={`Remove every check in ${pendingCategory}?`}
        confirmLabel="Remove them"
        message="Useful for pruning a shipped methodology to the engagement's scope. This affects the checklist, not engagements that already used it."
      />
    </div>
  );
}
