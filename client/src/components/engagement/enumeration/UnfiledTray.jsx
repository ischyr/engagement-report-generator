import { useState } from 'react';
import { ClipboardPaste, FolderInput, Inbox, Loader2, Trash2 } from 'lucide-react';

import { cn, timeAgo } from '../../../lib/utils.js';
import { Button } from '../../ui/Button.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { Select } from '../../ui/Field.jsx';

/**
 * Output saved before anybody decided where it goes.
 *
 * The tree is a document — a step lives under a heading, in the order it happened, with a title
 * that says what it was for. That is the right shape for writing up and the wrong one for the
 * moment the output exists: mid-operation, three terminals open, wanting it saved before it
 * scrolls away. Made to pick a parent and a title first, people paste into a text file instead and
 * the app never sees the run at all.
 *
 * So this takes a paste and asks nothing. The step is real — searchable, diffable, it holds its
 * output like any other — it simply has nowhere to live yet, and sits here until somebody files it.
 *
 * ## Above the tree, and it disappears when it is empty
 *
 * A permanent empty tray is a permanent reminder of a thing you are not doing. This is drawn only
 * when there is something in it, or while the paste box is open — so an operation nobody uses it
 * on looks exactly as it did before.
 */

/** The dialog that takes the paste. Deliberately one field. */
export function QuickPasteDialog({ open, onClose, onSave, busy }) {
  const [text, setText] = useState('');

  const save = async () => {
    const output = text.trim();
    if (!output || busy) return;
    await onSave(output);
    setText('');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Paste output"
      description="Saved as it is, with no home yet. Name it and put it in the tree when there is time."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <p className="text-[0.6875rem] text-fg-subtle">
            It is held back from the report until you file it.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={busy ? Loader2 : ClipboardPaste} onClick={save} disabled={busy || !text.trim()}>
              Save it
            </Button>
          </div>
        </div>
      }
    >
      <textarea
        data-autofocus
        rows={16}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          /* The shortcut every textarea that is really a submit box should have. */
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save();
        }}
        placeholder="Paste the output here…"
        className="w-full rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-fg outline-none focus:border-brand-400"
      />
      <p className="mt-2 text-[0.6875rem] text-fg-subtle">
        The first line becomes its name — which is usually the tool announcing itself, and always
        something you will recognise in the tray. Ctrl+Enter saves.
      </p>
    </Modal>
  );
}

/** Where a filed paste should go. */
function FileDialog({ step, sections, onClose, onFile, busy }) {
  const [parent, setParent] = useState('');

  return (
    <Modal
      open={Boolean(step)}
      onClose={onClose}
      size="sm"
      title="File this paste"
      description={step?.title}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={busy ? Loader2 : FolderInput} disabled={busy} onClick={() => onFile(parent || null)}>
            File it
          </Button>
        </div>
      }
    >
      <Select
        label="Put it under"
        value={parent}
        onChange={(event) => setParent(event.target.value)}
        options={[
          { value: '', label: 'Nothing — at the top level' },
          ...sections.map((section) => ({ value: String(section._id), label: section.title || 'Untitled' })),
        ]}
        hint="It joins the tree in reading order, and starts printing in the report."
      />
    </Modal>
  );
}

export default function UnfiledTray({ rows, sections, selectedId, onSelect, onFile, onDelete, editable, busy }) {
  const [filing, setFiling] = useState(null);

  if (!rows.length) return null;

  return (
    <div className="mb-2 rounded-lg border border-dashed border-line bg-canvas/40 p-2">
      <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wider text-fg-subtle">
        <Inbox size={12} />
        Unfiled ({rows.length})
      </p>

      {rows.map((row) => (
        <div
          key={row._id}
          className={cn(
            'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            String(row._id) === String(selectedId)
              ? 'bg-brand-500/12 text-brand-300'
              : 'text-fg-muted hover:bg-white/5 hover:text-fg'
          )}
        >
          <button
            type="button"
            onClick={() => onSelect(row._id)}
            className="min-w-0 flex-1 truncate text-left"
            title={row.title}
          >
            {row.title || 'Untitled paste'}
            <span className="ml-2 text-[0.6875rem] text-fg-subtle">
              {row.outputLines ? `${row.outputLines} lines` : 'no output'}
              {row.outputAt ? ` · ${timeAgo(row.outputAt)}` : ''}
            </span>
          </button>

          {editable ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                icon={FolderInput}
                title="File it into the tree"
                onClick={() => setFiling(row)}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                icon={Trash2}
                title="Delete it"
                onClick={() => onDelete(row)}
                className="opacity-0 transition-opacity hover:text-crit focus-visible:opacity-100 group-hover:opacity-100"
              />
            </>
          ) : null}
        </div>
      ))}

      <FileDialog
        step={filing}
        sections={sections}
        busy={busy}
        onClose={() => setFiling(null)}
        onFile={async (parent) => {
          await onFile(filing, parent);
          setFiling(null);
        }}
      />
    </div>
  );
}
