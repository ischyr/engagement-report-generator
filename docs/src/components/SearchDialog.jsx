import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search as SearchIcon } from 'lucide-react';

import { search } from '../lib/search.js';

/**
 * Search, as a palette.
 *
 * Keyboard-first, because the people reading this spend their day in a terminal: Ctrl+K or `/` to
 * open, arrows to move, Enter to go, Escape to leave. The mouse works too, but nothing here needs
 * it.
 *
 * Results are sections rather than pages — a heading and the sentence that matched — so Enter lands
 * on the paragraph that answers the question instead of the top of a long page.
 */
export default function SearchDialog({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef(null);
  const navigate = useNavigate();

  const results = useMemo(() => search(query), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    /* After the dialog is actually in the document, or the focus lands on nothing. */
    const timer = setTimeout(() => input.current?.focus(), 10);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  const go = (result) => {
    if (!result) return;
    navigate(`/${result.slug}${result.id ? `#${result.id}` : ''}`);
    onClose();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') return onClose();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      return setCursor((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      return setCursor((index) => Math.max(index - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return go(results[cursor]);
    }
    return undefined;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        /* The backdrop closes; a click that started inside the panel does not. */
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the documentation"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4">
          <SearchIcon size={16} className="shrink-0 text-fg-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search — templates, locks, the rate card…"
            className="h-12 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
          <kbd className="hidden rounded border border-line-soft px-1.5 py-0.5 font-mono text-[0.625rem] text-fg-subtle sm:inline">
            Esc
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!query.trim() ? (
            <p className="px-2 py-6 text-center text-xs text-fg-subtle">
              Type to search every page. Arrows to move, Enter to open.
            </p>
          ) : results.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-fg-subtle">
              Nothing matches “{query}”. Every word has to appear somewhere on the page.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {results.map((result, index) => (
                <li key={`${result.slug}-${result.id}-${index}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => go(result)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition ${
                      index === cursor ? 'bg-brand-500/12' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm text-fg">{result.heading || result.page}</span>
                      {result.heading ? (
                        <span className="text-[0.6875rem] text-fg-subtle">in {result.page}</span>
                      ) : (
                        <span className="text-[0.6875rem] text-fg-subtle">{result.section}</span>
                      )}
                      {index === cursor ? (
                        <CornerDownLeft size={12} className="ml-auto shrink-0 text-fg-subtle" />
                      ) : null}
                    </span>
                    {result.excerpt ? (
                      <span className="line-clamp-2 text-xs text-fg-muted">{result.excerpt}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
