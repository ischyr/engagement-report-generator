import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GitCompare,
  Highlighter,
  Table2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input } from '../ui/Field.jsx';

/** Beyond this, the pane folds. A sweep of 4000 hosts must not push the write-up off the page. */
const FOLD_AT = 40;

/**
 * What changed between two runs of the same thing.
 *
 * A set difference rather than a line-by-line diff, deliberately. Enumeration output is
 * overwhelmingly a *list* — hosts, subdomains, ports, users — and the only question anybody asks of
 * a re-run is "what is there now that was not, and what has gone". A positional diff of a list
 * whose order changed would report every line as both added and removed, which answers nothing.
 */
function compare(current, previous) {
  const lines = (value) =>
    String(value ?? '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  const now = lines(current);
  const then = lines(previous);
  const nowSet = new Set(now);
  const thenSet = new Set(then);
  return {
    appeared: now.filter((line) => !thenSet.has(line)),
    gone: then.filter((line) => !nowSet.has(line)),
    unchanged: now.filter((line) => thenSet.has(line)).length,
  };
}

/**
 * The marked lines, listed above the output they came from.
 *
 * A list as well as the highlight in the pane, and the list is the important half: the pane folds at
 * forty lines and the interesting line is routinely the two-hundredth, so a highlight alone would be
 * a mark on something nobody scrolls to. This is also the shape the report prints — the line and the
 * sentence about it — so what is on screen is what the reader will get.
 */
function MarkedLines({ notes, onJump, onEdit, onRemove, editable, focusId }) {
  const [editing, setEditing] = useState(null);
  const [text, setText] = useState('');
  const boxRef = useRef(null);

  /* Clicking a marked line in the pane opens its note here, which is where the words go. */
  useEffect(() => {
    if (!focusId) return;
    const note = notes.find((entry) => String(entry._id) === String(focusId));
    if (!note) return;
    setEditing(String(focusId));
    setText(note.text ?? '');
    boxRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusId, notes]);

  if (!notes.length) return null;

  const commit = async (id) => {
    await onEdit(id, text);
    setEditing(null);
  };

  return (
    <div ref={boxRef} className="overflow-hidden rounded-lg border border-brand-500/25 bg-brand-500/[0.06]">
      <p className="flex items-center gap-1.5 border-b border-brand-500/20 px-3 py-1.5 text-[0.625rem] font-medium text-brand-200">
        <Highlighter size={11} />
        {notes.length} marked line{notes.length === 1 ? '' : 's'}
        <span className="font-normal text-fg-subtle">— these print with the report</span>
      </p>
      <ul className="divide-y divide-brand-500/10">
        {notes.map((note) => (
          <li key={note._id} className="px-3 py-1.5">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onJump(note.line)}
                className="shrink-0 font-mono text-[0.625rem] text-brand-200/80 hover:underline"
                title={note.stale ? 'This line is no longer in the output' : `Go to line ${note.line}`}
              >
                {note.stale ? '—' : note.line}
              </button>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate font-mono text-[0.625rem]',
                    note.stale ? 'text-fg-subtle line-through' : 'text-fg-muted'
                  )}
                  title={note.snippet}
                >
                  {note.snippet || '(blank line)'}
                </p>
                {editing === String(note._id) ? (
                  <div className="mt-1 flex items-center gap-1.5">
                    <Input
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      value={text}
                      placeholder="What is interesting about this line?"
                      wrapperClassName="flex-1"
                      className="text-xs"
                      onChange={(event) => setText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commit(note._id);
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                    <Button variant="primary" size="sm" onClick={() => commit(note._id)}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() => {
                      setEditing(String(note._id));
                      setText(note.text ?? '');
                    }}
                    className={cn(
                      'mt-0.5 block w-full truncate text-left text-xs',
                      note.text ? 'text-fg' : 'text-fg-subtle italic',
                      editable ? 'hover:text-brand-200' : 'cursor-default'
                    )}
                  >
                    {note.text || (editable ? 'Say why this line matters…' : 'No note')}
                  </button>
                )}
                {note.stale ? (
                  <p className="mt-0.5 flex items-center gap-1 text-[0.625rem] text-med">
                    <TriangleAlert size={9} />
                    This line is not in the current output — it is left here rather than dropped, and
                    it will not print.
                  </p>
                ) : null}
                {note.moved ? (
                  <p className="mt-0.5 text-[0.625rem] text-fg-subtle">
                    Followed its line to {note.line} after the output changed.
                  </p>
                ) : null}
              </div>
              {editable ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={Trash2}
                  title="Unmark this line"
                  className="shrink-0 hover:text-crit"
                  onClick={() => onRemove(note._id)}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tool output, read-only, as the report will print it.
 *
 * Separate from the textarea it is edited in: while you are pasting, what you want is a plain box
 * that does not fight you; once it is saved, what you want is to *read* it — numbered, foldable,
 * copyable, and comparable against the last run.
 */
export default function OutputPane({
  output,
  previous,
  previousAt,
  table,
  notes = [],
  onMark,
  onEditNote,
  onRemoveNote,
  editable = false,
}) {
  const [expanded, setExpanded] = useState(false);
  /** Which note's input to open, when a marked line in the pane was clicked. */
  const [focusNote, setFocusNote] = useState(null);
  const paneRef = useRef(null);
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  /*
   * Columns by default when the shape was recognised.
   *
   * The parse is conservative — it only produced a table because it was confident — and columns are
   * what somebody wants to read. Raw is one click away, and stays the fallback for everything the
   * parser declines, which is most output.
   */
  const [asTable, setAsTable] = useState(true);

  const lines = useMemo(() => String(output ?? '').replace(/\s+$/, '').split(/\r?\n/), [output]);
  /* By line, so drawing four hundred rows is four hundred lookups rather than four hundred scans. */
  const noteByLine = useMemo(() => {
    const map = new Map();
    for (const note of notes) if (!note.stale) map.set(Number(note.line), note);
    return map;
  }, [notes]);
  const diff = useMemo(
    () => (previous ? compare(output, previous) : null),
    [output, previous]
  );

  if (!String(output ?? '').trim()) return null;

  const folded = !expanded && lines.length > FOLD_AT;
  const shown = folded ? lines.slice(0, FOLD_AT) : lines;
  const showingTable = Boolean(table?.rows?.length) && asTable && !showDiff;

  /*
   * A line the reader asked for, brought on screen.
   *
   * Unfolding first and scrolling on the next frame, because the row does not exist to scroll to
   * until the fold has actually opened.
   */
  const jumpTo = (line) => {
    setExpanded(true);
    requestAnimationFrame(() => {
      paneRef.current
        ?.querySelector(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* A clipboard the browser refuses is not worth an error dialog; the text is on screen. */
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[0.6875rem] font-medium text-fg-muted">
          Output
          <span className="ml-1.5 font-normal text-fg-subtle">
            {lines.length} line{lines.length === 1 ? '' : 's'}
          </span>
        </p>
        <div className="ml-auto flex items-center gap-1">
          {table?.rows?.length ? (
            <Button
              variant={asTable ? 'primary' : 'ghost'}
              size="sm"
              icon={Table2}
              onClick={() => {
                setAsTable((v) => !v);
                setShowDiff(false);
              }}
              title={`Read as ${table.columns.length} columns — parsed from ${table.parser} output`}
            >
              Table
            </Button>
          ) : null}
          {diff && (diff.appeared.length || diff.gone.length) ? (
            <Button
              variant={showDiff ? 'primary' : 'ghost'}
              size="sm"
              icon={GitCompare}
              onClick={() => setShowDiff((v) => !v)}
              title={
                previousAt
                  ? `Compare with the run replaced on ${new Date(previousAt).toLocaleString()}`
                  : 'Compare with the previous run'
              }
            >
              {diff.appeared.length ? `+${diff.appeared.length}` : ''}
              {diff.appeared.length && diff.gone.length ? ' ' : ''}
              {diff.gone.length ? `−${diff.gone.length}` : ''}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={copied ? Check : Copy}
            onClick={copy}
            title="Copy the output"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      <MarkedLines
        notes={notes}
        onJump={jumpTo}
        onEdit={onEditNote}
        onRemove={onRemoveNote}
        editable={editable && Boolean(onEditNote)}
        focusId={focusNote}
      />

      {showingTable ? (
        <div className="overflow-hidden rounded-lg border border-line-soft bg-canvas/60">
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full border-collapse text-left text-[0.6875rem]">
              <thead className="sticky top-0 bg-surface/95 backdrop-blur">
                <tr>
                  {table.columns.map((column) => (
                    <th
                      key={column}
                      className="whitespace-nowrap border-b border-line-soft px-3 py-1.5 font-medium text-fg-muted"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={index} className="border-b border-line-soft/50 last:border-0">
                    {row.map((cell, cellIndex) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <td
                        key={cellIndex}
                        className="max-w-[28rem] break-words px-3 py-1 align-top font-mono text-fg-muted"
                      >
                        {cell || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line-soft px-3 py-1.5 text-[0.625rem] text-fg-subtle">
            {table.rows.length} row{table.rows.length === 1 ? '' : 's'} read from {table.parser}{' '}
            output. The report can print this as a Word table with{' '}
            <code className="font-mono">{'{{@rich.outputTable}}'}</code>.
          </p>
        </div>
      ) : showDiff && diff ? (
        <div className="overflow-hidden rounded-lg border border-line-soft bg-canvas/60">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2 text-[0.625rem] text-fg-subtle">
            <Badge tone="success">{diff.appeared.length} appeared</Badge>
            <Badge tone="danger">{diff.gone.length} gone</Badge>
            <span>{diff.unchanged} unchanged</span>
            {previousAt ? <span>· replaced {new Date(previousAt).toLocaleString()}</span> : null}
          </div>
          <div className="max-h-72 overflow-auto px-3 py-2 font-mono text-[0.6875rem] leading-[1.5]">
            {diff.appeared.map((line) => (
              <div key={`+${line}`} className="whitespace-pre-wrap break-words text-low">
                <span className="select-none pr-2 text-low/70">+</span>
                {line}
              </div>
            ))}
            {diff.gone.map((line) => (
              <div key={`-${line}`} className="whitespace-pre-wrap break-words text-crit">
                <span className="select-none pr-2 text-crit/70">−</span>
                {line}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line-soft bg-canvas/60">
          <div ref={paneRef} className={cn('overflow-auto', folded ? '' : 'max-h-[32rem]')}>
            {/*
              `table-fixed` is what actually makes the wrapping happen. With the default automatic
              layout a cell is as wide as its widest content, so a four-thousand-character line
              simply made the table four thousand characters wide and `pre-wrap` never had a width
              to wrap against. Fixed layout gives the gutter its 2.5rem and hands the rest to the
              text, which is then forced to fold.
            */}
            <table className="w-full table-fixed border-collapse font-mono text-[0.6875rem] leading-[1.5]">
              <tbody>
                {shown.map((line, index) => {
                  const number = index + 1;
                  const note = noteByLine.get(number);
                  return (
                    // eslint-disable-next-line react/no-array-index-key
                    <tr key={index} data-line={number} className={note ? 'bg-brand-500/[0.10]' : ''}>
                      {/*
                        The number is in its own cell rather than prefixed to the text, so
                        select-and-copy from the pane takes the output and not the gutter. It is also
                        the target for marking a line: the gutter is the one part of a code pane that
                        is not text somebody might want to select.
                      */}
                      <td className="w-10 select-none border-r border-line-soft/60 p-0 text-right align-top">
                        {onMark && editable ? (
                          <button
                            type="button"
                            onClick={() => (note ? setFocusNote(String(note._id)) : onMark(number))}
                            title={note ? 'Edit this note' : 'Mark this line'}
                            className={cn(
                              'w-full px-2 text-right transition',
                              note
                                ? 'font-medium text-brand-200'
                                : 'text-fg-subtle/60 hover:bg-brand-500/15 hover:text-brand-200'
                            )}
                          >
                            {number}
                          </button>
                        ) : (
                          <span
                            className={cn(
                              'block px-2',
                              note ? 'font-medium text-brand-200' : 'text-fg-subtle/60'
                            )}
                          >
                            {number}
                          </span>
                        )}
                      </td>
                      {/*
                        `pre-wrap` rather than `pre`: the spacing that lines columns up is kept,
                        and only a line too long for the pane wraps. `break-words` is for the
                        thing that has no spaces at all — a base64 blob, a 300-character URL —
                        which would otherwise still run off the side.
                      */}
                      <td className="whitespace-pre-wrap break-words px-3 align-top text-fg-muted">
                        {line || ' '}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lines.length > FOLD_AT ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-[0.625rem] text-fg-muted transition hover:bg-white/[0.035] hover:text-fg"
            >
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {expanded ? 'Fold' : `Show all ${lines.length} lines`}
              {!expanded && noteByLine.size
                ? (() => {
                    const beyond = [...noteByLine.keys()].filter((line) => line > FOLD_AT).length;
                    return beyond ? ` · ${beyond} marked below` : '';
                  })()
                : ''}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
