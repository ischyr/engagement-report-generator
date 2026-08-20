import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root — two levels above `server/src`. */
export const ROOT_DIR = path.resolve(here, '..', '..', '..');
export const SERVER_DIR = path.resolve(here, '..', '..');

// The .env lives at the repo root so a single file configures the whole stack.
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/engy-report',
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '30m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  },
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  seed: {
    username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!',
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@engy.local',
  },
  storage: {
    templates: path.join(SERVER_DIR, 'storage', 'templates'),
    tmp: path.join(SERVER_DIR, 'storage', 'tmp'),
  },
};

export default env;
