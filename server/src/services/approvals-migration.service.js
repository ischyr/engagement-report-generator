/**
 * Turns `approvals: [userId]` into `approvals: [{ user, at, fingerprint }]`.
 *
 * This has to run before anything reads an audit: Mongoose cannot hydrate a bare
 * ObjectId into a subdocument, so an unmigrated engagement would fail to load at
 * all. It is therefore awaited at boot rather than left to a script somebody has to
 * remember, the same way the trash sweeps itself.
 *
 * `at` is left null and `fingerprint` empty because neither was recorded and
 * inventing them would be worse than admitting they are unknown — an empty
 * fingerprint reads as "cannot tell", never as "stale".
 */

import { Audit } from '../models/audit.model.js';
import { log } from '../utils/logger.js';

/** Cheap enough to run on every boot: the filter matches nothing once migrated. */
export async function migrateApprovals() {
  const filter = { approvals: { $elemMatch: { $type: 'objectId' } } };

  const result = await Audit.collection.updateMany(filter, [
    {
      $set: {
        approvals: {
          $map: {
            input: { $ifNull: ['$approvals', []] },
            as: 'approval',
            in: {
              $cond: [
                { $eq: [{ $type: '$$approval' }, 'objectId'] },
                { user: '$$approval', at: null, fingerprint: '' },
                '$$approval',
              ],
            },
          },
        },
      },
    },
  ]);

  return result.modifiedCount ?? 0;
}

export async function migrateApprovalsOnBoot() {
  try {
    const migrated = await migrateApprovals();
    if (migrated) {
      log.info(`Migrated approvals on ${migrated} engagement(s) to signed records.`);
    }
  } catch (err) {
    // Loud, but not fatal: a server that will not start is worse than one where
    // sign-off is temporarily broken, and the message says exactly what to run.
    log.error(`Could not migrate approvals: ${err.message}`);
    log.error('Engagements with old-style approvals will fail to load until this succeeds.');
  }
}

export default migrateApprovals;
