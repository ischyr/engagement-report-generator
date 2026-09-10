/**
 * Revokes API tokens from a shell.
 *
 *   npm run revoke:api-tokens -- --user ines                 # lists them, changes nothing
 *   npm run revoke:api-tokens -- --user ines --all
 *   npm run revoke:api-tokens -- --user ines --id 6aa2be8b…
 *
 * The companion to `make:api-token`, and it exists for the case that matters most: somebody thinks
 * a token has leaked and needs it dead now, from wherever they are, without finding out whose
 * browser can sign in.
 *
 * It is also the only way to revoke *somebody else's* — there is deliberately no route for that,
 * because knowing which credentials a person holds is not an authority that managing accounts
 * confers. A shell on the server is a different kind of access from an admin session, and this is
 * the one place that difference is allowed to mean something.
 *
 * Lists by default and changes nothing without `--all` or `--id`, so a mistyped command is a
 * report rather than an outage.
 */
import mongoose from 'mongoose';

import env from '../config/env.js';
import { ApiToken } from '../models/api-token.model.js';
import { User } from '../models/user.model.js';
import { describeApiToken } from '../services/api-tokens.service.js';

const args = process.argv.slice(2);
const one = (name, fallback = '') => {
  const at = args.lastIndexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const username = one('user');
const id = one('id');
const all = args.includes('--all');

if (args.includes('--help') || (!username && !id)) {
  console.log(`
Revokes API tokens.

  npm run revoke:api-tokens -- --user <username>            lists them, changes nothing
  npm run revoke:api-tokens -- --user <username> --all       revokes all of that account's
  npm run revoke:api-tokens -- --id <token id>               revokes one

Revoking is permanent. A revoked token stays in the list, marked, so the failure it causes is
explicable to whoever is looking at a broken pipeline.
`);
  process.exit(args.includes('--help') ? 0 : 1);
}

await mongoose.connect(env.mongoUri);

try {
  if (id) {
    const row = await ApiToken.findById(id).populate({ path: 'owner', select: 'username' });
    if (!row) {
      console.error(`\nNo token with id ${id}.\n`);
      process.exit(1);
    }
    if (row.revokedAt) {
      console.log(`\n"${row.label}" was already revoked on ${row.revokedAt.toISOString().slice(0, 10)}.\n`);
      process.exit(0);
    }
    row.revokedAt = new Date();
    await row.save();
    console.log(`\nRevoked "${row.label}" (${row.owner?.username ?? 'unknown account'}). It stops working now.\n`);
    process.exit(0);
  }

  const owner = await User.findOne({ username }).select('username');
  if (!owner) {
    console.error(`\nNo account called "${username}".\n`);
    process.exit(1);
  }

  const rows = await ApiToken.find({ owner: owner._id }).sort({ createdAt: -1 });
  if (rows.length === 0) {
    console.log(`\n${username} has no API tokens.\n`);
    process.exit(0);
  }

  console.log(`\n${username} has ${rows.length} token${rows.length === 1 ? '' : 's'}:\n`);
  for (const row of rows) {
    const described = describeApiToken(row);
    console.log(`  ${described.state.padEnd(8)} ${described.preview}…  ${described.label}`);
    console.log(
      `           ${described.scopes.join(', ') || 'no scopes'}` +
        ` · ${described.engagements.length ? `${described.engagements.length} engagement(s)` : 'every engagement its owner is on'}` +
        ` · ${described.lastUsedAt ? `last used ${described.lastUsedAt.toISOString().slice(0, 10)}` : 'never used'}`
    );
    console.log(`           id ${described.id}`);
  }

  if (!all) {
    console.log('\nNothing was changed. Add --all to revoke all of them, or --id <id> for one.\n');
    process.exit(0);
  }

  const result = await ApiToken.updateMany(
    { owner: owner._id, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  console.log(
    `\nRevoked ${result.modifiedCount ?? 0} live token${result.modifiedCount === 1 ? '' : 's'}.` +
      ` ${username}'s browser sessions are untouched.\n`
  );
} finally {
  await mongoose.disconnect();
}
