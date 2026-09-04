import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, List } from 'lucide-react';

import { neighbours, pageBySlug } from '../lib/pages.js';
import { outlineOf, renderMarkdown, titleOf } from '../lib/markdown.js';
import NotFound from './NotFound.jsx';

/**
 * One page: the prose, the rail beside it, and the way on to the next one.
 *
 * The Markdown is rendered with `dangerouslySetInnerHTML`, which is the right tool here and worth
 * saying why: the input is a file in this repository, reviewed like code, not something a user
 * typed. See the note in `markdown.js`. Nothing on this site renders user input at all.
 */
export default function DocPage() {
  const { slug } = useParams();
  const location = useLocation();
  const page = pageBySlug(slug);
  const article = useRef(null);
  const [active, setActive] = useState('');

  const html = useMemo(() => (page ? renderMarkdown(page.source) : ''), [page]);
  const outline = useMemo(() => (page ? outlineOf(page.source) : []), [page]);
  const { previous, next } = neighbours(slug);

  /* A new page starts at the top, unless the URL asked for a section. */
  useEffect(() => {
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) {
        target.scrollIntoView();
        return;
      }
    }
    window.scrollTo({ top: 0 });
  }, [slug, location.hash]);

  useEffect(() => {
    if (page) document.title = `${titleOf(page.source, page.title)} — Engy Report docs`;
  }, [page]);

  /*
   * Which heading the reader is at, for the rail.
   *
   * An observer rather than a scroll handler: the browser does the work off the main thread, and a
   * scroll listener that recomputes offsets is the classic way to make a long page feel heavy.
   * The top margin keeps a heading "current" until it has properly left under the header.
   */
  useEffect(() => {
    if (!article.current || !outline.length) return undefined;
    const headings = outline
      .map((entry) => document.getElementById(entry.id))
      .filter(Boolean);
    if (!headings.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length) setActive(visible[0].target.id);
      },
      { rootMargin: '-84px 0px -70% 0px', threshold: 0 }
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [outline, html]);

  if (!page) return <NotFound />;

  return (
    <>
      <article className="min-w-0 flex-1 py-10" ref={article}>
        <p className="mb-2 text-[0.6875rem] font-medium uppercase tracking-wider text-brand-300/80">
          {page.section}
        </p>

        {/* eslint-disable-next-line react/no-danger -- repository content, see markdown.js */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />

        <nav className="mt-14 flex flex-wrap gap-3 border-t border-line-soft pt-6">
          {previous ? (
            <Link
              to={`/${previous.slug}`}
              className="group flex min-w-52 flex-1 flex-col gap-0.5 rounded-xl border border-line-soft px-3.5 py-3 transition hover:border-line hover:bg-white/[0.02]"
            >
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
                <ArrowLeft size={12} /> Previous
              </span>
              <span className="text-sm text-fg-muted transition group-hover:text-fg">
                {previous.title}
              </span>
            </Link>
          ) : null}
          {next ? (
            <Link
              to={`/${next.slug}`}
              className="group flex min-w-52 flex-1 flex-col items-end gap-0.5 rounded-xl border border-line-soft px-3.5 py-3 text-right transition hover:border-line hover:bg-white/[0.02]"
            >
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
                Next <ArrowRight size={12} />
              </span>
              <span className="text-sm text-fg-muted transition group-hover:text-fg">
                {next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      </article>

      {/* The rail. Absent on a page with nothing to point at, rather than an empty column. */}
      {outline.length > 1 ? (
        <aside className="sticky top-14 hidden max-h-[calc(100vh-3.5rem)] w-52 shrink-0 overflow-y-auto py-10 xl:block">
          <p className="mb-2 flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
            <List size={12} /> On this page
          </p>
          <ul className="flex flex-col gap-1 border-l border-line-soft">
            {outline.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className={`-ml-px block border-l py-0.5 text-xs transition ${
                    entry.level === 3 ? 'pl-5' : 'pl-3'
                  } ${
                    active === entry.id
                      ? 'border-brand-400 text-brand-200'
                      : 'border-transparent text-fg-subtle hover:border-line hover:text-fg-muted'
                  }`}
                >
                  {entry.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </>
  );
}
