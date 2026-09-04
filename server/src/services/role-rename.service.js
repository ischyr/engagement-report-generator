/**
 * Renames the `finance` role to `sales`.
 *
 * The section was built as "Financial" and renamed to "Sales" one commit later, so this
 * exists for one reason: an account created in that window. It is not decoration — left
 * alone, such an account is worse off than broken. The API gate confines any role it does
 * not recognise, and the Sales router only admits `sales` and `admin`, so a leftover
 * `finance` account can reach nothing at all; and `role` is an enum, so the next save of
 * that document would be rejected outright.
 *
 * Awaited at boot next to the other migrations. The filter matches nothing once it has
 * run, and this file can be deleted once every instance has started at least once.
 */

import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';

export async function renameFinanceRoleToSales() {
  // `collection` rather than the model: the value being replaced is no longer in the enum,
  // so a validated update would refuse to look at the documents that need fixing.
  const result = await User.collection.updateMany(
    { role: 'finance' },
    { $set: { role: 'sales' } }
  );
  const changed = result.modifiedCount ?? 0;
  if (changed) {
    log.info(`Moved ${changed} account${changed === 1 ? '' : 's'} from the finance role to sales`);
  }
  return changed;
}

export default renameFinanceRoleToSales;
