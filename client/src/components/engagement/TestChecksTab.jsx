import { useMemo, useState } from 'react';
import {
  Ban,
  Check,
  ClipboardCheck,
  ClipboardList,
  Eraser,
  ListPlus,
  MessageSquarePlus,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, formatDateTime } from '../../lib/utils.js';
import { announceMentions } from '../../lib/mentions.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Badge } from '../ui/Badge.jsx';
import { SearchInput } from '../ui/Misc.jsx';
import MentionTextarea from '../ui/MentionTextarea.jsx';

/** Pick a ready-made checklist to start from. */
function PresetModal({ open, onClose, auditId, onAdded }) {
  const toast = useToast();
  const { data, loading } = useResource(open ? '/audits/test-check-presets' : null, { initial: [] });
  const [adding, setAdding] = useState(null);

  const add = async (preset) => {
    setAdding(preset.id);
    try {
      const result = await api.post(`/audits/${auditId}/test-checks/preset`, { preset: preset.id });
      toast.success(
        `${result.added} check${result.added === 1 ? '' : 's'} added`,
        result.skipped ? `${result.skipped} were already on the list.` : undefined
      );
      onAdded?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setAdding(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start from a checklist"
      description="A starting point, not a standard — prune it to the engagement's scope once added. Adding the same list twice tops it up rather than duplicating."
      size="lg"
    >
      {loading ? (
        <LoadingBlock />
      ) : (
        <ul className="flex flex-col gap-2">
          {(data ?? []).map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                disabled={Boolean(adding)}
                onClick={() => add(preset)}
                className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left ring-1 ring-line transition hover:bg-white/5 hover:ring-brand-500/30 disabled:opacity-50"
              >
                <ClipboardList size={16} className="mt-0.5 shrink-0 text-brand-400" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{preset.name}</span>
                    <Badge tone="brand">{preset.count} checks</Badge>
                    {/* The picker now mixes the shipped methodologies with the
                        team's own, so say which is which. */}
                    {preset.builtin ? null : <Badge tone="neutral">yours</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                    {preset.description}
                  </span>
                  <span className="mt-1 block text-[0.6875rem] text-fg-subtle">
                    {preset.categories.join(' · ')}
                  </span>
                </span>
                {adding === preset.id ? (
                  <span className="shrink-0 text-xs text-fg-muted">adding…</span>
                ) : (
                  <Plus size={15} className="mt-1 shrink-0 text-fg-subtle" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * The test checklist: what the team said it would test, and whether it did.
 *
 * Ticking records who signed it off and when, so the list is accountable rather
 * than anonymous. Unlike notes and comments these are reportable — templates can
 * print them as a "technical checks" section.
 */
export default function TestChecksTab({ audit, editable, onReload }) {
  const toast = useToast();
  const { canWrite } = useAuth();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/test-checks`, { initial: [] });

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [presetOpen, setPresetOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', category: '', description: '' });

  /**
   * Everybody on the engagement, for handing a check to one of them.
   *
   * From the audit rather than `/users`: only members can be given a check — the server
   * refuses anybody else — so offering the whole instance would be an invitation to a 400.
   */
  const team = useMemo(() => {
    const seen = new Map();
    for (const member of [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]) {
      const id = String(member?._id ?? member ?? '');
      if (id && !seen.has(id)) seen.set(id, member);
    }
    return [...seen.values()].filter((member) => typeof member === 'object');
  }, [audit.creator, audit.collaborators, audit.reviewers]);
  const [busyId, setBusyId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [clearOpen, setClearOpen] = useState(false);
  /** Which check's outcome note is open, and what has been typed into it. */
  const [noteFor, setNoteFor] = useState(null);
  const [splitting, setSplitting] = useState(null);
  /** Which category's split control is open. */
  const [splitFor, setSplitFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const people = useResource(canWrite ? '/users?active=true' : null, { initial: [] });

  const checks = Array.isArray(data) ? data : [];
  const done = checks.filter((c) => c.done).length;
  /*
   * Blocked checks are their own pile, here as everywhere else. Counting them as open would put
   * them back in the number this tab exists to drive down, which is the thing marking them
   * blocked was supposed to stop.
   */
  const blockedCount = checks.filter((c) => !c.done && c.blocked).length;
  const openCount = checks.length - done - blockedCount;
  const percent = checks.length ? Math.round((done / checks.length) * 100) : 0;

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = checks.filter((check) => {
      if (filter === 'open' && (check.done || check.blocked)) return false;
      if (filter === 'done' && !check.done) return false;
      if (filter === 'blocked' && !(check.blocked && !check.done)) return false;
      if (!needle) return true;
      return (
        check.title.toLowerCase().includes(needle) ||
        (check.category ?? '').toLowerCase().includes(needle) ||
        (check.description ?? '').toLowerCase().includes(needle)
      );
    });

    const map = new Map();
    for (const check of [...filtered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const key = check.category || 'Ungrouped';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(check);
    }
    return [...map.entries()].map(([category, items]) => ({
      category,
      items,
      done: items.filter((c) => c.done).length,
    }));
  }, [checks, search, filter]);

  const refresh = async () => {
    await reload({ quiet: true });
    // The preflight panel counts unticked checks, so keep the audit in step.
    await onReload?.({ quiet: true });
  };

  /** Which check is having its blocking reason written, and the draft. */
  const [blockFor, setBlockFor] = useState(null);
  const [blockDraft, setBlockDraft] = useState('');

  const setBlocked = async (check, blocked, reason = '') => {
    setBusyId(check._id);
    try {
      await api.put(`/audits/${audit._id}/test-checks/${check._id}`, {
        blocked,
        ...(blocked ? { blockedReason: reason } : {}),
      });
      setBlockFor(null);
      setBlockDraft('');
      await onReload?.();
      toast.success(
        blocked ? 'Marked as blocked' : 'Unblocked',
        blocked
          ? 'It stops counting as outstanding, and the report can say why.'
          : 'It counts as outstanding again.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (check) => {
    setBusyId(check._id);
    try {
      await api.put(`/audits/${audit._id}/test-checks/${check._id}`, { done: !check.done });
      await refresh();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  /** Hands one check to somebody, or gives it back to nobody in particular. */
  const assign = async (check, userId) => {
    setBusyId(check._id);
    try {
      await api.put(`/audits/${audit._id}/test-checks/${check._id}`, {
        assignedTo: userId || null,
      });
      await refresh();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Splits everything unassigned in one category between the people chosen.
   *
   * The reason the feature exists: a 120-item list gets divided at the start of a job, and
   * doing that one dropdown at a time is worse than doing it in chat. Only the unassigned and
   * unticked ones move, so running it again after somebody has started does not reshuffle
   * work already under way.
   */
  const splitGroup = async (group, userIds) => {
    const pending = group.items.filter((check) => !check.done && !check.assignedTo);
    if (!pending.length || !userIds.length) return;
    setSplitting(group.category);
    try {
      for (const [index, check] of pending.entries()) {
        await api.put(`/audits/${audit._id}/test-checks/${check._id}`, {
          assignedTo: userIds[index % userIds.length],
        });
      }
      toast.success(
        `Split ${pending.length} check${pending.length === 1 ? '' : 's'}`,
        userIds.length > 1 ? 'Round-robin between the people you picked.' : undefined
      );
      await refresh();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSplitting(null);
    }
  };

  /**
   * What the check actually found.
   *
   * The field has existed on every check since the beginning and templates print it,
   * but nothing could ever write to it — so a checklist could say "verified" and
   * never say what was seen. It also takes an `@handle`, which is the natural way to
   * hand a check to somebody else.
   */
  const saveNote = async (check) => {
    setBusyId(check._id);
    try {
      const saved = await api.put(`/audits/${audit._id}/test-checks/${check._id}`, {
        result: noteDraft,
      });
      announceMentions(toast, saved);
      setNoteFor(null);
      await refresh();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  const create = async (event) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    try {
      await api.post(`/audits/${audit._id}/test-checks`, draft);
      setDraft({ title: '', category: draft.category, description: '' });
      setAdding(false);
      await refresh();
    } catch (error) {
      toast.fromError(error);
    }
  };

  const remove = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/test-checks/${pendingDelete._id}`);
      setPendingDelete(null);
      await refresh();
      offerUndo(toast, { auditId: audit._id, undo: result?.undo, onDone: refresh });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const clearAll = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/test-checks`);
      setClearOpen(false);
      toast.success(`${result.removed} check(s) removed`);
      await refresh();
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && checks.length === 0) return <LoadingBlock label="Loading checks…" />;

  return (
    <div className="flex flex-col gap-4">
      {checks.length ? (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex min-w-52 flex-1 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-fg-muted">
                  <span className="font-semibold text-fg">{done}</span> of {checks.length} verified
                </span>
                <span className="font-mono tabular-nums text-fg-muted">{percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/6">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    percent === 100 ? 'bg-low' : 'bg-brand-500'
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>

            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Filter checks…"
              className="w-full sm:w-56"
            />

            <div className="flex items-center gap-1 rounded-lg bg-canvas/60 p-0.5 ring-1 ring-line">
              {[
                { value: 'all', label: 'All' },
                { value: 'open', label: `Open ${openCount}` },
                // Only offered when there are any: an empty pile is not a filter.
                ...(blockedCount ? [{ value: 'blocked', label: `Blocked ${blockedCount}` }] : []),
                { value: 'done', label: `Done ${done}` },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition',
                    filter === option.value ? 'bg-raised text-fg' : 'text-fg-muted hover:text-fg'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          Tracks the ground you set out to cover. Templates can print this as a technical-checks
          section.
        </p>
        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            {checks.length ? (
              <Button
                variant="ghost"
                size="sm"
                icon={Eraser}
                className="hover:text-crit"
                onClick={() => setClearOpen(true)}
              >
                Clear all
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" icon={ListPlus} onClick={() => setPresetOpen(true)}>
              From a checklist
            </Button>
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding((v) => !v)}>
              Add check
            </Button>
          </div>
        ) : null}
      </div>

      {adding && editable ? (
        <Card>
          <CardBody>
            <form onSubmit={create} className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
                <Input
                  label="What should be tested"
                  required
                  autoFocus
                  placeholder="Test the password reset flow for token reuse"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
                <Input
                  label="Category"
                  placeholder="Authentication"
                  hint="Groups the list. Optional."
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                />
              </div>
              <Textarea
                label="Notes"
                rows={2}
                placeholder="What counts as verified, or where to look."
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" icon={Plus} disabled={!draft.title.trim()}>
                  Add
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {checks.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title="No test checks yet"
            description="Write down what you intend to test, then tick each one off as you go. It records who verified what, and doubles as the coverage section of the report."
            actionLabel={editable ? 'Start from a checklist' : undefined}
            actionIcon={ListPlus}
            onAction={editable ? () => setPresetOpen(true) : undefined}
          />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon={ClipboardCheck} title="Nothing matches those filters" />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <Card key={group.category}>
              <CardHeader
                title={group.category}
                actions={
                  <span className="flex items-center gap-2">
                    {/* Dividing a category is the whole reason for assignment, so it is one
                        click here rather than one dropdown per row. */}
                    {canWrite && team.length > 1 &&
                    group.items.some((check) => !check.done && !check.assignedTo) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Users}
                        loading={splitting === group.category}
                        onClick={() =>
                          setSplitFor(splitFor === group.category ? null : group.category)
                        }
                      >
                        Split
                      </Button>
                    ) : null}
                    <Badge tone={group.done === group.items.length ? 'success' : 'neutral'}>
                      {group.done}/{group.items.length}
                    </Badge>
                  </span>
                }
              />

              {splitFor === group.category ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-brand-500/[0.05] px-4 py-2.5">
                  <span className="text-[0.6875rem] text-fg-muted">
                    Give the {group.items.filter((c) => !c.done && !c.assignedTo).length} unassigned
                    to:
                  </span>
                  {team.map((member) => (
                    <Button
                      key={member._id}
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSplitFor(null);
                        splitGroup(group, [String(member._id)]);
                      }}
                    >
                      {displayName(member)}
                    </Button>
                  ))}
                  {team.length > 1 ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setSplitFor(null);
                        splitGroup(
                          group,
                          team.map((member) => String(member._id))
                        );
                      }}
                    >
                      Share them out
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <ul className="divide-y divide-line-soft">
                {group.items.map((check) => (
                  <li key={check._id} className="flex items-start gap-3 px-4 py-2.5">
                    {/* The tick is the whole point, so it gets a big hit area. */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={check.done}
                      aria-label={`Mark "${check.title}" as ${check.done ? 'not tested' : 'verified'}`}
                      disabled={!canWrite || busyId === check._id}
                      onClick={() => toggle(check)}
                      className={cn(
                        'mt-0.5 grid size-5 shrink-0 place-items-center rounded-md ring-1 transition',
                        check.done
                          ? 'bg-low/20 text-low ring-low/40'
                          : 'ring-line hover:bg-white/5 hover:ring-brand-500/40',
                        !canWrite && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      {check.done ? <Check size={13} /> : null}
                    </button>

                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'text-sm',
                          check.done ? 'text-fg-muted line-through decoration-fg-subtle' : 'text-fg'
                        )}
                      >
                        {check.title}
                      </p>
                      {check.description ? (
                        <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
                          {check.description}
                        </p>
                      ) : null}

                      {/*
                        Why it cannot be done, said where somebody reading the list will see it.
                        A blocked check is not an oversight, so it does not wear the warning
                        colour that outstanding work does — it is a recorded fact.
                      */}
                      {check.blocked && !check.done ? (
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] leading-relaxed text-fg-muted">
                          <Badge tone="info" icon={Ban}>
                            blocked
                          </Badge>
                          <span className="min-w-0 flex-1">{check.blockedReason}</span>
                          {canWrite ? (
                            <button
                              type="button"
                              className="text-brand-300 transition hover:text-brand-200"
                              onClick={() => setBlocked(check, false)}
                            >
                              unblock
                            </button>
                          ) : null}
                        </p>
                      ) : null}

                      {blockFor === check._id ? (
                        <div className="mt-2 flex flex-col gap-2">
                          <Input
                            autoFocus
                            placeholder="Waiting on the client to open the firewall from the test range"
                            value={blockDraft}
                            onChange={(event) => setBlockDraft(event.target.value)}
                          />
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setBlockFor(null)}>
                              Cancel
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              loading={busyId === check._id}
                              disabled={!blockDraft.trim()}
                              onClick={() => setBlocked(check, true, blockDraft)}
                            >
                              Mark blocked
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {noteFor === check._id ? (
                        <div className="mt-2 flex flex-col gap-2">
                          <MentionTextarea
                            value={noteDraft}
                            onChange={(event) => setNoteDraft(event.target.value)}
                            users={people.data ?? []}
                            rows={2}
                            autoFocus
                            placeholder="What did you find? @mention a colleague to hand it over."
                          />
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setNoteFor(null)}>
                              Cancel
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              loading={busyId === check._id}
                              onClick={() => saveNote(check)}
                            >
                              Save note
                            </Button>
                          </div>
                        </div>
                      ) : check.result ? (
                        <p className="mt-1.5 whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-fg-muted">
                          {check.result}
                        </p>
                      ) : null}

                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-fg-subtle">
                        {check.createdBy ? (
                          <span>Added by {displayName(check.createdBy)}</span>
                        ) : null}
                        {check.done && check.doneBy ? (
                          <span className="text-low">
                            Verified by {displayName(check.doneBy)}
                            {check.doneAt ? ` · ${formatDateTime(check.doneAt)}` : ''}
                          </span>
                        ) : null}
                        {/* Kept after it is ticked: "assigned to Ana, done by Bram" is how you
                            find out somebody was overloaded. */}
                        {check.assignedTo ? (
                          <span className={check.done ? 'text-fg-subtle' : 'text-brand-300'}>
                            {check.done ? 'Was ' : ''}
                            {displayName(check.assignedTo)}&rsquo;s
                          </span>
                        ) : null}
                      </p>
                    </div>

                    {/*
                      Whose it is.
                      Quiet until it has an answer: most checks on a one-person job never need
                      one, and a row of dropdowns would make the exception look like the rule.
                    */}
                    {canWrite && team.length > 1 ? (
                      <select
                        value={String(check.assignedTo?._id ?? check.assignedTo ?? '')}
                        disabled={busyId === check._id}
                        title="Who is doing this one"
                        onChange={(event) => assign(check, event.target.value)}
                        className={cn(
                          'h-6 shrink-0 rounded bg-canvas/60 px-1 text-[0.625rem] ring-1 ring-line-soft focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-40',
                          check.assignedTo ? 'text-fg' : 'text-fg-subtle opacity-50 hover:opacity-100'
                        )}
                      >
                        <option value="">nobody</option>
                        {team.map((member) => (
                          <option key={member._id} value={member._id}>
                            {displayName(member)}
                          </option>
                        ))}
                      </select>
                    ) : null}

                    {canWrite && noteFor !== check._id ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={MessageSquarePlus}
                        title={check.result ? 'Edit the outcome note' : 'Record what you found'}
                        className="shrink-0"
                        onClick={() => {
                          setNoteFor(check._id);
                          setNoteDraft(check.result ?? '');
                        }}
                      />
                    ) : null}

                    {/* Only offered on something not yet done: a finished check is not blocked. */}
                    {canWrite && !check.done && !check.blocked ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Ban}
                        title="Cannot be tested — say why"
                        className="shrink-0"
                        onClick={() => {
                          setBlockFor(check._id);
                          setBlockDraft('');
                        }}
                      />
                    ) : null}

                    {editable ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Remove check"
                        className="shrink-0 hover:text-crit"
                        onClick={() => setPendingDelete(check)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <PresetModal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        auditId={audit._id}
        onAdded={refresh}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this check?"
        confirmLabel="Remove"
        message={`"${pendingDelete?.title}" will be taken off the list.`}
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={clearAll}
        title="Clear the whole checklist?"
        confirmLabel="Clear all"
        message={`All ${checks.length} check(s) will be removed, including the ones already verified. This cannot be undone.`}
      />
    </div>
  );
}
