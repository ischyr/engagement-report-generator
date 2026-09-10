import { ImageIcon, Quote } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Modal } from '../ui/Modal.jsx';
import { EmptyState } from '../ui/Feedback.jsx';

/**
 * Which figure this sentence is about.
 *
 * Deliberately small: the finding's screenshots in the order the report prints them, and clicking
 * one drops a reference where the cursor is. There is no search box because a finding has three
 * screenshots, not thirty.
 *
 * **Every screenshot**, captioned or not and wherever it sits, because the report numbers every
 * screenshot in it.
 *
 * The number shown beside each one is its position *in this finding*, not in the report. The
 * report's number depends on where the finding lands in the document, which the template decides
 * and which nothing in a browser can know.
 */
export default function FigureRefPicker({ open, onClose, figures, onPick }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refer to a figure"
      description="Drops a reference where the cursor is. It prints as “Figure 7” — the number is worked out when the report is generated, because it depends on where this finding lands in it."
      size="md"
    >
      {figures.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No screenshots in this finding"
          description="Paste one and it becomes a numbered figure you can refer to from anywhere in this finding."
        />
      ) : (
          <ul className="flex flex-col gap-1.5">
            {figures.map((figure) => (
              <li key={figure.media}>
                <button
                  type="button"
                  onClick={() => onPick(figure)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/5"
                >
                  <span className="mt-0.5 shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                    {figure.index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm',
                        figure.label ? 'text-fg' : 'italic text-fg-muted'
                      )}
                    >
                      {/* No caption is the common case, so it reads as a state rather than a gap. */}
                      {figure.label || 'an uncaptioned screenshot'}
                    </span>
                    <span className="block truncate text-[0.6875rem] text-fg-subtle">
                      in the {figure.field}
                    </span>
                  </span>
                  <Quote size={13} className="mt-1 shrink-0 text-fg-subtle" />
                </button>
              </li>
            ))}
          </ul>
      )}
    </Modal>
  );
}
