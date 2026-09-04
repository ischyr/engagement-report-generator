/**
 * A way back in when nobody can sign in to hand out a link.
 *
 *   npm run reset-password -- <username|email>
 *
 * The case this exists for is a firm with one admin who has forgotten their password: every
 * other route to a reset is behind a login, so without this the instance is simply lost. It
 * prints a one-time link to the terminal — the same link an admin would issue from the Users
 * page — which is the smallest privilege that solves it. It does not set a password, so nothing
 * is typed into a shell that somebody else might read over a shoulder or out of a history file.
 *
 * Deliberately not a password printer either: the point of the whole mechanism is that the only
 * person who ever knows the password is the one who chose it.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { User } from '../models/user.model.js';
import { issueAccountToken } from '../services/account-tokens.service.js';
import { log } from '../utils/logger.js';

const who = process.argv[2];

async function main() {
  if (!who) {
    log.error('Usage: npm run reset-password -- <username|email>');
    process.exit(1);
  }

  await connectDatabase();

  const needle = String(who).trim().toLowerCase();
  const user = await User.findOne({ $or: [{ username: needle }, { email: needle }] });
  if (!user) {
    log.error(`No account matches "${who}".`);
    await disconnectDatabase();
    process.exit(1);
  }
  if (user.enabled === false) {
    log.warn(`"${user.username}" is disabled — the link will not work until it is enabled again.`);
  }

  const link = await issueAccountToken({ user, purpose: 'reset' });

  log.info('');
  log.info(`One-time link for ${user.username}:`);
  log.info(`  ${link.path}`);
  log.info('');
  log.info('Open it on this instance — prefix it with wherever the app is served from, e.g.');
  log.info(`  http://localhost:5173${link.path}`);
  log.info('');
  log.info(`It stops working at ${link.expiresAt.toISOString()}, or as soon as it is used.`);
  log.info('Any other link for this account has just been invalidated.');

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
