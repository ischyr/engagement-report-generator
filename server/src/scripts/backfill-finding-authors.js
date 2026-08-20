/**
 * Fills in `createdBy` on findings written before authorship was recorded.
 *
 *   npm run backfill:authors -- --dry
 *   npm run backfill:authors
 *
 * The only trustworthy source is the activity log: a `finding.created` or
 * `finding.imported` entry names both the actor and the finding's title. Where no
 * entry exists the finding is left alone — an unattributed finding is honest, and
 * guessing (the engagement's creator, the first person to edit it) would put
 * someone else's name on a colleague's work.
 *
 * Titles are matched case-insensitively and only when unambiguous: if two findings
 * in one engagement share a title, neither is attributed.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Activity } from '../models/activity.model.js';
import { Audit } from '../models/audit.model.js';
import { log } from '../utils/logger.js';

const CREATION_ACTIONS = ['finding.created', 'finding.imported'];

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

  await connectDatabase();

  let attributed = 0;
  let alreadyKnown = 0;
  let noEvidence = 0;
  let ambiguous = 0;

  for (const audit of await Audit.find()) {
    const entries = await Activity.find({
      audit: audit._id,
      action: { $in: CREATION_ACTIONS },
      actor: { $ne: null },
    })
      .select('actor target createdAt')
      .sort({ createdAt: 1 });

    // Title → actor, but only where one title maps to one actor.
    const byTitle = new Map();
    for (const entry of entries) {
      const key = String(entry.target ?? '').trim().toLowerCase();
      if (!key) continue;
      const seen = byTitle.get(key);
      if (seen === undefined) byTitle.set(key, entry.actor);
      else if (String(seen) !== String(entry.actor)) byTitle.set(key, null); // conflicting
    }

    // Titles duplicated inside the engagement cannot be matched by title alone.
    const titleCounts = new Map();
    for (const finding of audit.findings ?? []) {
      const key = String(finding.title ?? '').trim().toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }

    let changed = 0;
    for (const finding of audit.findings ?? []) {
      if (finding.createdBy) {
        alreadyKnown += 1;
        continue;
      }
      const key = String(finding.title ?? '').trim().toLowerCase();
      if (titleCounts.get(key) > 1) {
        ambiguous += 1;
        continue;
      }
      const actor = byTitle.get(key);
      if (!actor) {
        noEvidence += 1;
        continue;
      }
      finding.createdBy = actor;
      changed += 1;
      attributed += 1;
    }

    if (changed > 0) {
      log.info(`  ${audit.name}: ${changed} finding(s)${dryRun ? ' would be' : ''} attributed`);
      if (!dryRun) await audit.save({ validateBeforeSave: false });
    }
  }

  log.info('');
  log.info(`${dryRun ? 'Would attribute' : 'Attributed'}: ${attributed}`);
  log.info(`Already recorded:  ${alreadyKnown}`);
  log.info(`No log entry:      ${noEvidence} (left unattributed on purpose)`);
  if (ambiguous > 0) log.info(`Duplicate titles:  ${ambiguous} (cannot be matched safely)`);

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
