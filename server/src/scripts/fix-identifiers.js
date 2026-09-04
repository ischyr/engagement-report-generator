/**
 * Gives every finding a stable, unique identifier.
 *
 *   npm run fix:identifiers -- --dry
 *   npm run fix:identifiers
 *
 * Two problems are repaired:
 *
 *   - **Missing.** Findings written before identifiers were allocated reliably have
 *     none, so the report fell back to their position — which moves whenever a CVSS
 *     score changes and automatic ordering re-sorts the list.
 *   - **Duplicated.** New findings used to take `findings.length + 1`, so deleting
 *     the second of three made the next one identifier 3 as well. Two findings, one
 *     number, and that number is what the report prints as VULN-03.
 *
 * Numbers are assigned in the order the findings currently *display* — CVSS order,
 * or the manual order if the engagement uses one — so the first report generated
 * after this runs matches what was last seen as closely as possible. From then on
 * they never move.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit } from '../models/audit.model.js';
import { calculateCvss } from '../services/cvss.js';
import { log } from '../utils/logger.js';

/** The order the report would show them in, so assigned numbers look natural. */
function displayOrder(audit) {
  const findings = [...(audit.findings ?? [])];
  if (audit.sortFindings === false) {
    return findings.sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  }
  return findings.sort((a, b) => {
    const scoreA = calculateCvss(a.cvssv3).baseScore ?? -1;
    const scoreB = calculateCvss(b.cvssv3).baseScore ?? -1;
    return scoreB - scoreA || String(a.title).localeCompare(String(b.title));
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

  await connectDatabase();

  let auditsTouched = 0;
  let assigned = 0;
  let deduped = 0;
  let alreadyFine = 0;

  // Includes trashed engagements: a restored one needs sane identifiers too.
  for (const audit of await Audit.find()) {
    const ordered = displayOrder(audit);
    if (ordered.length === 0) continue;

    const seen = new Set();
    const problems = [];

    for (const finding of ordered) {
      const value = finding.identifier;
      if (!Number.isFinite(value)) {
        problems.push({ finding, reason: 'missing' });
      } else if (seen.has(value)) {
        problems.push({ finding, reason: `duplicate of ${value}` });
      } else {
        seen.add(value);
      }
    }

    if (problems.length === 0) {
      alreadyFine += ordered.length;
      continue;
    }

    // Fill the gaps rather than renumbering everything: a finding that already has
    // a unique identifier keeps it, because it may already have been quoted.
    let next = 1;
    const take = () => {
      while (seen.has(next)) next += 1;
      seen.add(next);
      return next;
    };

    for (const { finding, reason } of problems) {
      const value = take();
      log.info(`  ${audit.name}: "${finding.title}" ${reason} → ${value}`);
      if (!dryRun) finding.identifier = value;
      if (reason === 'missing') assigned += 1;
      else deduped += 1;
    }

    auditsTouched += 1;
    if (!dryRun) await audit.save({ validateBeforeSave: false });
  }

  log.info('');
  log.info(`${dryRun ? 'Would assign' : 'Assigned'}: ${assigned} missing, ${deduped} duplicated`);
  log.info(`Engagements ${dryRun ? 'affected' : 'updated'}: ${auditsTouched}`);
  log.info(`Findings already correct: ${alreadyFine}`);
  if (!dryRun && assigned + deduped > 0) {
    log.info('Report ids are stable from here: they no longer move when findings re-sort.');
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
