import Paragraph from '@tiptap/extension-paragraph';
import CodeBlock from '@tiptap/extension-code-block';

/**
 * Paragraphs and code blocks that keep the `class` they were given.
 *
 * TipTap's schema decides what an element may carry, and neither node has a `class` attribute — so
 * a paragraph pasted in as `<p class="http-label">` came back out as a plain `<p>`. The text
 * survived, which is why it looked like it worked; the class did not, so the app had no way to tell
 * a "Request" label from any other bold line and the styling never applied.
 *
 * Only `class`, and only these two nodes. A general "keep every attribute" would let anything
 * pasted from a web page bring its own styling into a client report, which is the reason the
 * schema is restrictive in the first place.
 */
const keepClass = {
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => element.getAttribute('class') || null,
        renderHTML: (attributes) => (attributes.class ? { class: attributes.class } : {}),
      },
    };
  },
};

export const ParagraphWithClass = Paragraph.extend(keepClass);

/**
 * The code block keeps its own class as well as the one on the node.
 *
 * `engy-code-block` comes from the editor's configuration and styles every block; a pasted
 * `http-request` says which kind this one is. Losing either would be a regression, so they are
 * merged rather than one replacing the other.
 */
export const CodeBlockWithClass = CodeBlock.extend({
  ...keepClass,
  renderHTML({ node, HTMLAttributes }) {
    const configured = this.options.HTMLAttributes?.class ?? '';
    const own = node.attrs.class ?? '';
    const merged = [configured, own].filter(Boolean).join(' ');
    return [
      'pre',
      { ...HTMLAttributes, ...(merged ? { class: merged } : {}) },
      ['code', {}, 0],
    ];
  },
});

export default { ParagraphWithClass, CodeBlockWithClass };
