/**
 * Fills in `evidenceCount` on findings written before it was stored.
 *
 *   npm run backfill:evidence -- --dry
 *   npm run backfill:evidence
 *
 * The count is derived, not entered, so unlike the authorship backfill there is nothing to
 * guess: the number is recomputed from the finding's own rich text, which is the same thing
 * the save hook does. Running it twice is harmless.
 *
 * It exists only so the engagement list and the Findings page are right *before* every
 * engagement happens to be saved again — without it, an old engagement reads as "no evidence
 * anywhere" until somebody edits it.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit } from '../models/audit.model.js';
import { countImages } from '../utils/evidence.js';
import { log } from '../utils/logger.js';

const dry = process.argv.includes('--dry');

await connectDatabase();

const audits = await Audit.find({}).select('name findings');
let engagementsTouched = 0;
let findingsTouched = 0;
let withEvidence = 0;

for (const audit of audits) {
  let changed = false;
  for (const finding of audit.findings ?? []) {
    const counted = countImages(finding);
    if (counted > 0) withEvidence += 1;
    if (finding.evidenceCount === counted) continue;
    findingsTouched += 1;
    changed = true;
    if (!dry) finding.evidenceCount = counted;
  }
  if (!changed) continue;
  engagementsTouched += 1;
  if (dry) continue;
  /*
   * `validateBeforeSave: false` because this walks every engagement in the instance,
   * including old ones that predate a required field — and refusing to fix a count over an
   * unrelated validation error would leave exactly the oldest data wrong.
   */
  await audit.save({ validateBeforeSave: false });
}

log.info(
  `${dry ? 'Would update' : 'Updated'} ${findingsTouched} finding(s) across ${engagementsTouched} engagement(s); ${withEvidence} finding(s) carry evidence.`
);

await disconnectDatabase();
