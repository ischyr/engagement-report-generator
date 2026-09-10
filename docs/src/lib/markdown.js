import { marked } from 'marked';

/**
 * Markdown to HTML, plus the two things a documentation page needs beyond it.
 *
 * **Headings get ids and a link to themselves**, so a section can be pointed at from a ticket or a
 * chat message. The id is derived from the text rather than counted, because a stable anchor
 * outlives the page it is on — inserting a paragraph must not move `#the-lock-gate` somewhere else.
 *
 * **Callouts** are written as a blockquote whose first line is `[!note]`, the syntax GitHub uses.
 * Rather than invent a component that only works in one renderer, the Markdown stays Markdown: a
 * page still reads correctly in an editor, on GitHub, or piped through any other tool.
 */

/** `The lock gate` → `the-lock-gate`. Punctuation out, spaces to hyphens, collapsed. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * An address, wherever this build happens to be served from.
 *
 * A page writes `/installation` or `/shots/findings.jpg`, which is the truth relative to the
 * documentation root and wrong the moment these docs are mounted under /docs beside the
 * presentation site: the browser reads it as the root of the *site* and lands nowhere. Every page
 * it names exists; only the address was wrong.
 *
 * The build knows where it is, so the renderer is the place to apply it and a page never has to
 * think about it. Left alone: anything with a scheme, a protocol-relative address, an anchor on
 * this page, and anything already relative.
 *
 * The base is a parameter so the two cases can be tested rather than assumed.
 */
export function withBase(href, base = import.meta.env?.BASE_URL ?? '/') {
  const value = String(href ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return value;
  if (!value.startsWith('/')) return value;
  return `${String(base).replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
}

/** For an alt or a caption, which come out of the Markdown and go into an attribute. */
const escapeText = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CALLOUTS = {
  note: 'Note',
  tip: 'Worth knowing',
  important: 'Read this one',
  warning: 'Careful',
  danger: 'Do not',
};

/**
 * The headings of a page, for the "on this page" rail.
 *
 * Read from the Markdown rather than from the rendered DOM: the rail is drawn beside the page
 * rather than after it, so waiting for a render to know what is in it would make it flicker in on
 * every navigation. Only h2 and h3 — an outline that lists every h4 is a second copy of the page.
 */
export function outlineOf(source) {
  const headings = [];
  let inFence = false;
  for (const line of String(source).split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/`/g, '');
    headings.push({ level: match[1].length, text, id: slugify(text) });
  }
  return headings;
}

/** The title of a page: its first `#` heading, falling back to the registry's own. */
export function titleOf(source, fallback = '') {
  const match = /^#\s+(.+)$/m.exec(String(source));
  return match ? match[1].trim() : fallback;
}

let configured = false;

function configure() {
  if (configured) return;
  configured = true;

  /*
   * Overrides as a plain object, not a `new marked.Renderer()` with bound methods.
   *
   * marked calls these with `this` set to something carrying `this.parser`, which is how a renderer
   * turns its tokens back into HTML. Binding a method to a Renderer instance takes that away, and
   * every page then fails with "cannot read properties of undefined (reading 'parseInline')" — the
   * whole corpus, at once, which is at least an unambiguous way to find out.
   */
  marked.use({
    gfm: true,
    breaks: false,
    renderer: {
      /** Every heading below the title carries an anchor to itself. */
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${text}</h1>\n`;
        const id = slugify(this.parser.parseInline(tokens, this.parser.textRenderer));
        return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },

      /**
       * An image on a line of its own becomes a figure.
       *
       * Handled in `paragraph` rather than in `image` because that is where the wrapper has to be
       * decided: marked puts a block-level image inside a `<p>`, and a `<figure>` inside a
       * paragraph is invalid HTML that browsers silently rearrange. A caption is the Markdown
       * title, so a page writes it as `![alt](/shots/x.jpg "the caption")` and gets both the
       * description a screen reader needs and the sentence a sighted reader gets.
       */
      paragraph({ tokens }) {
        const lone = tokens.length === 1 && tokens[0].type === 'image' ? tokens[0] : null;
        if (!lone) return `<p>${this.parser.parseInline(tokens)}</p>\n`;

        const caption = lone.title
          ? `<figcaption>${escapeText(lone.title)}</figcaption>`
          : '';
        return (
          '<figure class="shot">' +
          `<a href="${withBase(lone.href)}" target="_blank" rel="noreferrer">` +
          `<img src="${withBase(lone.href)}" alt="${escapeText(lone.text)}" ` +
          'loading="lazy" decoding="async">' +
          '</a>' +
          `${caption}</figure>\n`
        );
      },

      /** An image inside a sentence still needs the base applying to it. */
      image({ href, text, title }) {
        const named = title ? ` title="${escapeText(title)}"` : '';
        return (
          `<img src="${withBase(href)}" alt="${escapeText(text)}"${named} ` +
          'loading="lazy" decoding="async">'
        );
      },

      /**
       * And so does a link.
       *
       * This is the whole reason the documentation's cross-references worked standalone and broke
       * the moment it was served under /docs: forty `[text](/slug)` links in the corpus, every one
       * of them rendered as an anchor to the root of whatever site was hosting them. Anchors within
       * a page and addresses with a scheme pass through untouched.
       */
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const named = title ? ` title="${escapeText(title)}"` : '';
        return `<a href="${withBase(href)}"${named}>${text}</a>`;
      },

      /*
       * A blockquote whose first line is `[!note]` becomes a callout.
       *
       * Recognised here rather than added as a Markdown extension so the source stays plain
       * CommonMark — the same file renders sensibly on GitHub, in an editor, or through any other
       * tool, which is the property that makes documentation outlive its tooling.
       */
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const match = /^\s*<p>\s*\[!(\w+)\]\s*/i.exec(inner);
        const kind = match?.[1]?.toLowerCase();
        if (!kind || !CALLOUTS[kind]) return `<blockquote>${inner}</blockquote>\n`;

        const body = inner.replace(/^\s*<p>\s*\[!\w+\]\s*/i, '<p>');
        return (
          `<div class="callout callout-${kind}">` +
          `<p class="callout-title">${CALLOUTS[kind]}</p>${body}</div>\n`
        );
      },
    },
  });
}

/**
 * The HTML for a page.
 *
 * No sanitising, deliberately, and worth being explicit about why: the input is not user content.
 * These files are in the repository and go through the same review as the code. Running a
 * sanitiser over them would imply otherwise and would quietly eat any HTML a page legitimately
 * needs. Nothing here ever renders something a *user* typed — that lives in the app, which does
 * sanitise.
 */
export function renderMarkdown(source) {
  configure();
  return marked.parse(String(source ?? ''));
}
