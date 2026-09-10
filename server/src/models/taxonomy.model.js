import mongoose from 'mongoose';

import { ENGAGEMENT_KINDS } from './audit.model.js';

/* -------------------------------------------------------------------------- */
/* Languages                                                                   */
/* -------------------------------------------------------------------------- */
const languageSchema = new mongoose.Schema(
  {
    language: { type: String, required: true, unique: true, trim: true },
    locale: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Audit types — an engagement kind, each bound to one template per locale      */
/* -------------------------------------------------------------------------- */
const auditTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    templates: [
      {
        _id: false,
        template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
        locale: { type: String, default: 'en' },
      },
    ],
    /**
     * What shape of work this type is, so choosing it sets up the right engagement.
     *
     * Part of the blueprint like everything below: a firm that names a type "Phishing Campaign"
     * should not then have to tell the app a second time that it is one. Anything the caller
     * supplied explicitly still wins — this fills a blank rather than overriding a choice.
     */
    kind: { type: String, enum: ENGAGEMENT_KINDS, default: 'standard' },

    /** Section field-keys automatically attached to new audits of this type. */
    sections: [{ type: String }],
    hidden: [{ type: String }],

    /*
     * The rest of the blueprint.
     *
     * An engagement type already decided which narrative sections a new engagement
     * starts with; everything else — the methodology, who reviews it, the scope
     * groups — was five minutes of clicking repeated for every job of the same
     * kind. All optional: a type with none of it behaves exactly as before.
     */

    /** Checklists applied to a new engagement of this type. */
    checklists: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Checklist' }],
    /** Reviewers added by default — the people who normally sign this work off. */
    reviewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** Testers added by default, alongside whoever creates the engagement. */
    collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /**
     * Scope group names to start with, e.g. "External perimeter", "Domain
     * controllers". Hosts are filled in during the engagement; the groups are the
     * part that repeats.
     */
    scopeGroups: [{ type: String, trim: true, maxlength: 200 }],
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Vulnerability types (Web, Network, …) and categories                        */
/* -------------------------------------------------------------------------- */
const vulnerabilityTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    locale: { type: String, default: 'en' },
  },
  { timestamps: true }
);
vulnerabilityTypeSchema.index({ name: 1, locale: 1 }, { unique: true });

const vulnerabilityCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    sortValue: { type: String, default: 'cvssScore' },
    sortOrder: { type: String, enum: ['desc', 'asc'], default: 'desc' },
    sortAuto: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Reusable section (a named free-text block of a report)                      */
/* -------------------------------------------------------------------------- */
const sectionDefinitionSchema = new mongoose.Schema(
  {
    /** Referenced in templates as {{ .sections.<field> }} */
    field: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    icon: { type: String, default: '' },
  },
  { timestamps: true }
);

export const Language = mongoose.model('Language', languageSchema);
export const AuditType = mongoose.model('AuditType', auditTypeSchema);
export const VulnerabilityType = mongoose.model('VulnerabilityType', vulnerabilityTypeSchema);
export const VulnerabilityCategory = mongoose.model(
  'VulnerabilityCategory',
  vulnerabilityCategorySchema
);
export const SectionDefinition = mongoose.model('SectionDefinition', sectionDefinitionSchema);
