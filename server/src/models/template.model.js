import mongoose from 'mongoose';

export const TEMPLATE_KINDS = ['docx', 'html'];

/**
 * What a template is for.
 *
 * `report` is the engagement report and everything that has always been here. `proposal` is
 * the paperwork that goes out before the work starts — an NDA, a permission to attack, the
 * offer itself. Same file format, same tag language, same upload and lint machinery; a
 * different set of tags available to it, and a different place in the app that offers it.
 *
 * A field on the existing model rather than a second collection, because the alternative
 * duplicates uploading, storage, tag extraction and linting to gain nothing.
 */
export const TEMPLATE_PURPOSES = ['report', 'proposal'];

/**
 * Which piece of paperwork a proposal template produces.
 *
 * Named rather than left to the template's title, because the flow asks real questions of
 * it: "has the NDA been generated yet" is not answerable from a list of filenames somebody
 * chose. Meaningless for a report template, which is why it defaults to empty.
 */
export const PROPOSAL_DOC_TYPES = ['nda', 'pta', 'proposal', 'sow', 'other'];

/**
 * What each one is called.
 *
 * `pta` is **permission to attack** — the document that says, in writing and signed by somebody
 * entitled to say it, that we may test the things listed and when. It was labelled "penetration
 * testing agreement" here, which is a different document: an agreement is commercial terms, and
 * a permission is authorisation. Testing on the strength of the wrong one is the difference
 * between a job and an offence, so the word matters more here than anywhere else in this app.
 */
export const PROPOSAL_DOC_LABELS = {
  nda: 'NDA',
  pta: 'Permission to attack',
  proposal: 'Proposal',
  sow: 'Statement of work',
  other: 'Other',
};

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /**
     * `docx` renders a Word document from an uploaded file; `html` renders a web
     * page from markup edited in the app, which the browser can print to PDF.
     */
    kind: { type: String, enum: TEMPLATE_KINDS, default: 'docx' },
    /** `report` or `proposal` — see TEMPLATE_PURPOSES. Existing templates are reports. */
    purpose: { type: String, enum: TEMPLATE_PURPOSES, default: 'report' },
    /** For a proposal template: which document it is. Empty on a report template. */
    docType: { type: String, enum: ['', ...PROPOSAL_DOC_TYPES], default: '' },
    ext: { type: String, default: 'docx' },
    /**
     * Filename on disk under server/storage/templates. Only meaningful for
     * `docx`, hence not required at the schema level.
     */
    filename: { type: String, default: null },
    /** The template body, for `html` templates. */
    html: { type: String, default: '' },
    description: { type: String, default: '' },
    /** Tag names discovered by parsing the uploaded document. */
    detectedTags: [{ type: String }],

    /**
     * What the tag analysis made of it, last time the file was written.
     *
     * Stored rather than computed on read: the answer only changes when the template does, and
     * the templates list would otherwise re-analyse every template on every page load — each one
     * meaning a file read and a full sample render's worth of data.
     *
     * Only the unrecognised tags are kept. "Empty" is not a fault: the sample engagement has no
     * approvals, so every tag inside `{{#approvals}}` is legitimately blank, and storing those
     * would turn a warning list into noise.
     */
    lint: {
      at: { type: Date, default: null },
      counts: {
        total: { type: Number, default: 0 },
        ok: { type: Number, default: 0 },
        empty: { type: Number, default: 0 },
        unknown: { type: Number, default: 0 },
      },
      unknown: [
        {
          _id: false,
          tag: { type: String, default: '' },
          /** The loops it sits inside, e.g. "findings", so a scoped tag reads correctly. */
          where: { type: String, default: '' },
        },
      ],
    },
    /**
     * A template this one takes its look from.
     *
     * One house style, five documents: an NDA, a permission to attack, an offer, a statement of work
     * and a report all share the letterhead, the footer and the heading styles, and keeping five
     * copies means fixing four of them. Applied at *render* time — nothing is copied into this
     * template's file — so correcting the base corrects every child at once, which is the point.
     *
     * Null on nearly every template, and null is what "this one stands alone" means.
     */
    inherits: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },

    /**
     * Which parts to take. All false is the same as inheriting nothing.
     *
     * Separate flags rather than all-or-nothing because the useful cases differ: a statement of
     * work wants the letterhead and the styles, and a report that has its own carefully built
     * landscape appendix wants the styles and nothing else.
     */
    inheritParts: {
      styles: { type: Boolean, default: false },
      numbering: { type: Boolean, default: false },
      theme: { type: Boolean, default: false },
      /** Page size, margins, headers and footers — the letterhead. */
      page: { type: Boolean, default: false },
    },

    size: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Each kind needs its own payload; catching it here beats a confusing failure at
// render time.
templateSchema.pre('validate', function requireBodyForKind(next) {
  if (this.kind === 'docx' && !this.filename) {
    return next(new Error('A .docx template needs an uploaded file'));
  }
  if (this.kind === 'html' && !String(this.html ?? '').trim()) {
    return next(new Error('An HTML template needs some markup'));
  }
  return next();
});

export const Template = mongoose.model('Template', templateSchema);
export default Template;
