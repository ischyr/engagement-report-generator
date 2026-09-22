import { Node, mergeAttributes } from '@tiptap/core';

/**
 * A reference to another finding, written into the prose as a chip.
 *
 * "As described in VULN-04" is typed by hand today, and it is wrong the moment anything renumbers
 * — which is a thing this app does on purpose, through `POST /audits/:id/findings/renumber`. The
 * chip stores the finding's id instead, and the label is worked out when the report is built.
 *
 * ## Why it is an atom, like the figure chip
 *
 * One thing you select and delete. A mark over editable text would let somebody type inside it,
 * and half a reference is worse than none: the stored HTML would still carry the finding id and
 * the document would still print its label, over words the author had since rewritten.
 *
 * ## Why it shows the title and prints the identifier
 *
 * While writing, "VULN-04" tells you nothing and *"Stored XSS in the profile editor"* tells you
 * which finding you pointed at. In the document the opposite is true: the sentence wants the short
 * label, and the heading it refers to is a page away. So the chip carries the title and the
 * generator substitutes the identifier — see `resolveFindingRefs` on the server.
 *
 * ## Why it is not a Word field
 *
 * A figure reference is a live `REF` field pointing at a bookmark on its caption, so it survives
 * the client editing the .docx. A finding's heading is drawn by the *template*, not by the
 * converter, so there is nothing to bookmark. That is a smaller loss than it sounds: readers delete
 * figures out of documents and never renumber findings, which the app does for them.
 *
 * Stored as `<span data-findingref="<finding id>">the title</span>` — the id is what survives a
 * renumber, and the text inside is what a reader gets if the finding has gone: nothing, replaced
 * by a visible marker, because words naming a finding that is not in the report assert something
 * untrue.
 */
export const FindingRef = Node.create({
  name: 'findingRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      finding: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-findingref') ?? '',
        renderHTML: (attributes) =>
          attributes.finding ? { 'data-findingref': attributes.finding } : {},
      },
      /** The finding's title as it read when the reference was written. Display only. */
      label: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        /* Rendered as the node's text content, not as an attribute — see `renderHTML`. */
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-findingref]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'engy-findingref' }),
      node.attrs.label || 'a finding',
    ];
  },

  renderText({ node }) {
    return node.attrs.label || 'a finding';
  },

  addCommands() {
    return {
      insertFindingRef:
        ({ finding, label }) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { finding, label } }),
    };
  },
});

export default FindingRef;
