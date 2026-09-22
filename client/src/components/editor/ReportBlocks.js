import { Node, mergeAttributes } from '@tiptap/core';
import HorizontalRule from '@tiptap/extension-horizontal-rule';

/**
 * The three things a report needs that a general-purpose editor does not offer.
 *
 * None of them is decorative. Each exists because operators were working around its absence:
 * "Note:" at the start of a paragraph because there were no callouts, a row of dashes because
 * there was no page break, and a parenthetical two lines long because there were no footnotes.
 */

/** The four kinds of callout, matched by `CALLOUTS` in `html2ooxml.js`. Same keys, same order. */
export const CALLOUT_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'tip', label: 'Recommended' },
  { value: 'warning', label: 'Warning' },
  { value: 'danger', label: 'Danger' },
];

/**
 * A callout box — the paragraph the reader must not skim past.
 *
 * `<aside data-callout="warning">` holding ordinary blocks, so a callout can contain a list or a
 * code pane rather than only a sentence. The server draws it as a shaded cell with a coloured bar
 * down the left edge; see `#callout`.
 *
 * `content: 'block+'` rather than `'paragraph+'` deliberately: "the fix breaks single sign-on, in
 * these three places" wants the three places as a list, and a callout that cannot hold one sends
 * the author back to writing "Note:" by hand.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-callout') || 'note',
        renderHTML: (attributes) => ({ 'data-callout': attributes.kind || 'note' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { class: 'engy-callout' }), 0];
  },

  addCommands() {
    return {
      setCallout:
        (kind = 'note') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      /* Changing the kind of the callout the cursor is in, without unwrapping and rewrapping. */
      setCalloutKind:
        (kind) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { kind }),
    };
  },
});

/**
 * A page break the author can place.
 *
 * Built on the horizontal rule rather than beside it, because in the document model they are the
 * same thing: a block on its own line that separates what is above from what is below. A page
 * break is the strongest version of that, and giving it a second tag would mean teaching the
 * sanitiser, the paste path and the HTML report about another one.
 *
 * `data-page-break` is the only difference, and the server reads exactly that — see the `hr` case
 * in `html2ooxml.js`. A rule with no attribute keeps every behaviour it has always had.
 */
export const PageBreak = HorizontalRule.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      pageBreak: {
        default: null,
        parseHTML: (element) => (element.hasAttribute('data-page-break') ? '' : null),
        renderHTML: (attributes) =>
          attributes.pageBreak === null ? {} : { 'data-page-break': '', class: 'engy-page-break' },
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setPageBreak:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name, attrs: { pageBreak: '' } })
            .run(),
    };
  },
});

/**
 * A footnote: a mark here, the words at the foot of the page.
 *
 * An atom for the same reason the figure chip is one — it is a single thing you select and delete,
 * and text you could type *into* would be a footnote half rewritten with no sign of it.
 *
 * The editor shows the words themselves rather than a number, because the number depends on where
 * this lands in the finished document and nothing here knows that. Word assigns it, through
 * `<w:footnoteRef/>` inside the note; see `#footnote` on the server.
 */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-footnote]' }];
  },

  renderHTML({ node }) {
    return ['span', { 'data-footnote': '', class: 'engy-footnote' }, node.attrs.text || ''];
  },

  renderText({ node }) {
    return node.attrs.text ? ` (${node.attrs.text})` : '';
  },

  addCommands() {
    return {
      insertFootnote:
        (text) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { text } }),
    };
  },
});

export default { Callout, PageBreak, Footnote, CALLOUT_KINDS };
