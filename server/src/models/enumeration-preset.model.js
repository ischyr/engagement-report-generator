import mongoose from 'mongoose';

import { ENUMERATION_PHASES } from './audit.model.js';

/**
 * A section somebody saved, to build again next time.
 *
 * The six presets the app ships are a starting point; a firm's real methodology is whatever the last
 * engagement ended up as, after the two tools nobody uses were deleted and the commands were fixed.
 * This is that — the same shape as a built-in preset, stored per instance.
 *
 * Rows are flat with a `parent` *index* rather than an id. A preset is a template, not a document:
 * nothing points at its rows, they are copied on use, and integers survive being exported, edited
 * by hand and imported somewhere else in a way ObjectIds do not.
 *
 * Output is deliberately not saved. A preset is the question you ask, not last time's answer —
 * carrying a previous client's sweep into a new engagement is the one mistake this must not make
 * easy. Copying a section *with* its output is a different action, and it lives on the engagement.
 */
const presetStepSchema = new mongoose.Schema(
  {
    _id: false,
    title: { type: String, default: 'Untitled step', maxlength: 200 },
    tool: { type: String, default: '', maxlength: 120 },
    command: { type: String, default: '', maxlength: 2000 },
    /** Guidance for whoever runs it — becomes the step's write-up. */
    content: { type: String, default: '', maxlength: 8000 },
    summary: { type: String, default: '', maxlength: 600 },
    phase: { type: String, enum: [...ENUMERATION_PHASES, ''], default: '' },
    /** Index into this array, or null at the top of the preset. */
    parent: { type: Number, default: null },
  },
  { _id: false }
);

const enumerationPresetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 400 },
    steps: [presetStepSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Which engagement it was taken from, so its origin can be answered later. */
    fromAudit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', default: null },
  },
  { timestamps: true }
);

enumerationPresetSchema.index({ name: 1 }, { unique: true });

export const EnumerationPreset =
  mongoose.models.EnumerationPreset ??
  mongoose.model('EnumerationPreset', enumerationPresetSchema);

export default EnumerationPreset;
