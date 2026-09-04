/**
 * Marks every template that predates the `purpose` field as a report template.
 *
 * Awaited at boot, next to the other backfills, and for the reason all three of them exist: a
 * Mongoose default applies when a document is *created* and does nothing to rows already in the
 * database. Adding `purpose: { default: 'report' }` therefore left every template already
 * uploaded with no `purpose` key at all — and a query for `{ purpose: 'report' }` does not match
 * a document that has no such field.
 *
 * The consequence was not cosmetic. The engagement template picker asks for report templates, so
 * somebody's only report template quietly stopped being selectable, and the dashboard told them
 * no template had been uploaded while it sat in the list. The read is tolerant now as well —
 * see templates.routes.js — but the data should be right rather than only worked around.
 *
 * Cheap enough for every boot: the filter matches nothing once it has run.
 */

import { Template } from '../models/template.model.js';
import { log } from '../utils/logger.js';

export async function backfillTemplatePurpose() {
  const result = await Template.collection.updateMany(
    { purpose: { $exists: false } },
    { $set: { purpose: 'report', docType: '' } }
  );
  const changed = result.modifiedCount ?? 0;
  if (changed) {
    log.info(`Marked ${changed} existing template${changed === 1 ? '' : 's'} as report templates`);
  }
  return changed;
}

export default backfillTemplatePurpose;
