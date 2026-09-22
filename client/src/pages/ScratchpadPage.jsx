import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Copy,
  NotebookPen,
  Pin,
  PinOff,
  Plus,
  Save,
  Send,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { optimistically, replacing } from '../lib/optimistic.js';
import { offerUndo } from '../lib/undo.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useUnsavedWork } from '../context/UnsavedContext.jsx';
import { cn, htmlToSnippet, timeAgo } from '../lib/utils.js';
import { saveShortcutLabel } from '../lib/keys.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import TagPicker from '../components/ui/TagPicker.jsx';
import { RichTextEditor } from '../components/editor/LazyRichTextEditor.jsx';
import { useUrlSearch, useUrlState } from '../hooks/useUrlState.js';

/**
 * The note's text, with its lines intact.
 *
 * `htmlToSnippet` flattens everything to one line, which is right for a preview and wrong for the
 * clipboard: the commonest thing anybody does with a scratchpad note is paste the payload in it
 * into a terminal, and a payload whose line breaks have become spaces is not the payload.
 */
const plainTextOf = (html) =>
  String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** One row of the list. Pulled out so the two groups cannot drift apart. */
function NoteRow({ note, active, onOpen }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full flex-col gap-1 border-l-2 px-3 py-2.5 text-left transition',
          active
            ? 'border-brand-400 bg-brand-500/10'
            : 'border-transparent hover:border-line hover:bg-white/[0.03]'
        )}
      >
        <span className="flex items-center gap-1.5">
          {note.pinned ? <Pin size={11} className="shrink-0 text-brand-300" /> : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
            {note.title || 'Untitled'}
          </span>
          <span className="shrink-0 text-[0.625rem] tabular-nums text-fg-subtle">
            {timeAgo(note.updatedAt)}
          </span>
        </span>
        <span className="truncate text-[0.6875rem] text-fg-subtle">
          {htmlToSnippet(note.content, 70) || 'Empty'}
        </span>
        {note.tags?.length ? (
          <span className="flex flex-wrap gap-1">
            {note.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="rounded bg-white/5 px-1 py-px text-[0.5625rem] text-fg-subtle"
              >
                {tag}
              </span>
            ))}
            {note.tags.length > 4 ? (
              <span className="text-[0.5625rem] text-fg-subtle">+{note.tags.length - 4}</span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

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
  const { data, loading, reload, setData } = useResource('/scratch', {
    initial: { notes: [] },
  });
  const engagements = useResource('/audits', { initial: [] });

  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({ title: '', content: '', tags: [] });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [typing, setQuery, query] = useUrlSearch('q', '');
  /* In the URL, so a filtered scratchpad is a view somebody can keep — see SavedViews. */
  const [tagFilter, setTagFilter] = useUrlState('tag', '');
  const [moving, setMoving] = useState(false);
  const [movingQuery, setMovingQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);

  const notes = data?.notes ?? [];
  const selected = notes.find((note) => note._id === selectedId) ?? null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

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

  /**
   * Deletes a note, and offers it back for the next few minutes.
   *
   * The safest thing in the app to put back: it belongs to one person, nothing references it, and
   * it returns under its own id. Which is exactly why it should never have been behind a dialog —
   * the scratchpad is where you throw things away, and asking permission each time is asking
   * somebody to confirm the thing they came here to do.
   */
  const remove = async (note) => {
    try {
      const result = await api.del(`/scratch/${note._id}`);
      if (selectedId === note._id) setSelectedId(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Note deleted',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const togglePin = async (note) => {
    try {
      await optimistically({
        from: data,
        /* The notes are a field of the answer here, not the answer, so the wrapper is kept. */
        to: { ...data, notes: replacing(data?.notes, note._id, { pinned: !note.pinned }) },
        setData,
        request: () => api.put(`/scratch/${note._id}`, { pinned: !note.pinned }),
        reload,
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const copyBody = async () => {
    const text = plainTextOf(draft.content);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not reach the clipboard', 'Select the text and copy it by hand.');
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

  /**
   * Every tag in use, with how many notes carry it.
   *
   * Counted from the notes rather than asked of the server: they are all here already, and a tag
   * list that disagreed with the list under it would be worse than none.
   */
  const tagCounts = useMemo(() => {
    const counts = new Map();
    for (const note of notes) {
      for (const tag of note.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  const needle = query.trim().toLowerCase();
  const visible = notes.filter((note) => {
    if (tagFilter && !(note.tags ?? []).includes(tagFilter)) return false;
    if (needle && !haystacks.get(note._id)?.includes(needle)) return false;
    return true;
  });
  const pinned = visible.filter((note) => note.pinned);
  const rest = visible.filter((note) => !note.pinned);
  const filtering = Boolean(needle || tagFilter);

  /** Which engagement this note has already been copied onto, if any. */
  const sentTo = selected?.fromAudit
    ? (engagements.data ?? []).find((audit) => audit._id === String(selected.fromAudit))
    : null;

  const openable = (engagements.data ?? []).filter((audit) => audit.state !== 'APPROVED');
  const movingNeedle = movingQuery.trim().toLowerCase();
  const movingList = movingNeedle
    ? openable.filter((audit) => audit.name?.toLowerCase().includes(movingNeedle))
    : openable;

  /**
   * Up and down the list from the search box.
   *
   * The scratchpad is the one page in the app somebody arrives at already typing — they came to
   * find the payload they wrote in March — and having to leave the keyboard to open the thing you
   * just searched for is the whole friction of a search box.
   */
  const step = (by) => {
    if (!visible.length) return;
    const at = visible.findIndex((note) => note._id === selectedId);
    const next = at === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, at + by));
    setSelectedId(visible[next]._id);
  };

  if (loading) return <LoadingBlock label="Loading your notes…" />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Scratchpad"
        description="Yours, and nobody else's. Nothing here belongs to an engagement or reaches a report until you move it."
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={create}>
            New note
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[21rem_1fr] lg:items-start">
        <Card className="flex flex-col lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]">
          <div className="flex flex-col gap-2 border-b border-line-soft p-3">
<div
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  step(1);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  step(-1);
                }
              }}
            >
              <SearchInput
                value={typing}
                onChange={setQuery}
                placeholder="Search titles, text and tags"
              />
            </div>
            <p className="flex items-center gap-2 text-[0.625rem] text-fg-subtle">
              <span className="tabular-nums">
                {filtering ? `${visible.length} of ${notes.length}` : `${notes.length}`} note
                {notes.length === 1 && !filtering ? '' : 's'}
              </span>
              {pinned.length ? (
                <span className="tabular-nums">· {pinned.length} pinned</span>
              ) : null}
              {filtering ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setTagFilter('');
                  }}
                  className="ml-auto text-fg-subtle underline-offset-2 transition hover:text-fg hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </p>

            {/*
              The tags in use, as filters.
              Only worth the row when there are any — a scratchpad nobody has labelled should not
              carry an empty shelf above its notes.
            */}
            {tagCounts.length ? (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {tagCounts.map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] ring-1 ring-inset transition',
                      tagFilter === tag
                        ? 'bg-brand-500/20 text-brand-200 ring-brand-500/40'
                        : 'bg-canvas/60 text-fg-subtle ring-line hover:text-fg'
                    )}
                  >
                    {tag}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length ? (
              <>
                {/* Pinned first, and said so. The server sorts them to the top; without a heading
                    the break between "kept" and "recent" is invisible. */}
                {pinned.length ? (
                  <>
                    <p className="px-3 pt-3 text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                      Pinned
                    </p>
                    <ul>
                      {pinned.map((note) => (
                        <NoteRow
                          key={note._id}
                          note={note}
                          active={note._id === selectedId}
                          onOpen={() => setSelectedId(note._id)}
                        />
                      ))}
                    </ul>
                  </>
                ) : null}
                {rest.length ? (
                  <>
                    {pinned.length ? (
                      <p className="px-3 pt-3 text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                        Everything else
                      </p>
                    ) : null}
                    <ul>
                      {rest.map((note) => (
                        <NoteRow
                          key={note._id}
                          note={note}
                          active={note._id === selectedId}
                          onOpen={() => setSelectedId(note._id)}
                        />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : (
              <p className="px-3 py-8 text-center text-xs text-fg-muted">
                {filtering ? 'Nothing matches that.' : 'Nothing here yet.'}
              </p>
            )}
          </div>
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
                  {/*
                    Where it went, by name.
                    The server records this so the page can say where the note went — it just
                    never did, so a badge reading "shared to an engagement" left you to remember
                    which one, which is the fact you wanted.
                  */}
                  {selected.fromAudit ? (
                    sentTo ? (
                      <Link to={`/engagements/${sentTo._id}`}>
                        <Badge tone="neutral" icon={Send} className="hover:ring-brand-500/40">
                          Copied to {sentTo.name}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge tone="neutral" icon={Send}>
                        Copied to an engagement
                      </Badge>
                    )
                  ) : null}
                </span>
              }
              actions={
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={copied ? Check : Copy}
                    title="Copy the text of this note, line breaks and all"
                    className={copied ? 'text-low' : undefined}
                    onClick={copyBody}
                  />
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
                    onClick={() => {
                      setMovingQuery('');
                      setMoving(true);
                    }}
                  >
                    Move to an engagement
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    title="Delete"
                    className="hover:text-crit"
                    onClick={() => remove(selected)}
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

            {/*
              Tags, which the model and the search have always had and the page never offered.
              A note was searchable by a label nobody could apply — so the suggestions come from
              this scratchpad's own tags, which is the only vocabulary that means anything here.
            */}
            <CardBody className="border-b border-line-soft py-2.5">
              <TagPicker
                value={draft.tags}
                onChange={(tags) => {
                  setDraft((current) => ({ ...current, tags }));
                  setDirty(true);
                }}
                suggestions={tagCounts.map(([tag]) => tag)}
                placeholder="Label it — “payload”, “sso”, “read later”"
                empty="No labels on this one."
                max={12}
              />
            </CardBody>

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
        <div className="flex flex-col gap-3">
          {openable.length > 6 ? (
            <SearchInput
              value={movingQuery}
              onChange={setMovingQuery}
              placeholder="Which engagement?"
              autoFocus
            />
          ) : null}
          <div className="max-h-80 overflow-auto">
            {movingList.length ? (
              <ul className="divide-y divide-line-soft">
                {movingList.map((audit) => (
                  <li key={audit._id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {audit.name}
                      {/* Already been here once. Not disabled — sending a second, later note to
                          the same engagement is ordinary; sending the *same* one twice by mistake
                          is what this is for. */}
                      {String(selected?.fromAudit ?? '') === audit._id ? (
                        <Badge tone="neutral" className="ml-2">
                          already copied here
                        </Badge>
                      ) : null}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => moveTo(audit._id, true)}>
                      Copy
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => moveTo(audit._id, false)}>
                      Move
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={TagIcon}
                title={movingNeedle ? 'No engagement by that name' : 'Nothing open to move it to'}
                description={
                  movingNeedle
                    ? 'Only engagements you can open and that are not approved are listed.'
                    : 'An approved engagement is locked, so nothing can be added to it.'
                }
              />
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
