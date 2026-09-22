/**
 * Builds the indexes the schemas declare.
 *
 *   npm run db:indexes -- --dry     # say what is missing and what is stale, change nothing
 *   npm run db:indexes              # build what is missing
 *   npm run db:indexes -- --prune   # and drop indexes no schema declares any more
 *
 * Mongoose builds indexes on connect only when `autoIndex` is on, and `db.js` turns it off in
 * production — correctly, because index builds are blocking, and a process restarting under load
 * is the worst possible moment to discover that a new index needs building across four hundred
 * thousand activity rows. The consequence nobody wrote down is that on a production instance the
 * indexes are therefore built by *nothing at all*: every `index: true` and every compound index
 * added since the instance was first stood up quietly does not exist, and the queries that were
 * written expecting them do a collection scan.
 *
 * It is not a subtle failure, but it is an invisible one. Nothing errors. The app is simply slower
 * every month, in the places that grow.
 *
 * ## Why a command rather than doing it on boot
 *
 * Because when it happens has to be somebody's decision. Building an index locks nothing in modern
 * MongoDB but it costs I/O, and the person who knows whether now is a good moment is the person
 * running the upgrade, not the process being restarted by a health check.
 *
 * ## `--prune`
 *
 * `syncIndexes` drops indexes the schema no longer declares, which is right and is also
 * irreversible on a large collection — rebuilding a dropped index is the expensive direction. So
 * dropping is opt-in, and without it this only ever *adds*.
 */

import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { log } from '../utils/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(HERE, '..', 'models');

/**
 * Every model, by importing every model file.
 *
 * A list written here would be a list somebody forgets to add to — and the one model missing from
 * it would be the one whose indexes silently never got built, which is the exact failure this
 * script exists to end. The directory is the list.
 */
async function loadModels() {
  const files = fs
    .readdirSync(MODELS)
    .filter((name) => name.endsWith('.model.js'))
    .sort();
  /* A file URL, not a path: on Windows a bare `d:\…` is a scheme the ESM loader refuses. */
  for (const file of files) await import(pathToFileURL(path.join(MODELS, file)).href);
  return files.length;
}

/** What the database has now, so the report can say what changed rather than what exists. */
async function currentIndexes(model) {
  try {
    return (await model.collection.indexes()).map((index) => index.name);
  } catch {
    /* A collection that has never been written to has no indexes and no existence. */
    return [];
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  const prune = process.argv.includes('--prune');

  /*
   * Off, whatever the environment says — and this is the difference between a dry run and a lie.
   *
   * `db.js` leaves `autoIndex` on outside production, so Mongoose builds a model's indexes as the
   * model is compiled against an open connection. In this script that compiling is `loadModels`,
   * which meant a `--dry` run on a development instance silently built every missing index and
   * then truthfully reported that nothing was missing. Right on a production instance, where the
   * flag is already off, and exactly wrong everywhere somebody would try it first.
   *
   * On the connection rather than through `mongoose.set`, because the connection option wins.
   */
  await connectDatabase({ autoIndex: false });
  const fileCount = await loadModels();
  const names = mongoose.modelNames().sort();
  log.info(`${fileCount} model files, ${names.length} models registered`);

  let created = 0;
  let dropped = 0;
  let unchanged = 0;

  for (const name of names) {
    const model = mongoose.model(name);
    const before = new Set(await currentIndexes(model));

    /* What the schema asks for, as the names Mongo will give them. */
    const wanted = model.schema
      .indexes()
      .map(([keys]) =>
        Object.entries(keys)
          .map(([field, direction]) => `${field}_${direction}`)
          .join('_')
      );
    /* Plus the ones declared inline with `index: true` on a path, which `schema.indexes()` also
     * reports — and `_id_`, which every collection has and nobody declares. */
    const missing = wanted.filter((index) => !before.has(index));
    const extra = [...before].filter(
      (index) => index !== '_id_' && !wanted.includes(index) && !index.endsWith('_1')
    );

    if (dryRun) {
      if (missing.length) log.info(`  ${name}: would build ${missing.join(', ')}`);
      if (prune && extra.length) log.warn(`  ${name}: would drop ${extra.join(', ')}`);
      if (!missing.length && !(prune && extra.length)) unchanged += 1;
      continue;
    }

    /*
     * `syncIndexes` when pruning, `createIndexes` when not.
     *
     * The first is the complete answer and drops what no schema declares; the second only ever
     * adds. Which one is wanted is the whole reason `--prune` exists, and guessing would make this
     * a command nobody dares run on a real instance.
     */
    if (prune) {
      const removed = await model.syncIndexes();
      dropped += removed.length;
      if (removed.length) log.warn(`  ${name}: dropped ${removed.join(', ')}`);
    } else {
      await model.createIndexes();
    }

    const after = new Set(await currentIndexes(model));
    const added = [...after].filter((index) => !before.has(index));
    created += added.length;
    if (added.length) log.info(`  ${name}: built ${added.join(', ')}`);
    else if (!prune) unchanged += 1;
  }

  if (dryRun) {
    log.info(`\nDry run. ${unchanged} model(s) already have everything they declare.`);
  } else {
    log.info(
      `\n${created} index(es) built, ${dropped} dropped, ${unchanged} model(s) already complete.`
    );
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error?.message ?? error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
