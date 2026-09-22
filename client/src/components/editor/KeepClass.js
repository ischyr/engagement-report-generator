import Paragraph from '@tiptap/extension-paragraph';
import CodeBlock from '@tiptap/extension-code-block';

import { ParagraphWithTableCaption } from './TableCaption.js';

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

/**
 * The paragraph carries both: the `class` it was pasted with, and the mark that says it is a
 * table's caption.
 *
 * Composed here rather than as two extensions of the same node, because TipTap resolves one
 * extension per node name — registering a second `paragraph` would replace the first and quietly
 * drop whichever set of attributes lost.
 */
export const ParagraphWithClass = Paragraph.extend({
  addAttributes() {
    return {
      ...keepClass.addAttributes.call(this),
      ...ParagraphWithTableCaption.addAttributes.call({ parent: () => ({}) }),
    };
  },
});

/**
 * The code block keeps its own class as well as the one on the node, and remembers which of its
 * lines somebody pointed at.
 *
 * `engy-code-block` comes from the editor's configuration and styles every block; a pasted
 * `http-request` says which kind this one is. Losing either would be a regression, so they are
 * merged rather than one replacing the other.
 *
 * `markLines` is a comma-separated list of line numbers, rendered as `data-mark-lines` on the
 * `<pre>` — the attribute the .docx converter has read from enumeration output panes all along.
 * The write-up is where a reader most needs telling which line is the payload, and it was the one
 * pane that could not say.
 */
export const CodeBlockWithClass = CodeBlock.extend({
  addAttributes() {
    return {
      ...keepClass.addAttributes.call(this),
      markLines: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mark-lines') || null,
        renderHTML: (attributes) =>
          attributes.markLines ? { 'data-mark-lines': attributes.markLines } : {},
      },
    };
  },
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
