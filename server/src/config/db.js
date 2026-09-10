import mongoose from 'mongoose';
import env from './env.js';
import { log } from '../utils/logger.js';

mongoose.set('strictQuery', true);

export async function connectDatabase() {
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB reconnected'));

  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      autoIndex: !env.isProd,
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
