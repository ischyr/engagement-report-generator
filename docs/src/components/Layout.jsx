import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BookOpen, Github, Menu, Search, X } from 'lucide-react';

import { SECTIONS } from '../lib/pages.js';
import SearchDialog from './SearchDialog.jsx';

/**
 * The frame every page sits in: a sidebar of sections, a header that searches, and the page.
 *
 * The sidebar is a plain list of every page rather than a tree that expands and collapses. The
 * whole corpus is twenty pages — small enough that seeing all of it is an advantage, and hiding
 * half of it behind a disclosure triangle only makes somebody hunt.
 */
export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  /* Any navigation closes the drawer: on a phone the link and the page are in the same place. */
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  /* Ctrl+K, the shortcut every documentation site has, plus the one the app itself uses. */
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line-soft bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-3 px-4">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="grid size-8 place-items-center rounded-lg text-fg-muted transition hover:bg-white/5 hover:text-fg lg:hidden"
            aria-label={menuOpen ? 'Close the menu' : 'Open the menu'}
          >
            {menuOpen ? <X size={17} /> : <Menu size={17} />}
          </button>

          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-500/15 text-brand-300 ring-1 ring-brand-500/25">
              <BookOpen size={16} />
            </span>
            <span className="leading-none">
              <span className="block text-sm font-semibold text-fg">Engy Report</span>
              <span className="block text-[0.625rem] uppercase tracking-wider text-fg-subtle">
                Documentation
              </span>
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-auto flex h-8 items-center gap-2 rounded-lg border border-line-soft bg-surface/60 px-2.5 text-xs text-fg-subtle transition hover:border-line hover:text-fg-muted sm:w-64"
          >
            <Search size={14} />
            <span className="hidden sm:inline">Search the docs</span>
            <kbd className="ml-auto hidden rounded border border-line-soft px-1.5 py-0.5 font-mono text-[0.625rem] sm:inline">
              Ctrl K
            </kbd>
          </button>

          <a
            href="https://github.com/ischyr/engagement-report-generator"
            target="_blank"
            rel="noreferrer"
            className="grid size-8 place-items-center rounded-lg text-fg-muted transition hover:bg-white/5 hover:text-fg"
            aria-label="The repository"
          >
            <Github size={16} />
          </a>
        </div>
      </header>

      <div className="mx-auto flex max-w-[90rem] items-start gap-8 px-4">
        {/*
          Sticky under the header on a wide screen, a drawer under it on a narrow one. `hidden` on
          mobile rather than translated off-screen: a nav that is merely moved is still in the tab
          order, which is how a keyboard user ends up somewhere they cannot see.

          Transparent on a wide screen, and that is the point rather than an omission. The page has
          a faint gradient painted on the body, and a sidebar filled with the page's own background
          colour sits *on top* of it — which reads as a flat rectangle inside a page that is not
          flat, with a visible seam down one edge. Nothing scrolls underneath it here, so it needs
          no fill of its own.

          On a narrow screen it does need one: the drawer is sticky and the page scrolls under it.
        */}
        <aside
          className={`${
            menuOpen ? 'block' : 'hidden'
          } sticky top-14 z-20 max-h-[calc(100vh-3.5rem)] w-full shrink-0 overflow-y-auto border-b border-line-soft bg-canvas py-5 lg:block lg:w-60 lg:border-b-0 lg:bg-transparent`}
        >
          <nav className="flex flex-col gap-6">
            {SECTIONS.map((section) => (
              <div key={section.title} className="flex flex-col gap-1">
                <p className="px-2 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  {section.title}
                </p>
                {section.pages.map((page) => (
                  <NavLink
                    key={page.slug}
                    to={`/${page.slug}`}
                    className={({ isActive }) =>
                      `rounded-lg px-2 py-1.5 text-[0.8125rem] transition ${
                        isActive
                          ? 'bg-brand-500/12 font-medium text-brand-200'
                          : 'text-fg-muted hover:bg-white/[0.04] hover:text-fg'
                      }`
                    }
                  >
                    {page.title}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <Outlet />
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
