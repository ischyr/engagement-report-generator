import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Clock,
  CornerDownLeft,
  FileSignature,
  FileText,
  ListChecks,
  NotebookPen,
  Search,
  ScrollText,
  ShieldAlert,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSearchMemory } from '../../hooks/useSearchMemory.js';
import { useDebounced } from '../../hooks/useResource.js';
import { cn } from '../../lib/utils.js';
import { SeverityBadge } from '../ui/Badge.jsx';
import { Spinner } from '../ui/Feedback.jsx';

const TYPE_META = {
  engagement: { icon: ScrollText, label: 'Engagement' },
  finding: { icon: ShieldAlert, label: 'Finding' },
  section: { icon: ListChecks, label: 'Section' },
  note: { icon: NotebookPen, label: 'Note' },
  library: { icon: FileText, label: 'Library' },
  client: { icon: Building2, label: 'Contact' },
  /* The Sales section's own kinds. `client` is shared — a contact is a contact either way. */
  proposal: { icon: FileSignature, label: 'Proposal' },
  salesClient: { icon: Building2, label: 'Client' },
};

/**
 * Search across everything the user can see — engagements, findings, sections,
 * notes, library entries and contacts.
 *
 * Opens on Ctrl/Cmd+K and behaves like a command palette: arrow keys move,
 * Enter opens, Escape closes. Findings are the common target, so results show
 * severity and the field the match came from.
 *
 * A sales account searches a different endpoint over different things — clients, contacts and
 * proposals — because everything this one looks through answers 403 for them. One component
 * rather than two, because the palette, the keyboard handling and the recent-search memory are
 * the same problem twice; only the endpoint and the result kinds differ, and the endpoints
 * deliberately answer in the same shape.
 */
export default function GlobalSearch() {
  const navigate = useNavigate();
  const { user, isSales } = useAuth();
  const { queries, opened, remember, forget } = useSearchMemory(
    String(user?.id ?? user?._id ?? '')
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ results: [], loading: false, total: 0 });
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const debounced = useDebounced(query, 250);

  // Ctrl/Cmd+K from anywhere.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setState({ results: [], loading: false, total: 0 });
      return undefined;
    }
    requestAnimationFrame(() => inputRef.current?.focus());

    // Stop the page behind from scrolling under the overlay, same as the dialogs.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    const needle = debounced.trim();
    if (needle.length < 2) {
      setState({ results: [], loading: false, total: 0 });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    api
      .get(`${isSales ? '/sales/search' : '/search'}?q=${encodeURIComponent(needle)}`)
      .then((data) => {
        if (cancelled) return;
        setState({ results: data.results ?? [], loading: false, total: data.total ?? 0 });
        setActive(0);
      })
      .catch(() => {
        if (!cancelled) setState({ results: [], loading: false, total: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, isSales]);

  const results = state.results;
  const idle = query.trim().length < 2;

  /**
   * What the arrow keys walk.
   *
   * With something typed it is the results; with an empty box it is the memory, so the keyboard
   * path to "the thing I had open before lunch" is Ctrl-K, down, Enter.
   */
  const navigable = idle
    ? [
        ...opened,
        ...queries.map((text) => ({ __recentQuery: text, title: text, href: null })),
      ]
    : results;

  const go = (result) => {
    if (!result) return;
    // Remembered here rather than as somebody types: a query abandoned halfway is not one to
    // offer back, and a debounced box would store "x", "xs" and "xss" as three memories.
    remember(query, result);
    setOpen(false);
    navigate(result.href);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, navigable.length - 1)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = navigable[active];
      if (!chosen) return;
      // With an empty box the arrow keys walk what you opened before, so Enter opens that.
      if (chosen.__recentQuery) setQuery(chosen.__recentQuery);
      else go(chosen);
    }
  };

  const hint = useMemo(() => {
    if (state.loading) return 'Searching…';
    if (query.trim().length === 1) return 'Keep typing…';
    if (!query.trim()) {
      return opened.length || queries.length
        ? 'Where you were, and what you looked for'
        : 'Engagements, findings, sections, notes, library, contacts';
    }
    if (!results.length) return 'Nothing found';
    return `${state.total} result${state.total === 1 ? '' : 's'}`;
  }, [state, query, results.length, opened.length, queries.length]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg bg-canvas/60 px-2.5 py-2 text-left ring-1 ring-line transition hover:ring-brand-500/40"
      >
        <Search size={14} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">Search…</span>
        <kbd className="shrink-0 rounded border border-line bg-surface px-1 font-mono text-[0.625rem] text-fg-subtle">
          Ctrl K
        </kbd>
      </button>

      {/*
        Rendered into document.body rather than in place. This sits inside the
        sticky sidebar, and a fixed overlay nested there was being painted under
        the main column however high its z-index went — the same reason the
        dialogs portal out.
      */}
      {open
        ? createPortal(
        <div className="fixed inset-0 z-100 flex items-start justify-center p-4 pt-[12vh]">
          <button
            type="button"
            aria-label="Close search"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 cursor-default bg-canvas/80 backdrop-blur-md"
            style={{ animation: 'search-fade 140ms ease-out' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            className="relative w-full max-w-2xl overflow-hidden rounded-card border border-line bg-overlay shadow-pop"
            style={{ animation: 'search-in 180ms cubic-bezier(.16,1,.3,1)' }}
          >
            <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
              <Search size={16} className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isSales ? 'Search clients, contacts and proposals…' : 'Search everything…'}
                className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
              />
              {state.loading ? <Spinner size={14} /> : null}
            </div>

            <div className="max-h-[55vh] overflow-y-auto">
              {/*
                An empty box is not an empty screen.

                What you opened, then what you searched for — in that order, because the thing
                you want back is usually a finding rather than the words you found it with.
              */}
              {idle && (opened.length || queries.length) ? (
                <div className="py-1">
                  {opened.length ? (
                    <>
                      <p className="px-4 pb-1 pt-2 text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                        Recently opened
                      </p>
                      <ul>
                        {opened.map((entry, index) => {
                          const meta = TYPE_META[entry.type] ?? TYPE_META.engagement;
                          return (
                            <li key={entry.href}>
                              <button
                                type="button"
                                onMouseEnter={() => setActive(index)}
                                onClick={() => {
                                  setOpen(false);
                                  navigate(entry.href);
                                }}
                                className={cn(
                                  'flex w-full items-center gap-3 px-4 py-2 text-left transition',
                                  index === active ? 'bg-brand-500/10' : 'hover:bg-white/[0.035]'
                                )}
                              >
                                <meta.icon size={14} className="shrink-0 text-fg-subtle" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-xs text-fg">{entry.title}</span>
                                  {entry.subtitle ? (
                                    <span className="block truncate text-[0.625rem] text-fg-subtle">
                                      {entry.subtitle}
                                    </span>
                                  ) : null}
                                </span>
                                <CornerDownLeft size={12} className="shrink-0 text-fg-subtle" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : null}

                  {queries.length ? (
                    <>
                      <p className="flex items-center justify-between px-4 pb-1 pt-2 text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                        Recent searches
                        <button
                          type="button"
                          onClick={forget}
                          className="normal-case tracking-normal transition hover:text-fg"
                        >
                          clear
                        </button>
                      </p>
                      <ul className="flex flex-wrap gap-1.5 px-4 pb-2 pt-1">
                        {queries.map((text, index) => (
                          <li key={text}>
                            <button
                              type="button"
                              onMouseEnter={() => setActive(opened.length + index)}
                              onClick={() => {
                                setQuery(text);
                                inputRef.current?.focus();
                              }}
                              className={cn(
                                'flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 transition',
                                opened.length + index === active
                                  ? 'bg-brand-500/12 text-brand-300 ring-brand-500/30'
                                  : 'bg-white/[0.03] text-fg-muted ring-line-soft hover:text-fg'
                              )}
                            >
                              <Clock size={11} className="shrink-0" />
                              {text}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : results.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-fg-subtle">{hint}</p>
              ) : (
                <ul>
                  {results.map((result, index) => {
                    const meta = TYPE_META[result.type] ?? TYPE_META.engagement;
                    return (
                      <li key={`${result.type}-${result.id}`}>
                        <button
                          type="button"
                          onMouseEnter={() => setActive(index)}
                          onClick={() => go(result)}
                          className={cn(
                            'flex w-full items-start gap-3 px-4 py-2.5 text-left transition',
                            index === active ? 'bg-brand-500/10' : 'hover:bg-white/[0.035]'
                          )}
                        >
                          <meta.icon size={15} className="mt-0.5 shrink-0 text-fg-subtle" />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-fg">
                                {result.title}
                              </span>
                              {result.severity ? (
                                <SeverityBadge severity={result.severity} score={result.score} />
                              ) : null}
                            </span>
                            <span className="mt-0.5 block truncate text-[0.6875rem] text-fg-muted">
                              {result.subtitle}
                            </span>
                            {result.excerpt ? (
                              <span className="mt-0.5 block truncate text-[0.6875rem] italic text-fg-subtle">
                                {result.excerpt}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[0.625rem] uppercase tracking-wider text-fg-subtle">
                            {meta.label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-line-soft px-4 py-2 text-[0.625rem] text-fg-subtle">
              <span>↑↓ to move · Enter to open · Esc to close</span>
              <span>{hint}</span>
            </div>
          </div>

          <style>{`
            @keyframes search-fade { from { opacity: 0 } to { opacity: 1 } }
            @keyframes search-in {
              from { opacity: 0; transform: translateY(-8px) scale(.98) }
              to   { opacity: 1; transform: none }
            }
          `}</style>
        </div>,
        document.body
      )
        : null}
    </>
  );
}
