/**
 * How close an engagement is to the wall it can hit.
 *
 * An engagement is a single MongoDB document, and MongoDB refuses a document over 16 MB. That
 * limit is the most consequential number in this codebase and the least visible one: three
 * collections have already been moved out to stay under it — enumeration output, phishing targets,
 * evidence — and every one of those moves is commented with the same failure, because it is the
 * one that actually happens.
 *
 * **Reaching it does not make a page slow. It makes the next save refuse, mid-work, with the
 * paragraph still on screen.**
 *
 * Everything the app does about this is a defence: fields are capped on the way in, the big
 * collections live elsewhere, and a 413 explains the refusal when it comes. What none of that does
 * is *tell anybody where they are*. This does.
 *
 * ## Why Mongo is asked rather than Node
 *
 * `Object.bsonsize(doc.toObject())` means serialising the whole engagement in this process to find
 * out how big it is — which on the engagements that are actually near the limit is megabytes of
 * work to answer a question nobody asked for. `$bsonSize` is an aggregation operator: the server
 * measures what it already holds and sends back a number.
 *
 * It also measures *parts*, which is what makes the answer useful. "You are at 71%" invites a
 * shrug; "you are at 71% and the enumeration write-ups are 8 MB of it" says what to do.
 */

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';

/** MongoDB's hard limit on one document. Not configurable — it is a property of the database. */
export const DOCUMENT_LIMIT = 16 * 1024 * 1024;

/**
 * What the `{ v: … }` wrapper below costs, so it can be taken back off.
 *
 * `$bsonSize` refuses an array, so each part is measured wrapped in a document — which means an
 * *empty* part measures thirteen bytes rather than nothing, and "is this part empty" stops being
 * answerable. Subtracting the envelope makes a part's size the array's own size, so an engagement
 * with no intrusions reports no intrusions instead of listing thirteen bytes of them.
 *
 * Measured rather than written down: it is a property of the BSON encoding, and a constant here
 * would be a number nobody could check.
 */
const ENVELOPE = mongoose.mongo.BSON.calculateObjectSize({ v: [] });

/**
 * The parts worth naming, in the order they are usually to blame.
 *
 * Only arrays that grow with the work. A field somebody types once cannot be the reason an
 * engagement is at 14 MB, and listing it would bury the one that is.
 */
const PARTS = [
  ['findings', 'Findings'],
  ['enumeration', 'Enumeration steps'],
  ['sections', 'Report sections'],
  ['notes', 'Notes'],
  ['intrusions', 'Intrusive changes'],
  ['scope', 'Scope'],
  ['testChecks', 'Checklist'],
  ['questions', 'Client questions'],
  ['handovers', 'Handovers'],
];

/**
 * Where this engagement stands against the ceiling.
 *
 * One aggregation, no document loaded. Returns null when the engagement is not there, so a caller
 * that has already established access does not have to distinguish "gone" from "empty".
 *
 * @param {string|import('mongoose').Types.ObjectId} auditId
 * @returns {Promise<{bytes:number, limit:number, percent:number, level:string, parts:{key:string,
 *   label:string, bytes:number, percent:number}[]}|null>}
 */
export async function auditSize(auditId) {
  const [row] = await Audit.aggregate([
    { $match: { _id: new Audit.base.Types.ObjectId(String(auditId)) } },
    {
      $project: {
        _id: 0,
        bytes: { $bsonSize: '$$ROOT' },
        ...Object.fromEntries(
          PARTS.map(([key]) => [
            key,
            /*
             * Wrapped in a document, because `$bsonSize` takes one and every part here is an array
             * — it refuses an array outright rather than measuring it. `{ v: … }` costs a handful
             * of bytes of envelope, identically for every part, which does not move a figure
             * reported in megabytes.
             *
             * `$ifNull` because a missing field measures as null rather than zero, and one null
             * would take the arithmetic below with it.
             */
            { $bsonSize: { v: { $ifNull: [`$${key}`, []] } } },
          ])
        ),
      },
    },
  ]);

  if (!row) return null;

  const bytes = row.bytes ?? 0;
  const parts = PARTS.map(([key, label]) => {
    const own = Math.max(0, (row[key] ?? 0) - ENVELOPE);
    return { key, label, bytes: own, percent: bytes ? Math.round((own / bytes) * 100) : 0 };
  })
    .filter((part) => part.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return { bytes, limit: DOCUMENT_LIMIT, percent: percentOf(bytes), level: levelOf(bytes), parts };
}

/** How full, as a whole number. Floored, so 99% never reads as 100% while there is room left. */
function percentOf(bytes) {
  return Math.min(100, Math.floor((bytes / DOCUMENT_LIMIT) * 100));
}

/**
 * What to say about it, in three steps rather than a gradient.
 *
 * The thresholds are deliberately early. By the time an engagement is at 90% the work that has to
 * move is weeks old and moving it means editing somebody's write-ups; at 60% it is still the
 * difference between "trim the pasted scan output on those four steps" and a crisis. A warning
 * that arrives when it is too late to act on is not a warning.
 */
function levelOf(bytes) {
  const percent = (bytes / DOCUMENT_LIMIT) * 100;
  if (percent >= 85) return 'critical';
  if (percent >= 60) return 'warning';
  return 'fine';
}

/** The one-line version, for a header or a tooltip. */
export function describeSize(size) {
  if (!size) return '';
  const mb = (size.bytes / 1024 / 1024).toFixed(1);
  if (size.level === 'fine') return `${mb} MB of the 16 MB an engagement can hold`;
  const biggest = size.parts[0];
  return (
    `${mb} MB of the 16 MB an engagement can hold — ${size.percent}% full` +
    (biggest ? `, mostly ${biggest.label.toLowerCase()}` : '')
  );
}

export default auditSize;
