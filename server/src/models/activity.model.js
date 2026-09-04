import mongoose from 'mongoose';

/**
 * Who changed what, and when.
 *
 * A separate collection rather than an array on the audit: the log grows without
 * bound while an engagement is worked on, and embedding it would make every
 * audit read drag the whole history along with it.
 */
const activitySchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /** Machine-readable verb, e.g. 'finding.updated'. See ACTIONS. */
    action: { type: String, required: true },
    /** What it happened to, in words: the finding or section title. */
    target: { type: String, default: '' },
    /** A short human sentence, built when the entry is written. */
    summary: { type: String, default: '' },
    /** Which fields changed, for update entries. */
    fields: [{ type: String }],
    /** Anything else worth keeping, e.g. { from: 'EDIT', to: 'REVIEW' }. */
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// The log is always read newest-first for one engagement.
activitySchema.index({ audit: 1, createdAt: -1 });

export const ACTIONS = {
  AUDIT_CREATED: 'audit.created',
  AUDIT_UPDATED: 'audit.updated',
  AUDIT_DELETED: 'audit.deleted',
  AUDIT_RESTORED: 'audit.restored',
  AUDIT_DUPLICATED: 'audit.duplicated',
  STATE_CHANGED: 'audit.state',
  APPROVED: 'audit.approved',
  APPROVAL_WITHDRAWN: 'audit.approval-withdrawn',
  APPROVALS_CLEARED: 'audit.approvals-cleared',
  REPORT_GENERATED: 'report.generated',
  FINDING_TRANSFERRED: 'finding.transferred',
  FINDING_PROMOTED: 'finding.promoted',
  MEDIA_REPLACED: 'media.replaced',
  REPORT_DELIVERED: 'report.delivered',
  REPORT_DELIVERY_REMOVED: 'report.delivery-removed',

  FINDING_CREATED: 'finding.created',
  FINDING_UPDATED: 'finding.updated',
  FINDING_DELETED: 'finding.deleted',
  FINDING_RESTORED: 'finding.restored',
  FINDING_PURGED: 'finding.purged',
  FINDING_IMPORTED: 'finding.imported',
  FINDINGS_REORDERED: 'finding.reordered',

  SECTION_CREATED: 'section.created',
  SECTION_UPDATED: 'section.updated',
  SECTION_DELETED: 'section.deleted',
  SECTIONS_REORDERED: 'sections.reordered',

  NOTE_CREATED: 'note.created',
  NOTE_UPDATED: 'note.updated',
  NOTE_DELETED: 'note.deleted',
  NOTE_PROMOTED: 'note.promoted',

  ENUM_STEP_CREATED: 'enumeration.created',
  ENUM_STEP_UPDATED: 'enumeration.updated',
  ENUM_STEP_DELETED: 'enumeration.deleted',
  ENUM_STEPS_REORDERED: 'enumeration.reordered',
  ENUM_STEP_PROMOTED: 'enumeration.promoted',
  ENUM_STEP_TO_SCOPE: 'enumeration.to-scope',

  CHECK_CREATED: 'check.created',
  CHECK_UPDATED: 'check.updated',
  CHECK_ASSIGNED: 'check.assigned',
  CHECK_TICKED: 'check.ticked',
  CHECK_UNTICKED: 'check.unticked',
  CHECK_DELETED: 'check.deleted',
  CHECKS_ADDED: 'check.preset',
  CHECKS_CLEARED: 'check.cleared',
  CHECK_BLOCKED: 'check.blocked',
  CHECK_UNBLOCKED: 'check.unblocked',

  COMMENT_ADDED: 'comment.added',
  COMMENT_RESOLVED: 'comment.resolved',
  COMMENT_REOPENED: 'comment.reopened',

  SHARE_LINK_CREATED: 'share.created',
  SHARE_LINK_REVOKED: 'share.revoked',
  /* The one action in the log that nobody with an account performed. */
  CLIENT_UPDATED_FINDING: 'client.updated',
  QUESTION_ASKED: 'question.asked',
  QUESTION_SETTLED: 'question.settled',
  ITEM_RESTORED: 'item.restored',
  CREDENTIAL_ADDED: 'credential.added',
  CREDENTIAL_REVEALED: 'credential.revealed',
  CREDENTIAL_UPDATED: 'credential.updated',
  CREDENTIAL_DELETED: 'credential.deleted',
  CREDENTIALS_PURGED: 'credential.purged',

  BOOKING_ADDED: 'booking.added',
  BOOKING_REMOVED: 'booking.removed',

  SCOPE_UPDATED: 'scope.updated',
  SCOPE_IMPORTED: 'scope.imported',
  SIGNATURE_ADDED: 'signature.added',
  SIGNATURE_REMOVED: 'signature.removed',
  SCOPE_CHANGE_RECORDED: 'scope.change-recorded',
  SCOPE_CHANGE_REMOVED: 'scope.change-removed',

  DETECTION_RECORDED: 'detection.recorded',
  DETECTION_UPDATED: 'detection.updated',
  DETECTION_REMOVED: 'detection.removed',

  HELD: 'audit.held',
  RESUMED: 'audit.resumed',

  KIT_ADDED: 'kit.added',
  KIT_MOVED: 'kit.moved',
  KIT_MISSING: 'kit.missing',

  PHISHING_TARGETS_ADDED: 'phishing.targets-added',
  PHISHING_RESULTS_IMPORTED: 'phishing.results-imported',
  PHISHING_LIST_CLEARED: 'phishing.list-cleared',

  ARCHIVED: 'audit.archived',
  UNARCHIVED: 'audit.unarchived',
  DOCUMENT_ADDED: 'document.added',
  DOCUMENT_REMOVED: 'document.removed',

  RESTRICTED: 'audit.restricted',
  UNRESTRICTED: 'audit.unrestricted',
};

export const Activity = mongoose.model('Activity', activitySchema);
export default Activity;
