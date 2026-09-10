import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

import { SECTIONS } from '../lib/pages.js';

/**
 * A page that is not here.
 *
 * With the whole contents underneath it, because a docs 404 is almost always a renamed page or a
 * guessed URL, and the useful response to both is "here is everything there is".
 */
export default function NotFound() {
  return (
    <article className="min-w-0 flex-1 py-16">
      <p className="flex items-center gap-2 text-brand-300">
        <Compass size={18} />
        <span className="text-[0.6875rem] font-medium uppercase tracking-wider">404</span>
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-fg">There is no page at that address</h1>
      <p className="mt-2 max-w-prose text-sm text-fg-muted">
        It may have been renamed. Everything there is:
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <div key={section.title} className="flex flex-col gap-1.5">
            <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
              {section.title}
            </p>
            {section.pages.map((page) => (
              <Link
                key={page.slug}
                to={`/${page.slug}`}
                className="text-sm text-brand-300 underline decoration-brand-300/30 underline-offset-2 transition hover:decoration-brand-300"
              >
                {page.title}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}
