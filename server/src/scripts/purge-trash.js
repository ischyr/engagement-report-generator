/**
 * Permanently removes trashed engagements whose retention window has expired.
 *
 *   npm run purge-trash            # purge what is due
 *   npm run purge-trash -- --dry   # list what would go, delete nothing
 *
 * The window is Settings → Danger zone → "Days before a deleted engagement is
 * purged" (`danger.public.nbdaydelete`). Run it from a scheduled task if you want
 * the trash to empty itself; the server also sweeps once on boot.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { purgeExpiredTrash } from '../services/trash.service.js';
import { log } from '../utils/logger.js';

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

  await connectDatabase();
  const result = await purgeExpiredTrash({ dryRun });

  log.info(
    `Retention window: ${result.retentionDays} day(s) — ` +
      `${result.candidates.length} engagement(s) past it.`
  );
  for (const audit of result.candidates) {
    log.info(`  ${dryRun ? 'would purge' : 'purged'}  ${audit.name}  (trashed ${audit.deletedAt})`);
  }
  if (result.candidates.length === 0) log.info('Nothing to purge.');
  else if (!dryRun) log.info(`Removed ${result.purged} engagement(s) and their activity log.`);

  await disconnectDatabase();
}

main().catch(async (err) => {
  log.error(err.stack ?? err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
