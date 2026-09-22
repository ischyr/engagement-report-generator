import { Highlighter } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Modal } from '../ui/Modal.jsx';
import { EmptyState } from '../ui/Feedback.jsx';

/**
 * Which line of this pane is the point.
 *
 * A proof of concept is forty lines of request and one line that matters, and until now the only
 * way to say which was to write "note the Set-Cookie header on line 4" underneath and hope the
 * reader counted. The .docx converter has drawn marked lines in the accent colour since the
 * enumeration panes gained them; this is the write-up finally being able to ask for one.
 *
 * **The lines, not a box to type numbers into.** The numbers are the thing you are least able to
 * be sure of — a pane you have edited twice has moved them — and picking the line you can see is
 * the only version of this that cannot be wrong. It is also how the enumeration pane already
 * works, where the number itself is the button.
 *
 * Long lines are shown in full and allowed to scroll rather than truncated: the end of a line is
 * routinely how you tell two near-identical requests apart, which is exactly when you are choosing
 * between them.
 */
export default function MarkLinePicker({ open, onClose, lines = [], marked = new Set(), onToggle }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Highlight a line"
      description="Marked lines are drawn in the accent colour in the report, so a reader's eye lands on them without being told where to look. Click a line to mark it, and again to unmark it."
      size="lg"
    >
      {lines.length === 0 ? (
        <EmptyState
          icon={Highlighter}
          title="Nothing in this pane yet"
          description="Paste the request or the output first, then come back and point at the line that matters."
        />
      ) : (
        <ul className="flex max-h-[60vh] flex-col overflow-y-auto rounded-lg border border-line-soft">
          {lines.map((line, index) => {
            const number = index + 1;
            const on = marked.has(number);
            return (
              <li key={number}>
                <button
                  type="button"
                  onClick={() => onToggle(number)}
                  className={cn(
                    'flex w-full items-start gap-3 px-3 py-1 text-left font-mono text-[0.6875rem] transition',
                    on ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-white/5'
                  )}
                >
                  <span
                    className={cn(
                      'w-8 shrink-0 select-none text-right tabular-nums',
                      on ? 'font-semibold text-accent' : 'text-fg-subtle'
                    )}
                  >
                    {number}
                  </span>
                  {/*
                    `pre` rather than a div: the leading spaces of an indented line are part of what
                    somebody is looking at, and collapsing them makes two lines of a JSON body look
                    like the same line.
                  */}
                  <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre">
                    {line === '' ? ' ' : line}
                  </pre>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
