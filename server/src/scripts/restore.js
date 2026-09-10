/**
 * Puts a backup back.
 *
 *   npm run restore -- --check engy-backup-2026-09-09.tar.gz    read it, verify it, write nothing
 *   npm run restore -- engy-backup-2026-09-09.tar.gz            into an empty database
 *   npm run restore -- --force engy-backup-2026-09-09.tar.gz    replacing what is there
 *
 * `--check` is the one to run on the day you take the backup rather than the day you need it. It
 * reads every entry, verifies each against the digest in the manifest, and touches nothing — which
 * is the difference between having a backup and believing you have one.
 *
 * Without `--force`, a database that already holds engagements is refused. A restore is not additive:
 * each collection in the archive replaces the one in the database, so running this against a live
 * instance by accident is how somebody loses a week.
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { readManifest, restoreBackup } from '../services/backup/index.js';
import { log } from '../utils/logger.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--check') || args.includes('--dry-run');
  const file = args.find((argument) => !argument.startsWith('--'));

  if (!file) {
    log.error('Which file? Usage: npm run restore -- [--check|--force] <backup.tar.gz>');
    process.exit(1);
  }

  await connectDatabase();

  /* Said out loud before anything is touched, so a wrong file is obvious while it still can be. */
  const manifest = await readManifest(file);
  log.info(`Backup written ${manifest.createdAt} from database "${manifest.database}"`);
  log.info(
    `Holds ${manifest.counts?.documents ?? '?'} documents in ${manifest.counts?.collections ?? '?'} collections, ` +
      `${manifest.counts?.media ?? '?'} evidence file(s), ${manifest.counts?.templates ?? '?'} template(s)`
  );
  if (manifest.skipped?.length) log.info(`Deliberately not included: ${manifest.skipped.join(', ')}`);
  log.info('');

  if (dryRun) log.info('Checking only — nothing will be written.');
  else if (force) log.warn('Restoring with --force: whatever is in this database will be replaced.');

  const result = await restoreBackup(file, {
    force,
    dryRun,
    onProgress: (line) => log.info(line),
  });

  log.info('');
  if (dryRun) {
    log.info(`Checked ${result.checked} entries against the manifest. Every one matched.`);
    log.info('This backup can be restored.');
  } else {
    log.info(
      `Restored ${result.documents} documents in ${result.collections} collections, ` +
        `${result.media} evidence file(s), ${result.templates} template(s).`
    );
    log.info('Everybody will need to sign in again — sessions are not part of a backup.');
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
