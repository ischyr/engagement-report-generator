import Image from '@tiptap/extension-image';

/**
 * An image that can carry a caption, stored as a real `<figure>`.
 *
 * Evidence used to be a bare `<img>` dropped between paragraphs: no caption, no
 * number, nothing for the text to refer to. A reader got a screenshot and had to
 * guess which sentence it belonged to.
 *
 * The caption is an *attribute* rather than editable child content, so the node
 * stays a leaf and nothing about selection, deletion or undo changes. It renders as
 * `<figure><img><figcaption>` because that is what the docx converter and the HTML
 * report already understand — `figcaption` maps to Word's Caption style, so a
 * caption comes out looking like one without any template work.
 *
 * An image with no caption still renders as a plain `<img>`, so existing evidence is
 * untouched and nothing gains an empty caption line.
 */
export const FigureImage = Image.extend({
  name: 'image',

  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: '',
        /*
         * Kept out of `alt`, which the uploader fills with the file name — a caption reading
         * "Screenshot 2026-02-11 at 14.03.png" would be worse than none.
         *
         * Read from the matched element itself, never from its parent. A rule can match either the
         * `<figure>` or a bare `<img>`, and reaching up to `parentElement.querySelector` found the
         * *first* figcaption in whatever block contained the images — so a finding with three
         * captioned screenshots showed the first caption on all three, and re-saving it in the
         * editor wrote that back. `:scope >` keeps a nested figure's caption out of it too.
         */
        parseHTML: (element) => {
          if (element.tagName === 'FIGURE') {
            return (
              element.querySelector(':scope > figcaption')?.textContent ??
              element.querySelector('img[src]')?.getAttribute('data-caption') ??
              ''
            );
          }
          return (
            element.getAttribute('data-caption') ??
            element.closest('figure')?.querySelector(':scope > figcaption')?.textContent ??
            ''
          );
        },
        renderHTML: (attributes) =>
          attributes.caption ? { 'data-caption': attributes.caption } : {},
      },
    };
  },

  parseHTML() {
    return [
      // A figure written by this editor, or by anything else.
      {
        tag: 'figure',
        getAttrs: (element) => {
          const img = element.querySelector('img[src]');
          if (!img) return false;
          return {
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt') ?? '',
            title: img.getAttribute('title') ?? '',
            caption:
              element.querySelector('figcaption')?.textContent ??
              img.getAttribute('data-caption') ??
              '',
          };
        },
      },
      { tag: 'img[src]' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const caption = node.attrs.caption;
    const { 'data-caption': _dropped, ...imgAttributes } = HTMLAttributes;
    if (!caption) return ['img', imgAttributes];
    return [
      'figure',
      { class: 'engy-figure' },
      ['img', imgAttributes],
      // Not editable in place: the caption lives in the node's attributes, and a
      // contenteditable child of a leaf node would let ProseMirror and the DOM
      // disagree about what the document says.
      ['figcaption', { contenteditable: 'false' }, caption],
    ];
  },
});

export default FigureImage;
