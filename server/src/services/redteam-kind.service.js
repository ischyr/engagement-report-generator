/**
 * Teaches an existing install that its red team engagement type *is* a red team.
 *
 * Awaited at boot beside the other backfills, and for the same reason they exist: the seed upserts
 * with `$setOnInsert`, deliberately, so it can never overwrite a name or a checklist a firm has
 * edited. The cost of that is that a field added to a seeded row later never arrives — the
 * "Red Team Engagement" type on any install created before the `redteam` kind existed still has no
 * kind at all, so choosing it produced a standard engagement and the Enumeration tab never appeared.
 *
 * Matched by name, which is the one place that is the right thing to do. Everywhere else the app
 * keys structure off `kind` precisely so a rename cannot break it; here the job is to repair the
 * specific row the app itself shipped, and its name is what identifies it.
 *
 * Deliberately narrow:
 *
 *   - only rows whose kind is missing or `standard`, so a firm that has pointed its red team type
 *     at some other shape of work keeps its choice;
 *   - only names that read as red team work, so a type somebody renamed to something unrelated is
 *     left alone.
 *
 * Cheap enough for every boot: the filter matches nothing once it has run.
 */

import { AuditType } from '../models/taxonomy.model.js';
import { log } from '../utils/logger.js';

/** "Red Team Engagement", "Red-Team", "red team assessment" — the shipped name and its neighbours. */
const RED_TEAM_NAME = /red[\s-]*team/i;

export async function backfillRedTeamKind() {
  const result = await AuditType.collection.updateMany(
    {
      name: { $regex: RED_TEAM_NAME },
      $or: [{ kind: { $exists: false } }, { kind: 'standard' }, { kind: '' }, { kind: null }],
    },
    { $set: { kind: 'redteam' } }
  );
  const changed = result.modifiedCount ?? 0;
  if (changed) {
    log.info(
      `Marked ${changed} engagement type${changed === 1 ? '' : 's'} as red team work — the Enumeration tab now appears for them`
    );
  }
  return changed;
}

export default backfillRedTeamKind;
