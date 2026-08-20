/**
 * Emptying the trash.
 *
 * Shared by the CLI (`npm run purge-trash`) and the sweep the server runs on
 * boot, so the retention rule lives in exactly one place.
 */

import { Activity } from '../models/activity.model.js';
import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { Credential } from '../models/credential.model.js';
import { Delivery } from '../models/delivery.model.js';
import { Signature } from '../models/signature.model.js';
import { ScopeChange } from '../models/scope-change.model.js';
import { DetectionEvent } from '../models/detection-event.model.js';
import { DeletedFinding } from '../models/deleted-finding.model.js';
import { EngagementDocument } from '../models/document.model.js';
import { PhishingTarget } from '../models/phishing-target.model.js';
import { KitItem } from '../models/kit-item.model.js';
import { Proposal } from '../models/proposal.model.js';
import { retentionDaysFor } from './classification.service.js';
import { log } from '../utils/logger.js';

/**
 * Everything that belongs to an engagement and dies with it.
 *
 * One list, called from both places an engagement is destroyed for good — the manual purge on
 * the route and the scheduled sweep here. It exists because the two had drifted: the sweep was
 * missing a client's uploaded documents, the phishing list and the kit, so an engagement that
 * expired on its own left rows behind that nothing could reach and nothing would ever delete,
 * while the same engagement purged by hand was cleaned properly. A comment above the sweep
 * claimed the two paths did the same thing. They did not.
 *
 * The proposal is *unlinked* rather than deleted. A sale that happened is a record worth
 * keeping even when the job it became is gone — and if a proposal still claimed an engagement
 * that no longer exists it could never be deleted either, because the delete refuses while one
 * is attached. Its status goes back to `accepted`, which is what is true again: the client said
 * yes and there is no engagement.
 */
export async function purgeAuditData(ids) {
  if (!ids?.length) return;

  await Promise.all([
    Activity.deleteMany({ audit: { $in: ids } }),
    Notification.deleteMany({ audit: { $in: ids } }),
    Credential.deleteMany({ audit: { $in: ids } }),
    Delivery.deleteMany({ audit: { $in: ids } }),
    Signature.deleteMany({ audit: { $in: ids } }),
    ScopeChange.deleteMany({ audit: { $in: ids } }),
    DetectionEvent.deleteMany({ audit: { $in: ids } }),
    DeletedFinding.deleteMany({ audit: { $in: ids } }),
    EngagementDocument.deleteMany({ audit: { $in: ids } }),
    PhishingTarget.deleteMany({ audit: { $in: ids } }),
    KitItem.deleteMany({ audit: { $in: ids } }),
    Proposal.updateMany({ audit: { $in: ids } }, { $set: { audit: null, status: 'accepted' } }),
  ]);
}

/** Falls back to a fortnight if the setting has never been touched. */
export const DEFAULT_RETENTION_DAYS = 15;

export async function getRetentionDays() {
  const settings = await Settings.getSettings();
  const days = Number(settings.danger?.public?.nbdaydelete);
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

/**
 * Deletes trashed engagements older than the retention window, along with their
 * activity log and any notifications pointing at them.
 *
 * @param {{dryRun?: boolean}} [options]
 * @returns {Promise<{retentionDays: number, candidates: Array, purged: number}>}
 */
export async function purgeExpiredTrash({ dryRun = false } = {}) {
  const settings = await Settings.getSettings();
  const retentionDays = await retentionDaysFor('standard', settings);
  const restrictedDays = await retentionDaysFor('restricted', settings);

  /*
   * Two windows, so the more sensitive material does not sit in the trash for the length of the
   * ordinary one. Judged per engagement rather than by filtering twice, because the answer has
   * to be the same whichever way the query is written.
   */
  const now = Date.now();
  // Fetched against the shorter of the two, then judged individually — a single query cannot
  // apply two windows, and fetching against the longer one would miss the restricted ones.
  const possible = await Audit.find({
    deletedAt: { $ne: null, $lte: new Date(now - Math.min(retentionDays, restrictedDays) * 86_400_000) },
  })
    .select('name deletedAt classification')
    .sort({ deletedAt: 1 });

  const candidates = possible.filter((audit) => {
    const days = audit.classification === 'restricted' ? restrictedDays : retentionDays;
    return audit.deletedAt <= new Date(now - days * 86_400_000);
  });

  if (dryRun || candidates.length === 0) {
    return { retentionDays, restrictedDays, candidates, purged: 0 };
  }

  const ids = candidates.map((audit) => audit._id);
  /*
   * Everything that belongs to the engagement but lives in its own collection.
   *
   * The manual purge route already did this; this sweep did not, so an engagement that emptied
   * itself on schedule left the client's encrypted credentials, the delivery record and the
   * sign-offs behind for ever — rows nothing can reach and nothing will ever delete. The two
   * paths mean the same thing and now do the same thing.
   */
  await purgeAuditData(ids);
  const result = await Audit.deleteMany({ _id: { $in: ids } });

  return { retentionDays, restrictedDays, candidates, purged: result.deletedCount ?? 0 };
}

/**
 * Runs a purge without letting a failure stop the server from starting — an
 * unreachable trash sweep is a housekeeping problem, not a boot problem.
 */
export async function sweepTrashOnBoot() {
  try {
    const { purged, retentionDays } = await purgeExpiredTrash();
    if (purged > 0) {
      log.info(`Purged ${purged} engagement(s) trashed over ${retentionDays} day(s) ago.`);
    }
  } catch (error) {
    log.warn(`Trash sweep skipped: ${error.message}`);
  }
}

export default purgeExpiredTrash;
