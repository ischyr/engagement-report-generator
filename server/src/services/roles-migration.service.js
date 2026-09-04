/**
 * Turns the single `role` on every existing account into the `roles` list.
 *
 * The fourth migration of this shape, and there for the reason all of them are: a schema change
 * describes new documents and says nothing about the ones already stored. Without this every
 * account would arrive with no `roles` array, `roles: { $in: [...] }` would match nobody, and an
 * instance that worked a minute ago would have no administrators.
 *
 * Awaited at boot. The filter matches nothing once it has run.
 */

import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';

export async function backfillRoles() {
  const result = await User.collection.updateMany({ roles: { $exists: false } }, [
    // The old single role becomes the first and only entry; anything without one is a consultant,
    // which is what the schema default has always said.
    { $set: { roles: [{ $ifNull: ['$role', 'user'] }] } },
  ]);
  const changed = result.modifiedCount ?? 0;
  if (changed) {
    log.info(`Moved ${changed} account${changed === 1 ? '' : 's'} onto the roles list`);
  }
  return changed;
}

export default backfillRoles;
