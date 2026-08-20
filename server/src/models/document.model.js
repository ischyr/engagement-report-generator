import mongoose from 'mongoose';

/**
 * A file the client sent us.
 *
 * The signed authorisation, the scope document, their asset spreadsheet, last year's report from
 * another firm, the letter naming who may approve testing. All of it arrives by email, gets read
 * once and then lives in whoever's inbox happened to receive it — which is fine until that person
 * is on leave and somebody needs to prove testing was authorised.
 *
 * Its own collection, like credentials and deliveries: the bytes live in GridFS and the metadata
 * here, so an engagement document stays kilobytes however many files are attached to it.
 *
 * Deliberately *not* report content. These are the client's inputs, not our output — nothing here
 * reaches a template, and the download always arrives as an attachment rather than being rendered
 * in the browser.
 */

const DAY = /^(\d{4}-\d{2}-\d{2})?$/;

/**
 * What kind of thing it is.
 *
 * A short list, because the point is to be able to find the authorisation in a hurry — and a
 * free-text label would leave five spellings of it. `other` exists so nothing is turned away.
 */
export const DOCUMENT_KINDS = [
  'authorisation',
  'scope',
  'contract',
  'questionnaire',
  'previous-report',
  'asset-list',
  'correspondence',
  'other',
];

export const DOCUMENT_KIND_LABELS = {
  authorisation: 'Authorisation to test',
  scope: 'Scope document',
  contract: 'Contract or NDA',
  questionnaire: 'Completed questionnaire',
  'previous-report': 'A previous report',
  'asset-list': 'Asset list',
  correspondence: 'Correspondence',
  other: 'Other',
};

const documentSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    /** The name it arrived with, kept as the client wrote it. */
    filename: { type: String, required: true, trim: true, maxlength: 260 },
    kind: { type: String, enum: DOCUMENT_KINDS, default: 'other' },
    /** What it is for, or anything the next person needs to know about it. */
    note: { type: String, default: '', trim: true, maxlength: 1000 },

    /** Who sent it, kept literally — a record of a past event must not change later. */
    receivedFrom: { type: String, default: '', trim: true, maxlength: 160 },
    /** The day it arrived, which is rarely the day somebody got round to filing it. */
    receivedOn: { type: String, default: '', match: DAY },

    /* ------------------------------- the bytes ------------------------------- */
    /** GridFS id in the `documents` bucket. */
    file: { type: mongoose.Schema.Types.ObjectId, required: true },
    bytes: { type: Number, required: true, min: 0 },
    /**
     * What the browser said it was.
     *
     * Recorded, and never trusted: the download route decides the content type it serves, because
     * a file the client called `scope.html` served back with that type from this origin would be
     * stored cross-site scripting rather than a document.
     */
    declaredType: { type: String, default: '', trim: true, maxlength: 120 },
    /** SHA-256, for the same reason a delivery has one: so "this file" means one file. */
    sha256: { type: String, default: '', match: /^([a-f0-9]{64})?$/ },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Who has fetched it, and when it was last fetched — a borrowed contract is worth a trail. */
    downloads: { type: Number, default: 0 },
    lastDownloadAt: { type: Date, default: null },
    lastDownloadBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

documentSchema.index({ audit: 1, createdAt: -1 });

export const EngagementDocument = mongoose.model('EngagementDocument', documentSchema);
export default EngagementDocument;
