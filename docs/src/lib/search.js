import { PAGES } from './pages.js';
import { slugify } from './markdown.js';

/**
 * Search, over the whole corpus, in the browser.
 *
 * No index server and no service: the documentation is a few dozen kilobytes of Markdown, all of
 * which is already loaded, and a docs search that needs a network round trip is one that fails on
 * the train. Every page is split into *sections* — a heading and the prose under it — so a result
 * can land on the paragraph that answers the question rather than at the top of a long page.
 */

/** Markdown stripped back to the words a person searches for. */
function plain(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s*\[!\w+\]\s*/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/[*_~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One entry per heading, plus one for the page itself. */
const ENTRIES = PAGES.flatMap((page) => {
  const lines = page.source.split('\n');
  const entries = [];
  let current = { heading: '', id: '', body: [] };
  let inFence = false;

  const flush = () => {
    const body = plain(current.body.join('\n'));
    if (!body && !current.heading) return;
    entries.push({
      slug: page.slug,
      section: page.section,
      page: page.title,
      heading: current.heading,
      id: current.id,
      body,
    });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const text = match[2].replace(/`/g, '');
      /* The title heading owns the page itself, so its result has no anchor. */
      current = { heading: match[1].length === 1 ? '' : text, id: match[1].length === 1 ? '' : slugify(text), body: [] };
      continue;
    }
    current.body.push(line);
  }
  flush();
  return entries;
});

/**
 * Results for a query, best first.
 *
 * Scored rather than filtered: "template" appears on nine pages, and the one whose *title* is
 * Templates is the one somebody means. A title match outranks a heading match, which outranks a
 * mention in the prose, and every term has to appear somewhere or the result is dropped — an
 * "any term" search over a small corpus returns the whole corpus.
 */
export function search(query, limit = 8) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  if (!terms.length) return [];

  const scored = [];
  for (const entry of ENTRIES) {
    const title = entry.page.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const body = entry.body.toLowerCase();

    let score = 0;
    let missing = false;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inHeading = heading.includes(term);
      const inBody = body.includes(term);
      if (!inTitle && !inHeading && !inBody) {
        missing = true;
        break;
      }
      if (inTitle) score += 8;
      if (inHeading) score += 5;
      if (inBody) score += 1;
      /* A whole-word hit in the prose is worth more than a substring of a longer word. */
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) score += 1;
    }
    if (missing) continue;

    scored.push({ ...entry, score, excerpt: excerptFor(entry.body, terms) });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A window of the prose around the first term, so a result shows why it matched. */
function excerptFor(body, terms) {
  const lower = body.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return body.slice(0, 140);
  const from = Math.max(0, at - 60);
  return `${from > 0 ? '…' : ''}${body.slice(from, from + 160).trim()}${
    from + 160 < body.length ? '…' : ''
  }`;
}
