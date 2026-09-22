import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Modal } from '../ui/Modal.jsx';
import { Input } from '../ui/Field.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { SeverityBadge } from '../ui/Badge.jsx';

/**
 * Which finding this sentence is about.
 *
 * A search box, unlike the figure picker — a finding has three screenshots and an engagement has
 * forty findings, and scrolling forty rows to find "the SSRF one" is the thing this is supposed to
 * save. Matching is over the title and the identifier together, so both "VULN-12" and "ssrf" land.
 *
 * The finding the cursor is currently in is excluded. A reference from a finding to itself is
 * always a mistake and never anything else, and offering it invites the mistake.
 *
 * The identifier shown here is the one the finding carries *now*. What prints in the document is
 * the one it carries when the report is built — the two differ if anything is renumbered in
 * between, which is exactly why the chip stores the id rather than the label.
 */
export default function FindingRefPicker({ open, onClose, findings, exclude, onPick }) {
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (findings ?? [])
      .filter((finding) => String(finding.id ?? finding._id) !== String(exclude ?? ''))
      .filter((finding) => {
        if (!needle) return true;
        return `${finding.identifier ?? ''} ${finding.title ?? ''}`.toLowerCase().includes(needle);
      });
  }, [findings, exclude, query]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refer to another finding"
      description="Drops a reference where the cursor is. It prints as the finding’s identifier — worked out when the report is generated, so it survives renumbering."
      size="md"
    >
      {(findings ?? []).length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No other findings yet"
          description="Write a second finding and this sentence will be able to point at it."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title or identifier…"
          />
          {rows.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-fg-subtle">
              Nothing matches “{query}”.
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
              {rows.map((finding) => (
                <li key={String(finding.id ?? finding._id)}>
                  <button
                    type="button"
                    onClick={() => onPick(finding)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                      'hover:bg-white/5'
                    )}
                  >
                    <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                      {finding.identifier ?? '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {finding.title || 'Untitled finding'}
                    </span>
                    {finding.severity ? <SeverityBadge severity={finding.severity} /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
