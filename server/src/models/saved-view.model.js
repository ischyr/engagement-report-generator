import mongoose from 'mongoose';

/**
 * A place in the app somebody wants to come back to.
 *
 * Several pages keep their state in the address bar — the engagements list, the library, the
 * deliverables queue, the schedule — which was done so a filtered list could be linked to and
 * reloaded without losing it. It made those URLs shareable and it made them unmemorable:
 * `/engagements?state=REVIEW&mine=1&sort=-updatedAt` is the view a reviewer opens every morning,
 * and the only way back to it was to rebuild it from the controls each time or keep a browser
 * bookmark that nothing in the app knows about.
 *
 * So the app keeps them. A saved view is a label and a URL inside this app, and nothing else: no
 * copy of the filters, no interpretation of what they mean. That matters more than it looks —
 * a view that stored `{ state: 'REVIEW' }` would need migrating every time a page changed its
 * parameters, and would silently stop matching what the page actually reads. A URL either still
 * works or visibly does not.
 *
 * **Private, and per person.** There is no sharing flag: a view is somebody's own way of working,
 * and a shared one would be a filter with an opinion attached. The URL itself is shareable — it
 * always was — and that is the mechanism for showing somebody a list.
 *
 * **No access is implied.** Saving a URL grants nothing: the page behind it asks the same
 * questions it asks anybody. A view of an engagement somebody has since been taken off leads to
 * the same refusal it would have led to without it.
 */
const savedViewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** What to call it in the sidebar. Theirs to choose; the app only suggests. */
    label: { type: String, required: true, trim: true, maxlength: 60 },

    /**
     * Where it points, as a path inside this app — always one leading slash.
     *
     * Validated on the way in rather than on the way out. This is rendered as a link, so a stored
     * `//evil.example` (a protocol-relative URL, which looks like a path and is not) or a
     * `javascript:` scheme would turn a private list into a way to attack its owner. The route
     * refuses anything that is not a single-slash path; this is the second wall.
     */
    path: {
      type: String,
      required: true,
      maxlength: 400,
      validate: {
        validator: (value) => /^\/(?!\/)/.test(value) && !value.includes('\\'),
        message: 'A view must point at a path inside this app',
      },
    },

    /**
     * And the query that makes it a view rather than a page, stored without its `?`.
     *
     * Empty is allowed: a page with no parameters is still worth keeping if somebody keeps
     * going back to it.
     */
    query: { type: String, default: '', maxlength: 1000 },

    /** Sidebar order, which is the only thing about a view anybody rearranges. */
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* The list is always "mine, in order" — one index answers it. */
savedViewSchema.index({ user: 1, order: 1, createdAt: 1 });

/*
 * And one view per destination per person.
 *
 * Saving a place you have already saved is a rename, not a second row — the control is a toggle
 * on a page, and a sidebar that accumulated three copies of the same list under three names is
 * the failure that turns people off the feature. Enforced here as well as in the route, because
 * two clicks racing each other is exactly how a duplicate gets in.
 */
savedViewSchema.index({ user: 1, path: 1, query: 1 }, { unique: true });

export const SavedView = mongoose.model('SavedView', savedViewSchema);
export default SavedView;
