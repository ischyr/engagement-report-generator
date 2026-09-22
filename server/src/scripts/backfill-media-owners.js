/**
 * Records which engagements each stored image actually belongs to.
 *
 *   npm run backfill:media-owners
 *
 * Evidence is now readable only by people on an engagement that contains it, and "contains it" is
 * read from `metadata.audits` — the set of engagements referencing those bytes. New uploads
 * maintain that set themselves. Everything stored before carries only `metadata.audit`, the
 * engagement that uploaded it *first*.
 *
 * For almost every file those are the same thing. The exception is the one this script exists for:
 * deduplication is by content, so the same screenshot uploaded to two engagements has always been
 * one object — owned, as far as the metadata went, by whichever arrived first. Without this, the
 * second engagement's team would be refused a picture that is in their own report.
 *
 * So the owners are read from the only source that cannot be wrong about it: the engagements
 * themselves, and what their write-ups actually reference.
 *
 * Safe to run more than once. It only ever adds engagements to the set — a file whose owners are
 * already right is left alone, and nothing is ever removed, because a reference this script cannot
 * see (a field added later, a proposal) must not cost somebody access.
 */
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Audit } from '../models/audit.model.js';
import { EnumerationBody } from '../models/enumeration-body.model.js';
import { mediaIdsInAudit } from '../services/media.service.js';
import log from '../utils/logger.js';

await connectDatabase();

const files = mongoose.connection.db.collection('media.files');

let engagements = 0;
let added = 0;
const seen = new Map();

/*
 * Every engagement, including the trashed ones.
 *
 * A trashed engagement can be restored, and its team losing access to its evidence in the
 * meantime would be a second bug caused by fixing the first.
 */
const cursor = Audit.find({}).select('_id findings sections notes customFields').lean().cursor();

for await (const audit of cursor) {
  engagements += 1;
  /* The write-ups live in their own collection, so a step's screenshots need fetching. */
  const bodies = await EnumerationBody.find({ audit: audit._id }).select('content').lean();
  const ids = mediaIdsInAudit(audit, { enumerationHtml: bodies.map((body) => body.content ?? '') });

  for (const id of ids) {
    const key = String(id);
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(String(audit._id));
  }
}

for (const [id, owners] of seen) {
  let objectId;
  try {
    objectId = new mongoose.Types.ObjectId(id);
  } catch {
    continue;
  }
  const result = await files.updateOne(
    { _id: objectId },
    { $addToSet: { 'metadata.audits': { $each: [...owners].map((o) => new mongoose.Types.ObjectId(o)) } } }
  );
  if (result.modifiedCount) added += 1;
}

/*
 * And the files nothing references.
 *
 * A capture sitting in the evidence bin is referenced by no write-up, so the walk above never sees
 * it — but it has an `audit` on it from the upload, which is the answer. Copied across so the bin
 * keeps working; a file with neither stays readable to any signed-in account, which is what it has
 * always been and is correct for a logo or a signature.
 */
const orphans = await files
  .find({ 'metadata.audit': { $ne: null }, 'metadata.audits': { $in: [null, []] } })
  .project({ _id: 1, 'metadata.audit': 1 })
  .toArray();

for (const file of orphans) {
  await files.updateOne(
    { _id: file._id },
    { $addToSet: { 'metadata.audits': file.metadata.audit } }
  );
  added += 1;
}

const shared = [...seen.values()].filter((owners) => owners.size > 1).length;

log.info(`Walked ${engagements} engagement(s) and ${seen.size} referenced file(s)`);
log.info(`Set owners on ${added} file(s)`);
log.info(
  shared
    ? `${shared} file(s) are in more than one engagement — those are the ones this fixes`
    : 'No file is shared between engagements on this instance'
);

await disconnectDatabase();
