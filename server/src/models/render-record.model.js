import mongoose from 'mongoose';

/**
 * One generated document, and everything that decided what it contains.
 *
 * A delivery says what was *sent*; this says what was *produced*, which is not the same thing —
 * most renders are never sent, and the interesting ones are the two before the one that was. Kept
 * because a document is the output of a template, a settings state, a data state and a build, all
 * four of which move independently, and none of which was recorded. "The last report had a table of
 * contents" was unanswerable, and so was "which template made this file".
 *
 * Its own collection rather than an array on the engagement: renders accumulate — a long job
 * generates dozens — and an unbounded array on a document that is already large and saved on every
 * keystroke is how a 16 MB limit gets hit in production.
 */
const renderRecordSchema = new mongoose.Schema(
  {
    /**
     * The id also written into the file itself, as a custom document property.
     *
     * The only thing needed to get from a mystery .docx on somebody's desk to this record, which is
     * the whole point of stamping both. Unique, so a replayed request cannot produce two.
     */
    renderId: { type: String, required: true, unique: true },

    /** What it was about. One of these is set; a report has an audit, paperwork has a proposal. */
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null, index: true },
    proposal: { type: mongoose.Schema.Types.ObjectId, ref: 'Proposal', default: null, index: true },
    /** 'report' | 'proposal-document' | 'test' — what kind of render this was. */
    kind: { type: String, default: 'report' },
    /** The engagement or proposal as it was named at the time, so a rename does not orphan this. */
    subject: { type: String, default: '', maxlength: 300 },

    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    templateName: { type: String, default: '', maxlength: 200 },
    /**
     * Ten hex characters of sha256 over the template's own bytes.
     *
     * A version nobody has to remember to increment, which matters because the failure being caught
     * is a template edited quietly. Two records with different values here are two different
     * templates, whatever the name says.
     */
    templateVersion: { type: String, default: '' },

    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '', maxlength: 160 },
    /** The app build, as the footer shows it. */
    build: { type: String, default: '', maxlength: 80 },

    /** The produced bytes: their name, size and hash. The hash is what a delivery is matched against. */
    filename: { type: String, default: '', maxlength: 300 },
    size: { type: Number, default: 0 },
    outputHash: { type: String, default: '', index: true },
    /** How long it took, in milliseconds. Worth having when a template starts taking a minute. */
    ms: { type: Number, default: null },

    /**
     * What the document was built from, counted.
     *
     * Cheap to store and the first thing anybody wants when two renders of "the same" report differ:
     * one had nine findings and the other has eleven.
     */
    counts: {
      findings: { type: Number, default: null },
      sections: { type: Number, default: null },
      images: { type: Number, default: null },
      scope: { type: Number, default: null },
    },

    /**
     * The presentation settings in force, snapshotted.
     *
     * Not a reference: settings are a singleton anybody may edit, so a pointer would describe today
     * rather than the render. `updateFieldsOnOpen` is in here because it is the answer to the
     * table-of-contents question that prompted all of this.
     */
    settings: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * The house style this render took, and which parts of it.
     *
     * Recorded because it decides what the document looks like and *is not visible in the template's
     * own version*: pointing a child at a base changes every document it produces while the child's
     * bytes stay identical. A probe found exactly that — two renders, one with a letterhead and one
     * without, both reported as "the same as the one before".
     */
    inheritedFrom: { type: String, default: '' },
    inheritedParts: { type: [String], default: [] },
  },
  { timestamps: true }
);

/** The only reads there are: newest first for one subject, and one record by its id. */
renderRecordSchema.index({ audit: 1, createdAt: -1 });
renderRecordSchema.index({ proposal: 1, createdAt: -1 });

export const RenderRecord = mongoose.model('RenderRecord', renderRecordSchema);
export default RenderRecord;
