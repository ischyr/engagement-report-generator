import { useEffect, useMemo, useRef } from 'react';
import {
  Bug,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  Plus,
  Terminal,
} from 'lucide-react';

import { cn } from '../../lib/utils.js';

/** Tone per outcome, so a tree of forty rows can be read without stopping to read. */
const STATUS_DOT = {
  completed: 'bg-low',
  nothing: 'bg-fg-subtle',
  timeout: 'bg-med',
  blocked: 'bg-crit',
  abandoned: 'bg-fg-subtle/60',
};

const STATUS_TITLE = {
  completed: 'Completed',
  nothing: 'Nothing found',
  timeout: 'Timed out',
  blocked: 'Blocked',
  abandoned: 'Not pursued',
};

const idOf = (value) => String(value ?? '');

/**
 * How many rows sit under each one, and where each sits among its siblings.
 *
 * Both in a single pass over the tree, because the obvious way to get the first is a walk per row
 * and this component renders on every keystroke in the filter box. At two hundred rows that walk —
 * itself quadratic, since it tested membership against a growing array — was tens of thousands of
 * comparisons to draw a number beside a folded heading.
 *
 * The rows arrive in reading order, which is depth-first, so every parent precedes its children:
 * walking backwards lets each row hand its own total up to its parent, and one reverse pass
 * accumulates the whole tree.
 */
function treeShape(rows) {
  const descendants = new Map();
  const among = new Map();
  const seen = new Map();

  for (const row of rows) {
    const parent = idOf(row.parent);
    seen.set(parent, (seen.get(parent) ?? 0) + 1);
    among.set(idOf(row._id), { position: seen.get(parent), of: 0 });
  }
  /* Sibling counts are only final once every row has been seen, so fill the totals afterwards. */
  for (const row of rows) {
    const entry = among.get(idOf(row._id));
    if (entry) entry.of = seen.get(idOf(row.parent)) ?? 1;
  }

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const id = idOf(rows[i]._id);
    const mine = descendants.get(id) ?? 0;
    descendants.set(id, mine);
    const parent = idOf(rows[i].parent);
    if (parent) descendants.set(parent, (descendants.get(parent) ?? 0) + mine + 1);
  }

  return { descendants, among };
}

/**
 * The icon that says what kind of node this is.
 *
 * An outliner is read by shape before it is read by word, which is the whole reason the tree beats a
 * list: a glance should say "section, four tool runs, one of them held back" without anybody parsing
 * titles. So the icon carries the role and the colour carries the state.
 */
function NodeIcon({ row, collapsed }) {
  if (row.heldBack) {
    return <EyeOff size={12} className="shrink-0 text-fg-subtle" />;
  }
  if (row.hasChildren) {
    const Icon = collapsed ? Folder : FolderOpen;
    return <Icon size={12} className="shrink-0 text-brand-300" />;
  }
  /*
   * `hasOutput`, not the output itself: the tree is sent without it. Sixty steps of tool output is
   * megabytes of JSON to decide which of two icons to draw.
   */
  if (row.hasOutput) {
    return <Terminal size={12} className="shrink-0 text-low" />;
  }
  return <FileText size={12} className="shrink-0 text-fg-subtle" />;
}

/**
 * The enumeration tree.
 *
 * One line per node, deliberately. The first version gave each row three — title, then a row of
 * chips, then the target — which reads well for six rows and becomes unusable at sixty, and sixty is
 * the normal size of a real operation's enumeration. Everything that was on the second and third
 * lines is either a chip on the first or in the editor beside it.
 *
 * Indent guides rather than padding alone: past three levels, whitespace stops telling you which
 * parent a row belongs to, and the vertical rules are what make a deep tree legible. This is the
 * same reason every outliner ever written draws them.
 */
export default function EnumerationTree({
  rows,
  visible,
  selectedId,
  onSelect,
  picked,
  onPick,
  collapsed,
  onToggleCollapse,
  filtering,
  editable,
  moving,
  onAddChild,
  dragId,
  setDragId,
  dropHint,
  setDropHint,
  onDrop,
  variant = 'compact',
}) {
  const listRef = useRef(null);

  /*
   * Arrow keys, because an outliner without them is a list you have to aim at. Up and down move the
   * selection through what is on screen; left and right fold and unfold, falling back to moving to
   * the parent when there is nothing to fold — the behaviour every tree view has.
   */
  useEffect(() => {
    const node = listRef.current;
    if (!node) return undefined;
    const onKey = (event) => {
      if (!/^Arrow(Up|Down|Left|Right)$/.test(event.key)) return;
      /* Never steal the arrows from somebody typing in the editor beside this. */
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
      if (document.activeElement?.isContentEditable) return;
      if (!node.contains(document.activeElement)) return;

      const index = visible.findIndex((row) => idOf(row._id) === idOf(selectedId));
      const current = visible[index];
      if (event.key === 'ArrowDown' && index < visible.length - 1) {
        event.preventDefault();
        onSelect(visible[index + 1]._id);
      } else if (event.key === 'ArrowUp' && index > 0) {
        event.preventDefault();
        onSelect(visible[index - 1]._id);
      } else if (event.key === 'ArrowRight' && current?.hasChildren) {
        event.preventDefault();
        if (collapsed.has(idOf(current._id))) onToggleCollapse(idOf(current._id));
      } else if (event.key === 'ArrowLeft' && current) {
        event.preventDefault();
        const id = idOf(current._id);
        if (current.hasChildren && !collapsed.has(id)) onToggleCollapse(id);
        else if (current.parent) onSelect(current.parent);
      }
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, [visible, selectedId, collapsed, onSelect, onToggleCollapse]);

  const full = variant === 'full';

  /* Recomputed when the tree changes, not when the filter box is typed into. */
  const { descendants, among } = useMemo(() => treeShape(rows), [rows]);

  return (
    <ul
      ref={listRef}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="tree"
      aria-label="Enumeration"
      className="focus:outline-none"
    >
      {visible.map((row) => {
        const id = idOf(row._id);
        const isCollapsed = collapsed.has(id);
        const isSelected = id === idOf(selectedId);
        const hint = dropHint?.id === id ? dropHint.zone : null;
        /* Counted on the server, which is the only place the output still lives. */
        const outputLines = row.outputLines ?? 0;
        const inside = descendants.get(id) ?? 0;
        const place = among.get(id);

        return (
          <li
            key={id}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={row.hasChildren ? !isCollapsed : undefined}
            /*
              Depth and place, which is the one thing a tree knows that a list does not — and
              until these were here, the only thing a screen reader could not be told. `role="tree"`
              on its own announces "1 of 60" for a row four levels down.
            */
            aria-level={(row.depth ?? 0) + 1}
            aria-posinset={place?.position}
            aria-setsize={place?.of}
            draggable={editable && !moving}
            onDragStart={(event) => {
              setDragId(id);
              event.dataTransfer.effectAllowed = 'move';
              /* Firefox will not start a drag without payload. */
              event.dataTransfer.setData('text/plain', id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropHint(null);
            }}
            onDragOver={(event) => {
              if (!dragId || dragId === id) return;
              event.preventDefault();
              /*
                Three zones by vertical position: the outer quarters put the branch beside the row,
                the middle half puts it inside. The gesture an outliner already taught people, so
                nesting needs no separate control.
              */
              const box = event.currentTarget.getBoundingClientRect();
              const offset = (event.clientY - box.top) / box.height;
              setDropHint({
                id,
                zone: offset < 0.3 ? 'before' : offset > 0.7 ? 'after' : 'inside',
              });
            }}
            onDragLeave={() => setDropHint((h) => (h?.id === id ? null : h))}
            onDrop={(event) => {
              event.preventDefault();
              /*
               * The zone from the pointer, not from the hint state, for the same reason the id is:
               * a drop in the same tick as the dragover has no hint yet.
               */
              const box = event.currentTarget.getBoundingClientRect();
              const offset = (event.clientY - box.top) / box.height;
              const zone =
                dropHint?.id === id
                  ? dropHint.zone
                  : offset < 0.3
                    ? 'before'
                    : offset > 0.7
                      ? 'after'
                      : 'inside';
              onDrop(event, row._id, zone);
            }}
            className={cn(
              'relative',
              hint === 'before' &&
                'before:absolute before:inset-x-1 before:top-0 before:z-10 before:h-0.5 before:rounded-full before:bg-brand-400',
              hint === 'after' &&
                'after:absolute after:inset-x-1 after:bottom-0 after:z-10 after:h-0.5 after:rounded-full after:bg-brand-400',
              hint === 'inside' && 'ring-1 ring-inset ring-brand-400/70',
              dragId === id && 'opacity-40'
            )}
          >
            <div
              className={cn(
                'group/row flex items-stretch',
                isSelected ? 'bg-brand-500/12' : 'hover:bg-white/[0.04]'
              )}
            >
              {/*
                One guide per ancestor level. Drawn as fixed-width cells with a left border rather
                than as padding, so the rules line up exactly down the tree however deep it goes.
              */}
              {Array.from({ length: row.depth }, (_, level) => (
                // eslint-disable-next-line react/no-array-index-key
                <span
                  key={level}
                  aria-hidden
                  className="w-3.5 shrink-0 border-l border-line-soft/70"
                />
              ))}

              {editable ? (
                <label
                  className={cn(
                    'grid w-5 shrink-0 cursor-pointer place-items-center transition',
                    picked.size ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
                  )}
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(id)}
                    onChange={() => onPick(id)}
                    className="size-3 accent-brand-500"
                  />
                </label>
              ) : null}

              {/* The twisty, or a space where one would be, so the icons line up. */}
              {row.hasChildren && !filtering ? (
                <button
                  type="button"
                  onClick={() => onToggleCollapse(id)}
                  className="grid w-4 shrink-0 place-items-center text-fg-subtle transition hover:text-fg"
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}

              <button
                type="button"
                onClick={() => onSelect(row._id)}
                title={row.target || row.summary || row.title || undefined}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left"
              >
                <NodeIcon row={row} collapsed={isCollapsed} />

                <span className="shrink-0 font-mono text-[0.625rem] text-fg-subtle">{row.path}</span>

                <span
                  className={cn(
                    'truncate text-xs',
                    row.hasChildren ? 'font-semibold' : 'font-medium',
                    row.heldBack ? 'text-fg-muted line-through decoration-fg-subtle/50' : '',
                    isSelected ? 'text-brand-200' : 'text-fg'
                  )}
                >
                  {row.title || 'Untitled step'}
                </span>

                {/* Chips, in one line, ordered by how often somebody scans for them. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[0.625rem] text-fg-subtle">
                  {isCollapsed ? (
                    <span
                      className="rounded bg-white/[0.06] px-1 font-mono"
                      title={`${inside} rows inside`}
                    >
                      {inside}
                    </span>
                  ) : null}
                  {row.tool && full ? (
                    <span className="max-w-[7rem] truncate font-mono text-brand-200/70">
                      {row.tool}
                    </span>
                  ) : null}
                  {outputLines ? (
                    <span
                      className="inline-flex items-center gap-0.5 font-mono"
                      title={`${outputLines} lines of output`}
                    >
                      <Terminal size={9} />
                      {outputLines}
                    </span>
                  ) : null}
                  {row.outputStale ? (
                    <span
                      className="font-mono text-med/80"
                      title={`Output is ${row.outputAge} days old — worth re-running before this ships`}
                    >
                      {row.outputAge}d
                    </span>
                  ) : null}
                  {row.noteCount ? (
                    <span
                      className={cn(
                        'inline-flex items-center gap-0.5 font-mono',
                        row.notesStale ? 'text-med' : ''
                      )}
                      title={
                        row.notesStale
                          ? `${row.noteCount} marked line(s), ${row.notesStale} no longer in the output`
                          : `${row.noteCount} marked line(s)`
                      }
                    >
                      <MessageSquare size={9} />
                      {row.noteCount}
                    </span>
                  ) : null}
                  {row.findings?.length ? (
                    <span
                      className="inline-flex items-center gap-0.5 text-low"
                      title={`Written up as ${row.findings.length} finding(s)`}
                    >
                      <Bug size={9} />
                      {row.findings.length}
                    </span>
                  ) : null}
                  {row.status ? (
                    <span
                      className={cn('size-1.5 rounded-full', STATUS_DOT[row.status])}
                      title={STATUS_TITLE[row.status]}
                    />
                  ) : null}
                </span>
              </button>

              {editable ? (
                <button
                  type="button"
                  onClick={() => onAddChild(row._id)}
                  title="Add a step under this one"
                  className="grid w-6 shrink-0 place-items-center text-fg-subtle opacity-0 transition hover:bg-white/10 hover:text-fg focus:opacity-100 group-hover/row:opacity-100"
                >
                  <Plus size={12} />
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
