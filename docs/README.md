# The documentation site

A static React site — the same stack as the app — serving the Markdown in `src/content`.

```bash
npm run docs        # http://localhost:5175
npm run build:docs  # docs/dist, ready to drop on any host
npm run smoke:docs  # renders every page, checks every internal link
```

It is a separate workspace rather than a route inside the app because the people who need it have
often not signed in: somebody evaluating this, or an operator on a phone during a job. Behind the
auth gate is the one place documentation is no use.

## Adding a page

1. Write `src/content/<slug>.md`. Start with a single `# Title`.
2. Add it to a section in `src/lib/pages.js`.

That is the whole ritual. The sidebar, the previous/next links, the "on this page" rail and the
search index all read from that registry, so nothing else needs touching.

The slug is the URL *and* the filename, and nothing derives one from the other automatically —
renaming should be a deliberate act, because a docs URL somebody pasted into a ticket is a small
promise.

## Writing

Plain GitHub-flavoured Markdown. Two additions:

**Headings get anchors.** Every `##` and `###` becomes linkable, with an id derived from its text so
it stays stable when a paragraph is inserted above it.

**Callouts** are a blockquote whose first line is a marker:

```markdown
> [!note]
> Something worth knowing.

> [!tip]
> A better way to do it.

> [!warning]
> Careful.

> [!danger]
> Do not.
```

Written that way on purpose: the source stays plain Markdown, so a page still reads correctly in an
editor, on GitHub, or through any other tool. Documentation outlives its tooling.

## Search

Built in the browser from the Markdown itself, split by heading, so a result lands on the paragraph
that answers the question rather than at the top of a long page. No index to rebuild and nothing to
run: the whole corpus is a few dozen kilobytes and is already loaded.

`Ctrl+K` or `/` opens it.

## What the smoke checks

- Every page in the registry has a file, and the file has a title and some content.
- Every page renders.
- **Every internal link points at a page that exists** — the failure a docs site is most prone to,
  and the one a reader finds first.
- Search finds a page by its title, by a heading, and by its prose.
