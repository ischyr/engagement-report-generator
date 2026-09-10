/**
 * Renders every documentation page through Vite's SSR pipeline.
 *
 * The docs are static, so this is cheaper and more useful than it sounds: it proves every page in
 * the registry has a file behind it, that the Markdown renders, that no page is empty, and that
 * every internal link points at a page that exists — the failure a documentation site is most
 * prone to, and the one a reader finds first.
 */
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});

const load = (p) => vite.ssrLoadModule(p);

const { MemoryRouter, Routes, Route } = await load('react-router-dom');
const { PAGES, SECTIONS } = await load('/src/lib/pages.js');
const { renderMarkdown, outlineOf, withBase } = await load('/src/lib/markdown.js');
const { search } = await load('/src/lib/search.js');
const Layout = (await load('/src/components/Layout.jsx')).default;
const DocPage = (await load('/src/components/DocPage.jsx')).default;
const NotFound = (await load('/src/components/NotFound.jsx')).default;

let passed = 0;
let failed = 0;

const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const renderAt = (route, element) =>
  renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [route] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/:slug',
          element: React.createElement(Layout, null),
          children: undefined,
        }),
        React.createElement(Route, { path: '*', element })
      )
    )
  );

/* ---------------------------------------------------------------- the pages --- */
console.log('Pages:');
for (const page of PAGES) {
  try {
    const html = renderAt(`/${page.slug}`, React.createElement(DocPage));
    /* Rendered outside the layout route, so `useParams` gives nothing: check the source instead. */
    const body = renderMarkdown(page.source);
    check(
      `${page.slug} (${Math.round(page.source.length / 1024)} KB, ${outlineOf(page.source).length} headings)`,
      page.source.trim().length > 400 && body.includes('<h1') && html.length > 0,
      page.source.trim().length <= 400 ? 'the page is nearly empty' : 'no title heading'
    );
  } catch (error) {
    check(page.slug, false, String(error.message).split('\n')[0]);
  }
}

/* --------------------------------------------------------------- the chrome --- */
console.log('\nChrome:');
check('the shell renders', renderAt('/introduction', React.createElement('div')).length > 500);
check('404 renders, with the contents on it', renderToString(
  React.createElement(MemoryRouter, { initialEntries: ['/nope'] }, React.createElement(NotFound))
).includes('There is no page at that address'));

/* ----------------------------------------------------------------- the links --- */
console.log('\nInternal links:');
const slugs = new Set(PAGES.map((page) => page.slug));
let broken = 0;
for (const page of PAGES) {
  /*
   * The `!` matters. An image is written the same way as a link with an exclamation mark in front
   * of it, and without capturing that, every screenshot on a page was reported as a link to a
   * documentation page called "shots/findings.jpg". The title after the address is optional and
   * belongs to neither, so it is dropped before the comparison.
   */
  for (const match of page.source.matchAll(/(!?)\[[^\]]*\]\((\/[^)\s]+)/g)) {
    if (match[1] === '!') continue;
    const target = match[2].replace(/^\//, '').replace(/\/$/, '').split('#')[0];
    if (!slugs.has(target)) {
      broken += 1;
      console.log(`  FAIL  ${page.slug} links to /${target}, which does not exist`);
    }
  }
}
check(`every internal link resolves`, broken === 0, `${broken} broken`);

/* ---------------------------------------------------------------- the search --- */
console.log('\nSearch:');
check('finds a page by its title', search('templates').some((r) => r.slug === 'templates'));
check('finds a heading', search('house style').length > 0);
check('finds prose', search('purchase order').some((r) => r.slug === 'pricing'));
check('and returns nothing for nonsense', search('zzzzqqq').length === 0);

/* ------------------------------------------------------- mounted anywhere --- */
console.log('\nAddresses, when these docs are not at the root of a domain:');
{
  /*
   * The bug this is here for: every internal link in the corpus is written as /slug, which is
   * correct relative to the documentation and points at the root of the *site* the moment the
   * docs are served under /docs beside it. Forty links, each naming a page that exists, every
   * one of them landing nowhere. Rendering at a base of / cannot notice, which is why it went
   * unnoticed, so the function is given both bases here instead.
   */
  check(
    'a link to a page takes the mount point',
    withBase('/installation', '/docs/') === '/docs/installation',
    withBase('/installation', '/docs/')
  );
  check(
    'and so does a screenshot',
    withBase('/shots/findings.jpg', '/docs/') === '/docs/shots/findings.jpg',
    withBase('/shots/findings.jpg', '/docs/')
  );
  check(
    'at the root of a domain it is unchanged',
    withBase('/installation', '/') === '/installation',
    withBase('/installation', '/')
  );
  check(
    'an anchor on this page is left alone',
    withBase('#the-lock-gate', '/docs/') === '#the-lock-gate',
    withBase('#the-lock-gate', '/docs/')
  );
  check(
    'and anything with a scheme is left alone',
    withBase('https://github.com/ischyr/engy-report', '/docs/') ===
      'https://github.com/ischyr/engy-report' &&
      withBase('mailto:nobody@example.invalid', '/docs/') === 'mailto:nobody@example.invalid',
    'an external address was rewritten'
  );

  /*
   * And nothing renders an address that skipped the function. Every href and src on a page has
   * to be one of: something with a scheme, an anchor on the page, or a path starting at this
   * build's base. A bare `slug` would resolve against whatever page the reader is on.
   */
  const base = '/';
  const stray = [];
  for (const page of PAGES) {
    const html = renderMarkdown(page.source);
    for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const value = match[1];
      const fine =
        /^[a-z][a-z0-9+.-]*:/i.test(value) ||
        value.startsWith('//') ||
        value.startsWith('#') ||
        value.startsWith(base);
      if (!fine) stray.push(`${page.slug}: ${value}`);
    }
  }
  check(
    'and every address on every page went through it',
    stray.length === 0,
    stray.slice(0, 5).join(', ')
  );
}

/* ------------------------------------------------------------ screenshots --- */
console.log('\nScreenshots:');
{
  /*
   * The captures are this workspace's own, in `public/shots`. This test is what notices when a
   * page names one that is not there, which is the way a screenshot goes missing: silently, in a
   * build nobody looked at.
   */
  const shots = path.join(root, 'public', 'shots');
  const used = new Map();
  let undescribed = 0;
  let uncaptioned = 0;

  for (const page of PAGES) {
    for (const match of page.source.matchAll(
      /!\[([^\]]*)\]\((\/shots\/[^)\s]+)(?:\s+"([^"]*)")?\)/g
    )) {
      const [, alt, src, caption] = match;
      used.set(src, [...(used.get(src) ?? []), page.slug]);
      /*
       * Alt text and a caption are different jobs: one describes the picture to somebody who
       * cannot see it, the other tells everybody what to notice in it. A page that uses one
       * string for both does neither, and a one-word alt is the usual way that happens.
       */
      if (alt.replace(/\s+/g, ' ').trim().length < 60) undescribed += 1;
      if (!caption) uncaptioned += 1;
    }
  }

  check('the pages use some', used.size >= 5, `${used.size} distinct captures`);

  const missing = [...used.keys()].filter(
    (src) => !fs.existsSync(path.join(shots, path.basename(src)))
  );
  check(
    'and every one of them is a file that exists',
    missing.length === 0,
    `${missing.join(', ')}. Take them with: npm run shots`
  );

  check(
    'each is described for somebody who cannot see it',
    undescribed === 0,
    `${undescribed} with alt text too short to be a description`
  );
  check('and each says what to notice in it', uncaptioned === 0, `${uncaptioned} without a caption`);

  /* And the renderer puts one in a figure rather than in a paragraph, which is invalid HTML. */
  const illustrated = PAGES.find((page) => /!\[[^\]]*\]\(\/shots\//.test(page.source));
  const html = illustrated ? renderMarkdown(illustrated.source) : '';
  check(
    'it renders as a figure with its caption, not as a paragraph',
    /<figure class="shot">[\s\S]*?<figcaption>/.test(html) && !/<p><figure/.test(html),
    illustrated ? `${illustrated.slug} did not render a figure` : 'no page uses one'
  );

  /*
   * And the address has this build's base on it. Rendered here the base is /, so the src is
   * /shots/x.jpg; built with --base=/docs/ the same page asks for /docs/shots/x.jpg. Both are
   * accepted, because both are correct for the build that produced them, and a bare
   * shots/x.jpg (which would resolve against whatever page you happened to be on) is not.
   */
  check(
    'and its address carries the base this build was made with',
    /src="\/(?:docs\/)?shots\//.test(html),
    (html.match(/src="[^"]*shots[^"]*"/) ?? ['no image in the rendered page'])[0]
  );
}

/* --------------------------------------------------------------- the registry --- */
console.log('\nRegistry:');
const listed = SECTIONS.flatMap((section) => section.pages.map((page) => page.slug));
check('every page is in exactly one section', new Set(listed).size === listed.length);
check('and every one of them has a file', PAGES.every((page) => page.source.length > 0));

await vite.close();

console.log('');
console.log(failed === 0 ? `RESULT: ${passed} passed, 0 failed` : `RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
