import { Paragraph } from '@tiptap/extension-paragraph';
import { TextSelection } from '@tiptap/pm/state';

/**
 * A caption for a table, written as the paragraph above it.
 *
 * ## Why it is not a `<caption>`
 *
 * Because HTML and ProseMirror disagree about where one lives, and ProseMirror is the one that
 * would break. HTML puts `<caption>` inside `<table>`; `prosemirror-tables` builds a `TableMap`
 * from the table node's children on the assumption that every one of them is a row, and reads each
 * row's children as cells. A caption node in there is not a row, and the map that every table
 * command works from — add a column, merge cells, resize — comes out wrong. Extending the table's
 * content expression to allow one would trade a caption for the table editing.
 *
 * So the caption is a sibling: an ordinary paragraph carrying `data-table-caption`, immediately
 * before its table. The document conversion understands both forms — a real `<caption>`, which is
 * what a pasted table brings, and this one — so nothing about the deliverable depends on which
 * side wrote it. See `#table` in `html2ooxml.js`.
 *
 * ## What it costs
 *
 * A paragraph that is dragged away from its table stops being a caption, and reads as an ordinary
 * paragraph in the document. That is the honest behaviour rather than a bug to hide: nothing here
 * can keep two nodes together that the author has separated, and silently numbering a paragraph
 * that is no longer above a table would put "Table 4" over somebody's prose.
 */
export const ParagraphWithTableCaption = {
  addAttributes() {
    return {
      ...this.parent?.(),
      tableCaption: {
        default: null,
        /* Present at all, whatever its value — `data-table-caption=""` is how it is written. */
        parseHTML: (element) => (element.hasAttribute('data-table-caption') ? '' : null),
        renderHTML: (attributes) =>
          attributes.tableCaption === null ? {} : { 'data-table-caption': '' },
      },
    };
  },
};

/** For a schema that has no other paragraph extension. The app composes it onto `ParagraphWithClass`. */
export const TableCaptionParagraph = Paragraph.extend(ParagraphWithTableCaption);

/**
 * Where the table containing the selection starts, and whether it already has a caption.
 *
 * Walks up from the selection rather than searching the document, because "the table I am in" is
 * the only table this can mean and a document may hold several.
 *
 * @returns {{pos:number, captionPos:number|null}|null}
 */
export function tableAround(state) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'table') continue;
    const pos = $from.before(depth);
    const before = state.doc.resolve(pos).nodeBefore;
    const captionPos =
      before && before.type.name === 'paragraph' && before.attrs.tableCaption !== null
        ? pos - before.nodeSize
        : null;
    return { pos, captionPos };
  }
  return null;
}

/**
 * Adds a caption above the table the cursor is in, or puts the cursor in the one already there.
 *
 * Never two: a second call on a captioned table is how somebody finds the caption they wrote and
 * forgot about, so it moves them to it rather than stacking another one on top.
 *
 * @returns {boolean} whether anything happened, as a ProseMirror command must
 */
export function addTableCaption(state, dispatch) {
  const table = tableAround(state);
  if (!table) return false;

  if (table.captionPos !== null) {
    if (dispatch) {
      /* +1 to land inside the paragraph rather than before it. */
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, table.captionPos + 1)).scrollIntoView());
    }
    return true;
  }

  if (dispatch) {
    const paragraph = state.schema.nodes.paragraph.create({ tableCaption: '' });
    const tr = state.tr.insert(table.pos, paragraph);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, table.pos + 1)).scrollIntoView());
  }
  return true;
}

/** Removes the caption above the table the cursor is in. */
export function removeTableCaption(state, dispatch) {
  const table = tableAround(state);
  if (!table || table.captionPos === null) return false;
  if (dispatch) {
    const node = state.doc.nodeAt(table.captionPos);
    dispatch(state.tr.delete(table.captionPos, table.captionPos + node.nodeSize));
  }
  return true;
}

export default { ParagraphWithTableCaption, addTableCaption, removeTableCaption, tableAround };
