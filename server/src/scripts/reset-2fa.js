/**
 * Clears two-factor authentication for an account from the command line.
 *
 *   npm run reset-2fa -- <username|email>
 *   npm run reset-2fa -- --list
 *
 * This is the escape hatch for the one case the in-app admin reset cannot cover:
 * the only administrator loses their authenticator and so cannot sign in to
 * press the button. It requires shell access to the machine holding the
 * database, which is the same trust level as editing the collection by hand.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';

async function main() {
  const argument = process.argv[2];

  await connectDatabase();

  if (!argument || argument === '--list') {
    const users = await User.find().sort({ username: 1 });
    if (!argument) {
      log.warn('Usage: npm run reset-2fa -- <username|email>');
      log.info('Accounts on this instance:');
    }
    for (const user of users) {
      log.info(
        `  ${user.username.padEnd(20)} ${user.role.padEnd(9)} ` +
          `2FA ${user.totpEnabled ? 'on ' : 'off'}  ${user.email}`
      );
    }
    await disconnectDatabase();
    process.exit(argument ? 0 : 1);
  }

  const needle = argument.trim().toLowerCase();
  const user = await User.findOne({
    $or: [{ username: needle }, { email: needle }],
  }).select('+totpSecret +totpLastStep +totpFailures +totpLockedUntil');

  if (!user) {
    log.error(`No account matches "${argument}". Run with --list to see them.`);
    await disconnectDatabase();
    process.exit(1);
  }

  if (!user.totpEnabled && !user.totpSecret) {
    log.info(`${user.username} does not have two-factor authentication set up — nothing to do.`);
    await disconnectDatabase();
    return;
  }

  user.totpEnabled = false;
  user.totpSecret = null;
  user.totpLastStep = null;
  user.totpFailures = 0;
  user.totpLockedUntil = null;
  await user.save({ validateBeforeSave: false });

  log.info(`Two-factor authentication cleared for ${user.username}.`);
  log.info('They can sign in with just their password, then re-enrol from Profile.');

  await disconnectDatabase();
}

main().catch(async (err) => {
  log.error(err.stack ?? err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
