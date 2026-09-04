/**
 * Every page, in the order the sidebar shows them.
 *
 * The Markdown itself is imported eagerly with `?raw`, which is what makes the search index and the
 * previous/next links possible without a build step of their own: the whole corpus is a few dozen
 * kilobytes of text, and a docs site that has to fetch a page before it can search it is a docs
 * site whose search finds nothing on first use.
 *
 * A page's `slug` is its URL and its filename. Nothing derives one from the other automatically,
 * because a rename should be a deliberate act — a docs URL somebody has bookmarked or pasted into a
 * ticket is a small promise.
 */

const sources = import.meta.glob('../content/*.md', { query: '?raw', import: 'default', eager: true });

/** The file behind a slug, or an empty string if the registry names one that does not exist. */
const sourceOf = (slug) => sources[`../content/${slug}.md`] ?? '';

/**
 * The sections, and the pages inside them.
 *
 * Ordered as somebody reads them rather than alphabetically: what this is, how to run it, how to do
 * the job, then the reference material you come back to.
 */
export const SECTIONS = [
  {
    title: 'Getting started',
    pages: [
      { slug: 'introduction', title: 'What Engy Report is' },
      { slug: 'installation', title: 'Installing and running it' },
      { slug: 'docker', title: 'Running it with Docker' },
      { slug: 'first-report', title: 'Your first report' },
    ],
  },
  {
    title: 'Doing the work',
    pages: [
      { slug: 'engagements', title: 'Engagements' },
      { slug: 'findings', title: 'Findings' },
      { slug: 'enumeration', title: 'Enumeration' },
      { slug: 'evidence', title: 'Evidence and screenshots' },
      { slug: 'working-together', title: 'Working together' },
      { slug: 'scratchpad', title: 'Scratchpad' },
      { slug: 'checklists-and-scope', title: 'Scope, checklists and notes' },
      { slug: 'questions', title: 'Questions and assumptions' },
    ],
  },
  {
    title: 'Reporting',
    pages: [
      { slug: 'templates', title: 'Templates' },
      { slug: 'template-language', title: 'The template language' },
      { slug: 'house-style', title: 'One house style' },
      { slug: 'generating', title: 'Generating and delivering' },
      { slug: 'client-link', title: "The client's own link" },
    ],
  },
  {
    title: 'Selling the work',
    pages: [
      { slug: 'proposals', title: 'Proposals' },
      { slug: 'pricing', title: 'Pricing and invoicing' },
      { slug: 'clients', title: 'Clients, targets and retainers' },
    ],
  },
  {
    title: 'Running the instance',
    pages: [
      { slug: 'users-and-roles', title: 'Users, roles and access' },
      { slug: 'settings', title: 'Settings' },
      { slug: 'email', title: 'Email' },
      { slug: 'assistant', title: 'The assistant' },
      { slug: 'operations', title: 'Operations and maintenance' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
];

/** Flat, in reading order — for previous/next and for the search index. */
export const PAGES = SECTIONS.flatMap((section) =>
  section.pages.map((page) => ({ ...page, section: section.title, source: sourceOf(page.slug) }))
);

export const pageBySlug = (slug) => PAGES.find((page) => page.slug === slug) ?? null;

export const neighbours = (slug) => {
  const index = PAGES.findIndex((page) => page.slug === slug);
  return {
    previous: index > 0 ? PAGES[index - 1] : null,
    next: index >= 0 && index < PAGES.length - 1 ? PAGES[index + 1] : null,
  };
};

/** The first page, which `/` redirects to. */
export const HOME = PAGES[0]?.slug ?? 'introduction';
