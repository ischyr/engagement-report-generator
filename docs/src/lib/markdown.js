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

const CALLOUTS = {
  note: 'Note',
  tip: 'Worth knowing',
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
