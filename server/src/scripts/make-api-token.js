/**
 * Issues an API token from a shell.
 *
 *   npm run make:api-token -- --user ines --label "Nightly scanner" --scopes findings:write,findings:read
 *   npm run make:api-token -- --user ines --label "CI" --scopes engagements:read --engagement 6aa17a4f… --days 30
 *
 * The card on the profile page is the normal way to make one, and it is the better way: it lists
 * the engagements to pick from and warns about the wide choice. This exists for the cases where a
 * browser is not available or not wanted —
 *
 *   - a headless instance being set up by whoever deploys it, before anybody has signed in;
 *   - trying the API out without first working out which account's password you know;
 *   - a firm whose only admin is on a plane, which is the same reason `reset-password` exists.
 *
 * The rules are not re-implemented here. It calls the same `mintApiToken` the route calls, so the
 * read-only refusal, the scope validation and the lifetime ceiling are the ones already tested —
 * and the engagement check below is the route's, in the route's words, for the same reason.
 */
import mongoose from 'mongoose';

import env from '../config/env.js';
import { SCOPES, SCOPE_NAMES, MAX_TOKEN_DAYS, DEFAULT_TOKEN_DAYS } from '../models/api-token.model.js';
import { Audit } from '../models/audit.model.js';
import { User, WORKING_ROLES } from '../models/user.model.js';
import { mintApiToken } from '../services/api-tokens.service.js';
import { isRestricted } from '../services/classification.service.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const args = process.argv.slice(2);
/** `--engagement` may be given more than once; everything else takes the last value. */
const many = (name) =>
  args.flatMap((value, index) => (value === `--${name}` && args[index + 1] ? [args[index + 1]] : []));
const one = (name, fallback = '') => {
  const at = args.lastIndexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const usage = () => {
  console.log(`
Issues an API token for one account.

  npm run make:api-token -- --user <username> --label <what will hold it> --scopes <a,b,c>

Options
  --user <username>     required
  --label <text>        required — name it after the thing that will hold it
  --scopes <a,b,c>      required — from the list below
  --engagement <id>     may be repeated. Omit for every engagement that account is on
  --days <n>            1 to ${MAX_TOKEN_DAYS}, default ${DEFAULT_TOKEN_DAYS}

Scopes
${Object.entries(SCOPES)
  .map(([name, meta]) => `  ${name.padEnd(20)} ${meta.description}`)
  .join('\n')}

The token is printed once. Nothing stores it, so if you lose it, make another and revoke this one
from the profile page.
`);
};

const username = one('user');
const label = one('label');
const scopes = one('scopes')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
const engagements = many('engagement');
const days = one('days') ? Number(one('days')) : DEFAULT_TOKEN_DAYS;

if (args.includes('--help') || !username || !label || scopes.length === 0) {
  usage();
  process.exit(args.includes('--help') ? 0 : 1);
}

const unknown = scopes.filter((scope) => !SCOPE_NAMES.includes(scope));
if (unknown.length) {
  console.error(`\nNot a scope: ${unknown.join(', ')}\nThere are ${SCOPE_NAMES.length}: ${SCOPE_NAMES.join(', ')}\n`);
  process.exit(1);
}

await mongoose.connect(env.mongoUri);

try {
  const owner = await User.findOne({ username });
  if (!owner) {
    console.error(`\nNo account called "${username}".\n`);
    process.exit(1);
  }

  /*
   * The same three refusals the route makes, in the same words.
   *
   * A shell script that could mint a credential the interface would refuse would be a way around
   * the rules rather than a way in without a browser.
   */
  const block = owner.signInBlock?.();
  if (block) {
    console.error(`\nThat account cannot sign in (${block}), so it cannot hold a token.\n`);
    process.exit(1);
  }
  if (!(owner.roles ?? []).some((role) => WORKING_ROLES.includes(role))) {
    console.error('\nThat account only has access to the Sales section, so it cannot hold API tokens.\n');
    process.exit(1);
  }

  if (engagements.length) {
    const reachable = await Audit.find(visibleAuditFilter(owner, { _id: { $in: engagements } }))
      .select('reference classification')
      .lean();

    const found = new Set(reachable.map((row) => row._id.toString()));
    const missing = engagements.filter((id) => !found.has(id));
    if (missing.length) {
      console.error(`\n${username} is not on: ${missing.join(', ')}\nA token cannot reach more than its owner can.\n`);
      process.exit(1);
    }
    const restricted = reachable.filter((row) => isRestricted(row));
    if (restricted.length) {
      console.error(
        `\n${restricted.map((row) => row.reference).join(', ')} is marked restricted, and restricted work` +
          ' needs a person signing in with two-factor authentication. It cannot be reached with a token.\n'
      );
      process.exit(1);
    }
  }

  const { token, row } = await mintApiToken({
    owner,
    label,
    scopes,
    audits: engagements,
    days,
    ip: 'shell',
  });

  /* What it is for, then the secret last, so it is the final thing on the screen. */
  console.log(`\n${label}`);
  console.log(`  for      ${owner.username}`);
  console.log(`  may      ${row.scopes.join(', ')}`);
  if (engagements.length) {
    const named = await Audit.find({ _id: { $in: engagements } }).select('reference name').lean();
    for (const [index, audit] of named.entries()) {
      console.log(`  ${index === 0 ? 'on      ' : '        '} ${audit.reference || '(no reference)'}  ${audit.name}`);
    }
  } else {
    console.log('  on       every engagement that account is on, including ones joined later');
  }
  console.log(`  expires  ${row.expiresAt.toISOString().slice(0, 10)}`);
  console.log('\nThis is the only time it is shown:\n');
  console.log(`  ${token}\n`);
  console.log('Try it with:\n');
  console.log(`  curl -H "Authorization: Bearer ${token}" ${env.appUrl.replace(/:\d+$/, ':' + env.port)}/api/v1/whoami\n`);
  console.log(`Revoke it on ${owner.username}'s profile page, or with npm run revoke:api-tokens -- --user ${owner.username}\n`);
} finally {
  await mongoose.disconnect();
}
