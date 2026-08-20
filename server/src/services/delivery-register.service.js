/**
 * Every report that has left the building, across every engagement.
 *
 * The delivery record was only ever readable one engagement at a time — which answers "what did
 * this client get" only if you already know which engagement to open. The questions people
 * actually arrive with are the other way round: *what did we send them in March*, *which version
 * are they arguing about*, and — the one no amount of scrolling answers — *somebody has handed us
 * a file, is it one of ours*.
 *
 * The hash makes that last one exact. `fileHash` is indexed and deliberately not unique, because
 * the same file legitimately goes out twice, so one digest can match several rows and every one
 * of them is a fact worth showing.
 */

import { Delivery } from '../models/delivery.model.js';
import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

/** A page of the register. Big enough to be useful, small enough that the first paint is quick. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const HEX64 = /^[a-f0-9]{64}$/;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The engagements this person may see at all, with the few fields the register prints.
 *
 * Resolved first and the deliveries filtered to them, rather than joining the other way: access
 * to a delivery is entirely a question about its engagement, and deriving it from the same
 * `visibleAuditFilter` every list uses means this page cannot develop its own opinion about who
 * can see what.
 */
async function visibleAudits(user, { client, audit } = {}) {
  const extra = {};
  if (client) extra.company = client;
  if (audit) extra._id = audit;

  const rows = await Audit.find(visibleAuditFilter(user, extra))
    .select('name reference company state contentFingerprint updatedAt')
    .populate({ path: 'company', select: 'name' });

  return new Map(rows.map((row) => [String(row._id), row]));
}

/**
 * @param {object} user the caller, for scoping
 * @param {object} query filters — `client`, `audit`, `q`, `hash`, `from`, `to`, `latestOnly`,
 *   `unhashedOnly`, `before` (cursor), `limit`
 */
export async function deliveryRegister(user, query = {}) {
  const audits = await visibleAudits(user, query);
  /*
   * The real ObjectIds, not the map's string keys.
   *
   * `find()` casts a string to an ObjectId through the schema; `aggregate()` does not, and
   * silently matches nothing instead — which showed up as every delivery reporting that it was
   * not the current one, and "only the current version" returning an empty page.
   */
  const auditIds = [...audits.values()].map((row) => row._id);

  const limit = Math.min(Number(query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  const hash = String(query.hash ?? '')
    .trim()
    .toLowerCase();
  const wantsHash = Boolean(hash);
  const validHash = wantsHash && HEX64.test(hash);

  /**
   * A digest that is not a SHA-256 answers with nothing, and says why.
   *
   * Matching a partial digest would invite "close enough", which is the one thing a fingerprint
   * must never mean — and simply ignoring the parameter was worse: it returned the *entire*
   * register, which reads as "everything here matches your file".
   */
  const nothing = (reason = '') => ({
    deliveries: [],
    hasMore: false,
    nextBefore: null,
    totals: { deliveries: 0, engagements: 0, clients: 0, unhashed: 0, stale: 0, unknown: 0 },
    // Always answered when a hash was asked about, even with nothing visible to search: "no
    // rows" and "that is not a digest" are different answers and the page words them differently.
    match: wantsHash ? { hash, valid: validHash, found: 0, reason } : null,
  });

  if (wantsHash && !validHash) return nothing('A SHA-256 digest is 64 hexadecimal characters.');
  /** Nothing visible means nothing to page through — and no query worth running. */
  if (!auditIds.length) return nothing();

  const filter = { audit: { $in: auditIds } };

  /**
   * The newest delivery for each engagement.
   *
   * An aggregation rather than reading every row: this needs one id per engagement, and walking
   * the whole collection in Node to find them would grow with the register for ever.
   *
   * Resolved before the main query so that "only the latest" can be part of the *filter*. As a
   * post-filter it would thin each page after paging — a page of fifty coming back as three,
   * with a "load more" that fetched the next fifty to do the same thing again.
   */
  const newestRows = await Delivery.aggregate([
    { $match: { audit: { $in: auditIds } } },
    { $sort: { sentAt: -1, _id: -1 } },
    { $group: { _id: '$audit', delivery: { $first: '$_id' } } },
  ]);
  const newest = new Map(newestRows.map((row) => [String(row._id), String(row.delivery)]));

  if (query.latestOnly) {
    filter._id = { $in: newestRows.map((row) => row.delivery) };
  }

  // A hash is an exact question, so it replaces the free-text search rather than narrowing it.
  if (validHash) filter.fileHash = hash;

  const text = String(query.q ?? '').trim();
  if (!wantsHash && text) {
    const re = new RegExp(escapeRegex(text), 'i');
    filter.$or = [
      { version: re },
      { filename: re },
      { note: re },
      { 'recipients.name': re },
      { 'recipients.email': re },
    ];
  }

  if (query.from || query.to) {
    filter.sentAt = {};
    if (query.from) filter.sentAt.$gte = new Date(`${query.from}T00:00:00`);
    // Inclusive of the closing day: somebody filtering "to the 14th" means the 14th.
    if (query.to) filter.sentAt.$lte = new Date(`${query.to}T23:59:59.999`);
  }
  if (query.unhashedOnly) filter.fileHash = '';

  /*
   * Totals are counted over the *filtered* set but before paging, so the summary describes what
   * the filters selected rather than the fifty rows that happen to be on screen.
   */
  const totalsPromise = Delivery.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        deliveries: { $sum: 1 },
        engagements: { $addToSet: '$audit' },
        unhashed: { $sum: { $cond: [{ $eq: ['$fileHash', ''] }, 1, 0] } },
      },
    },
  ]);

  const paged = { ...filter };
  // Cursor rather than skip: the register only grows, and a skip deep into it re-walks
  // everything ahead of the page every time.
  if (query.before) paged.sentAt = { ...(paged.sentAt ?? {}), $lt: new Date(query.before) };

  const [rows, [totals]] = await Promise.all([
    Delivery.find(paged)
      .populate([
        { path: 'sentBy', select: 'username firstname lastname' },
        { path: 'createdBy', select: 'username firstname lastname' },
      ])
      .sort({ sentAt: -1, _id: -1 })
      .limit(limit + 1),
    totalsPromise,
  ]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const clients = new Set();
  let stale = 0;
  let unknown = 0;

  const deliveries = page
    .map((row) => {
      const audit = audits.get(String(row.audit));
      const recorded = Boolean(row.contentFingerprint);
      const current = audit?.contentFingerprint ?? '';
      /*
       * Three states, not two. "Changed" and "unchanged" are both claims; a row written before
       * the fingerprint was kept supports neither, and reporting it as unchanged would be the
       * most reassuring possible lie for this particular page to tell.
       */
      const changedSince = recorded && current ? row.contentFingerprint !== current : null;
      if (changedSince === true) stale += 1;
      if (changedSince === null) unknown += 1;
      if (audit?.company?._id) clients.add(String(audit.company._id));

      return {
        _id: row._id,
        audit: audit
          ? {
              _id: audit._id,
              name: audit.name,
              reference: audit.reference ?? '',
              state: audit.state,
              client: audit.company
                ? { _id: audit.company._id, name: audit.company.name }
                : null,
            }
          : null,
        version: row.version,
        sentAt: row.sentAt,
        channel: row.channel,
        recipients: (row.recipients ?? []).map((entry) => ({
          name: entry.name,
          email: entry.email,
        })),
        filename: row.filename,
        fileHash: row.fileHash,
        fileSize: row.fileSize,
        kind: row.kind,
        note: row.note,
        sentBy: row.sentBy,
        isLatest: newest.get(String(row.audit)) === String(row._id),
        /** True, false, or null for "we did not record what the report said at the time". */
        changedSince,
        fingerprintRecorded: recorded,
      };
    })
    /*
     * A delivery whose engagement is not in the visible map cannot be rendered and must not be
     * counted. That only happens if an engagement is trashed between the two queries, but a
     * register that silently prints a row with no engagement is worse than one row short.
     */
    .filter((row) => row.audit);

  return {
    deliveries,
    hasMore,
    /** Hand this back as `before` for the next page. */
    nextBefore: hasMore ? page[page.length - 1].sentAt.toISOString() : null,
    totals: {
      deliveries: totals?.deliveries ?? 0,
      engagements: (totals?.engagements ?? []).length,
      clients: clients.size,
      /** Deliveries recorded without a digest — the honest quality number for this register. */
      unhashed: totals?.unhashed ?? 0,
      stale,
      unknown,
    },
    /** What a hash lookup found, said plainly, because "no rows" has two very different causes. */
    match: wantsHash ? { hash, valid: true, found: deliveries.length, reason: '' } : null,
  };
}

export default deliveryRegister;
