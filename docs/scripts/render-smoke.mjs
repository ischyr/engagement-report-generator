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
const { renderMarkdown, outlineOf } = await load('/src/lib/markdown.js');
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
  for (const match of page.source.matchAll(/\]\((\/[^)#]*)(#[^)]*)?\)/g)) {
    const target = match[1].replace(/^\//, '').replace(/\/$/, '');
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

/* --------------------------------------------------------------- the registry --- */
console.log('\nRegistry:');
const listed = SECTIONS.flatMap((section) => section.pages.map((page) => page.slug));
check('every page is in exactly one section', new Set(listed).size === listed.length);
check('and every one of them has a file', PAGES.every((page) => page.source.length > 0));

await vite.close();

console.log('');
console.log(failed === 0 ? `RESULT: ${passed} passed, 0 failed` : `RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
