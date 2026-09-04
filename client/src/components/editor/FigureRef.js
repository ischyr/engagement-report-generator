import { Node, mergeAttributes } from '@tiptap/core';

/**
 * A reference to a figure, written into the prose as a chip.
 *
 * The prose has always said "the screenshot below", which is true when it is written and false the
 * moment somebody reorders a finding — and a reader on page 12 who wants the evidence for a
 * paragraph has to guess which picture it meant. This is the other half of numbering the captions:
 * a sentence that says **Figure 7** and goes on meaning it.
 *
 * ## Why it is an atom and not a link
 *
 * The chip is one thing you select and delete, like a mention. Making it a mark over editable text
 * would let somebody type inside it, and half a reference is worse than none — the stored HTML
 * would still carry the media id and the document would still print a number, over words the
 * author had since rewritten to mean something else.
 *
 * ## Why it shows the caption and not a number
 *
 * Because the number is not knowable here. It depends on where the figure lands in the finished
 * document, which the *template* decides — see `figure-fields.js` on the server — so the editor
 * would have to either guess or show a number that changes at generation time. It shows the caption
 * instead, which is what the author needs while writing: not "7" but *which* screenshot.
 *
 * Stored as `<span data-figref="<media id>">the caption</span>`. That shape is deliberate at both
 * ends: the media id is what survives a reorder, and the text inside is what a reader gets if
 * numbering is ever switched off — a sentence that still reads.
 */
export const FigureRef = Node.create({
  name: 'figureRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      media: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-figref') ?? '',
        renderHTML: (attributes) =>
          attributes.media ? { 'data-figref': attributes.media } : {},
      },
      /** The caption as it read when the reference was written. Display only. */
      label: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        /* Rendered as the node's text content, not as an attribute — see `renderHTML`. */
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-figref]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'engy-figref' }),
      node.attrs.label || 'a figure',
    ];
  },

  /** What it looks like in the editor: a chip, not a sentence fragment. */
  renderText({ node }) {
    return node.attrs.label || 'a figure';
  },

  addCommands() {
    return {
      insertFigureRef:
        ({ media, label }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { media, label },
          }),
    };
  },
});

export default FigureRef;
