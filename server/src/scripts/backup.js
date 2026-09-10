/**
 * Takes a backup.
 *
 *   npm run backup
 *   npm run backup -- /mnt/backups
 *   npm run backup -- /mnt/backups/friday.tar.gz
 *
 * A directory gets a dated filename; a path ending in `.tar.gz` is used as given. With neither, the
 * file lands in the working directory.
 *
 * Meant for cron or a systemd timer. What it writes is one file containing every document, every
 * screenshot and every template — see `services/backup/index.js` for what is in it and what is
 * deliberately left out. Where that file then goes, and how many are kept, is a decision for
 * whatever runs this rather than for the application.
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { writeBackup } from '../services/backup/index.js';
import { log } from '../utils/logger.js';

const readable = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

async function main() {
  await connectDatabase();

  const started = Date.now();
  log.info('Backing up:');

  const result = await writeBackup({
    out: process.argv[2],
    onProgress: (line) => log.info(line),
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log.info('');
  log.info(`Wrote ${result.file}`);
  log.info(
    `${readable(result.bytes)} · ${result.documents} documents in ${result.collections} collections · ` +
      `${result.media} evidence file(s) · ${result.templates} template(s) · ${seconds}s`
  );
  log.info('');
  log.info('Check it before you rely on it:  npm run restore -- --check <file>');

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
