import { useMemo, useState } from 'react';
import { BookmarkPlus, Search, Share2, Trash2, User } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, htmlToSnippet } from '../../lib/utils.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input } from '../ui/Field.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Reusable text, pasted where the cursor is.
 *
 * The vulnerability library covers findings; everything else got retyped every engagement — the
 * paragraph about how testing was authorised, a client's standing quirk, the payload that works
 * against that one WAF, the caveat legal asked for last year.
 *
 * Insert copies the snippet's HTML rather than referencing it: what goes into a report is a
 * document, not a live link, and a snippet edited next month must not silently rewrite a report
 * that was signed off last month.
 */
export default function SnippetPicker({ open, onClose, onInsert, selectionHtml = '' }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(open ? '/snippets' : null, { initial: [] });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const rows = data ?? [];
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, ...(row.tags ?? []), htmlToSnippet(row.body, 400)]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  }, [data, needle]);

  const insert = async (snippet) => {
    onInsert?.(snippet.body);
    onClose?.();
    // Counted separately from reading the list: reading is not using, and the count is what puts
    // the three you actually paste at the top without anybody arranging them.
    api.post(`/snippets/${snippet._id}/used`, {}).catch(() => {});
  };

  const saveSelection = async () => {
    if (!title.trim() || !selectionHtml) return;
    setSaving(true);
    try {
      await api.post('/snippets', { title: title.trim(), body: selectionHtml });
      setTitle('');
      await reload({ quiet: true });
      toast.success('Saved as a snippet', 'It is yours until you share it.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (snippet) => {
    try {
      await api.del(`/snippets/${snippet._id}`);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const share = async (snippet) => {
    try {
      await api.put(`/snippets/${snippet._id}`, { shared: !snippet.shared });
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Snippets"
      description="Text worth keeping that is not a finding. Yours, and anything the team has shared."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Saving what is selected is the way most of these get created in the first place. */}
        {selectionHtml ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-brand-500/25 bg-brand-500/[0.06] p-3">
            <Input
              label="Save what you have selected"
              wrapperClassName="min-w-0 flex-1"
              placeholder="Authorisation paragraph"
              hint={`“${htmlToSnippet(selectionHtml, 60)}”`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button
              variant="primary"
              icon={BookmarkPlus}
              loading={saving}
              disabled={!title.trim()}
              onClick={saveSelection}
            >
              Save
            </Button>
          </div>
        ) : null}

        <div className="flex items-center gap-2 rounded-lg bg-canvas/60 px-2.5 py-2 ring-1 ring-line">
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search snippets…"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>

        {loading && !(data ?? []).length ? (
          <LoadingBlock label="Reading your snippets…" />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={BookmarkPlus}
            title={(data ?? []).length ? 'Nothing matches that' : 'No snippets yet'}
            description={
              (data ?? []).length
                ? 'Try a different word.'
                : 'Select some text in the editor and open this again — the first one is usually the paragraph you have already written twice.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map((snippet) => (
              <li
                key={snippet._id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => insert(snippet)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs font-medium text-fg">{snippet.title}</span>
                    {snippet.shared ? (
                      <Badge tone="info" icon={Share2}>
                        shared
                      </Badge>
                    ) : null}
                    {!snippet.mine ? (
                      <span className="flex items-center gap-1 text-[0.625rem] text-fg-subtle">
                        <User size={10} />
                        {snippet.owner?.firstname || snippet.owner?.username || 'somebody'}
                      </span>
                    ) : null}
                    {snippet.uses ? (
                      <span className="font-mono text-[0.5625rem] text-fg-subtle">
                        used {snippet.uses}×
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                    {htmlToSnippet(snippet.body, 90) || 'Empty'}
                  </span>
                </button>

                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => insert(snippet)}>
                    Insert
                  </Button>
                  {snippet.mine ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Share2}
                        title={snippet.shared ? 'Make it private again' : 'Share with the team'}
                        className={cn(snippet.shared && 'text-info')}
                        onClick={() => share(snippet)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Delete"
                        className="hover:text-crit"
                        onClick={() => remove(snippet)}
                      />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-[0.625rem] leading-relaxed text-fg-subtle">
          Inserting copies the text in. A snippet edited next month does not rewrite a report that
          was signed off last month — what goes into a document is a document.
        </p>
      </div>
    </Modal>
  );
}
