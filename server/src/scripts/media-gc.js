/**
 * Deletes stored images nothing references any more.
 *
 *   npm run media:gc -- --dry        # list what would go
 *   npm run media:gc                 # delete them
 *   npm run media:gc -- --grace 0    # ignore the 24-hour grace period
 *
 * Deleting a finding does *not* delete its screenshots on the spot: the same image
 * may be referenced from another finding, an undo may be seconds away, and a
 * trashed engagement still needs its evidence if it is restored. Orphans are cheap
 * to keep and expensive to lose, so collection is a deliberate sweep rather than a
 * live cascade — and it only considers uploads older than the grace period.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { collectOrphanMedia, mediaUsage } from '../services/media.service.js';
import { log } from '../utils/logger.js';

function graceFromArgs() {
  const at = process.argv.indexOf('--grace');
  if (at === -1) return 24 * 60 * 60 * 1000;
  const hours = Number(process.argv[at + 1]);
  return Number.isFinite(hours) && hours >= 0 ? hours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  const graceMs = graceFromArgs();

  await connectDatabase();

  const before = await mediaUsage();
  log.info(`Stored: ${before.files} file(s), ${(before.bytes / 1024 / 1024).toFixed(1)} MB`);
  log.info(`Grace period: ${(graceMs / 3600000).toFixed(0)} hour(s)`);

  const result = await collectOrphanMedia({ graceMs, dryRun });

  log.info(`Referenced by an engagement or library entry: ${result.referenced}`);
  if (result.orphans.length === 0) {
    log.info('No orphans — every stored image is in use.');
  } else {
    for (const orphan of result.orphans.slice(0, 40)) {
      log.info(
        `  ${dryRun ? 'would delete' : 'deleted'}  ${orphan._id}  ${orphan.filename ?? ''} ` +
          `(${((orphan.length ?? 0) / 1024).toFixed(0)} KB)`
      );
    }
    if (result.orphans.length > 40) log.info(`  … and ${result.orphans.length - 40} more`);
    log.info(
      `${dryRun ? 'Would free' : 'Freed'} ${(result.bytes / 1024 / 1024).toFixed(1)} MB ` +
        `across ${result.orphans.length} file(s).`
    );
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
