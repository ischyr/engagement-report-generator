import mongoose from 'mongoose';

export const FIELD_TYPES = ['input', 'textarea', 'editor', 'date', 'select', 'multiselect', 'checkbox', 'radio', 'space'];
/** Where a custom field shows up in the UI and which documents carry it. */
export const FIELD_VIEWS = ['general', 'finding', 'vulnerability', 'section', 'audit'];

const customFieldSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    /** Stable machine key used inside .docx templates: {{ .custom.myKey }} */
    key: { type: String, required: true, trim: true },
    fieldType: { type: String, enum: FIELD_TYPES, default: 'input' },
    display: { type: String, enum: FIELD_VIEWS, default: 'general' },
    /** Restricts the field to one audit type / vuln category, empty = all. */
    displaySub: { type: String, default: '' },
    size: { type: Number, default: 12, min: 1, max: 12 },
    offset: { type: Number, default: 0, min: 0, max: 11 },
    required: { type: Boolean, default: false },
    description: { type: String, default: '' },
    text: { type: mongoose.Schema.Types.Mixed, default: '' },
    options: [{ locale: { type: String, default: 'en' }, value: String }],
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

customFieldSchema.index({ key: 1, display: 1 }, { unique: true });

export const CustomField = mongoose.model('CustomField', customFieldSchema);
export default CustomField;
