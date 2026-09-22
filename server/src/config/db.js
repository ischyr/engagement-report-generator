import mongoose from 'mongoose';
import env from './env.js';
import { log } from '../utils/logger.js';

mongoose.set('strictQuery', true);

/**
 * @param {object} [options]
 * @param {boolean} [options.autoIndex] whether Mongoose may build indexes as models are compiled.
 *   Defaults to the environment's answer — on outside production, because a developer wants a new
 *   index to simply exist, and off in production, because an index build is blocking and a process
 *   restarting under load is the worst moment to discover one is needed.
 *
 *   Passed explicitly by `sync-indexes.js`, which exists precisely to decide when that happens: a
 *   `--dry` run that builds the indexes it was only supposed to report on is worse than no dry run
 *   at all, and the connection option wins over `mongoose.set('autoIndex')`, so it has to be said
 *   here rather than there.
 */
export async function connectDatabase({ autoIndex = !env.isProd } = {}) {
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB reconnected'));

  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      autoIndex,
    });
  } catch (err) {
    log.error(`Cannot reach MongoDB at ${env.mongoUri}`);
    log.error(err.message);
    log.error(
      'Start your local MongoDB service (Windows: `net start MongoDB`) or point MONGODB_URI at another instance.'
    );
    throw err;
  }

  log.info(`MongoDB connected → ${mongoose.connection.name}`);
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
