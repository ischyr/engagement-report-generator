/**
 * Moves inline screenshots out of engagement documents and into GridFS.
 *
 *   npm run migrate:media -- --dry   # report what would move, change nothing
 *   npm run migrate:media            # do it
 *
 * Screenshots used to be stored as `data:` URIs inside the engagement document,
 * which is what put engagements on a collision course with MongoDB's 16 MB
 * document limit. This rewrites them to `/api/media/<id>` references and stores
 * the bytes properly. Safe to re-run: anything already migrated has no data URIs
 * left to find, and identical images are stored once.
 *
 * Nothing is deleted. The document shrinks because the base64 leaves it, and the
 * bytes are in storage before the document is written — so an interrupted run
 * leaves duplicated storage, never a missing image.
 */

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit } from '../models/audit.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { ALLOWED_IMAGE_TYPES, mediaUsage, saveMedia } from '../services/media.service.js';
import { log } from '../utils/logger.js';

/** `data:image/png;base64,…` inside an attribute, as the editor writes it. */
const DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi;

const EXT_TO_MIME = { jpeg: 'image/jpeg' };

/**
 * Rewrites one HTML string, uploading each inline image it finds.
 *
 * @returns {Promise<{html: string, moved: number, bytes: number, skipped: number}>}
 */
async function migrateHtml(html, context) {
  if (typeof html !== 'string' || !html.includes('data:image/')) {
    return { html, moved: 0, bytes: 0, skipped: 0 };
  }

  const matches = [...html.matchAll(DATA_URI)];
  if (matches.length === 0) return { html, moved: 0, bytes: 0, skipped: 0 };

  let result = html;
  let moved = 0;
  let bytes = 0;
  let skipped = 0;

  for (const match of matches) {
    const [whole, declaredType, payload] = match;
    const contentType = EXT_TO_MIME[declaredType.split('/')[1]] ?? declaredType.toLowerCase();

    if (!ALLOWED_IMAGE_TYPES[contentType]) {
      skipped += 1;
      log.warn(`  skipping ${contentType} in ${context} — not a type we store`);
      continue;
    }

    let buffer;
    try {
      buffer = Buffer.from(payload.replace(/\s/g, ''), 'base64');
    } catch {
      skipped += 1;
      continue;
    }
    if (!buffer.length) {
      skipped += 1;
      continue;
    }

    const stored = await saveMedia({
      buffer,
      contentType,
      filename: `migrated.${ALLOWED_IMAGE_TYPES[contentType]}`,
    });

    // split/join, not replace: a base64 payload can contain `$` sequences that
    // String.replace would interpret as replacement patterns.
    result = result.split(whole).join(stored.url);
    moved += 1;
    bytes += buffer.length;
  }

  return { html: result, moved, bytes, skipped };
}

/** Applies the rewrite to every rich-text field of one document. */
async function migrateDocument(doc, fields, label) {
  let moved = 0;
  let bytes = 0;
  let skipped = 0;

  for (const { get, set, name } of fields) {
    const before = get();
    const outcome = await migrateHtml(before, `${label} → ${name}`);
    moved += outcome.moved;
    bytes += outcome.bytes;
    skipped += outcome.skipped;
    if (outcome.moved > 0) set(outcome.html);
  }

  return { moved, bytes, skipped };
}

const FINDING_FIELDS = ['description', 'observation', 'remediation', 'poc', 'scope'];

function auditFields(audit) {
  const fields = [];
  for (const finding of audit.findings ?? []) {
    for (const name of FINDING_FIELDS) {
      fields.push({
        name: `finding "${finding.title}".${name}`,
        get: () => finding[name],
        set: (value) => {
          finding[name] = value;
        },
      });
    }
  }
  for (const section of audit.sections ?? []) {
    fields.push({
      name: `section "${section.name}"`,
      get: () => section.text,
      set: (value) => {
        section.text = value;
      },
    });
  }
  for (const note of audit.notes ?? []) {
    fields.push({
      name: `note "${note.title}"`,
      get: () => note.content,
      set: (value) => {
        note.content = value;
      },
    });
  }
  return fields;
}

function vulnerabilityFields(entry) {
  const fields = [];
  for (const [index, detail] of (entry.details ?? []).entries()) {
    for (const name of ['description', 'observation', 'remediation', 'poc']) {
      fields.push({
        name: `details[${index}].${name}`,
        get: () => detail[name],
        set: (value) => {
          detail[name] = value;
        },
      });
    }
  }
  return fields;
}

async function main() {
  const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

  await connectDatabase();

  const before = await mediaUsage();
  let totalMoved = 0;
  let totalBytes = 0;
  let totalSkipped = 0;
  let touched = 0;

  log.info(dryRun ? 'Dry run — nothing will be written.' : 'Migrating inline screenshots…');

  // Includes trashed engagements: they can still be restored, and their evidence
  // has to survive with them.
  for (const audit of await Audit.find()) {
    const label = audit.name;
    const outcome = dryRun
      ? await countOnly(auditFields(audit))
      : await migrateDocument(audit, auditFields(audit), label);

    if (outcome.moved > 0) {
      touched += 1;
      const mb = (outcome.bytes / 1024 / 1024).toFixed(1);
      log.info(`  ${label}: ${outcome.moved} image(s), ${mb} MB${dryRun ? ' would move' : ' moved'}`);
      if (!dryRun) await audit.save({ validateBeforeSave: false });
    }
    totalMoved += outcome.moved;
    totalBytes += outcome.bytes;
    totalSkipped += outcome.skipped;
  }

  for (const entry of await Vulnerability.find()) {
    const label = `library entry ${entry._id}`;
    const outcome = dryRun
      ? await countOnly(vulnerabilityFields(entry))
      : await migrateDocument(entry, vulnerabilityFields(entry), label);

    if (outcome.moved > 0) {
      touched += 1;
      log.info(`  ${label}: ${outcome.moved} image(s)${dryRun ? ' would move' : ' moved'}`);
      if (!dryRun) await entry.save({ validateBeforeSave: false });
    }
    totalMoved += outcome.moved;
    totalBytes += outcome.bytes;
    totalSkipped += outcome.skipped;
  }

  log.info('');
  if (totalMoved === 0) {
    log.info('Nothing to migrate — no inline screenshots found.');
  } else {
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    log.info(
      `${dryRun ? 'Would move' : 'Moved'} ${totalMoved} image(s) (${mb} MB) out of ${touched} document(s).`
    );
    if (totalSkipped > 0) log.warn(`${totalSkipped} inline image(s) skipped — see the warnings above.`);
    if (!dryRun) {
      const after = await mediaUsage();
      log.info(
        `Storage: ${after.files} file(s), ${(after.bytes / 1024 / 1024).toFixed(1)} MB ` +
          `(was ${before.files} file(s), ${(before.bytes / 1024 / 1024).toFixed(1)} MB).`
      );
      log.info('Engagement documents are now that much smaller — the 16 MB ceiling is off the table.');
    }
  }

  await disconnectDatabase();
}

/** Counts what a real run would move, without uploading anything. */
async function countOnly(fields) {
  let moved = 0;
  let bytes = 0;
  for (const { get } of fields) {
    const html = get();
    if (typeof html !== 'string') continue;
    for (const match of html.matchAll(DATA_URI)) {
      moved += 1;
      bytes += Math.floor((match[2].replace(/\s/g, '').length * 3) / 4);
    }
  }
  return { moved, bytes, skipped: 0 };
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
