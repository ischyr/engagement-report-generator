/**
 * What an engagement needs, summarised — and whether anybody else has it.
 *
 * Two questions the tab has to answer that a plain list cannot: is this engagement actually ready,
 * and is a tagged item already out somewhere else. The second is the one that saves a wasted trip.
 */

import { KitItem, KIT_OPEN_STATUSES, isOverdue } from '../models/kit-item.model.js';
import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';
import { today as todayString } from '../utils/audit-scope.js';

/**
 * Suggested items, so a list does not start from an empty box.
 *
 * Deliberately short and deliberately generic. A firm's real kit list is its own, and a long menu
 * of guesses is slower to read than typing the four things you actually need.
 */
export const KIT_SUGGESTIONS = [
  { label: 'Loaner laptop', kind: 'hardware' },
  { label: 'Drop box', kind: 'hardware' },
  { label: 'Wi-Fi adapter', kind: 'hardware' },
  { label: '4G SIM', kind: 'connectivity' },
  { label: 'Site badge', kind: 'access' },
  { label: 'VPN token', kind: 'access' },
  { label: 'Ethernet and USB cables', kind: 'consumable' },
];

/**
 * The numbers the tab and the warnings both use.
 *
 * @param {Array} items kit rows
 * @param {{ now?: Date, startsOn?: string }} [options] `startsOn` is the engagement's start day
 */
export function kitSummary(items, { now = new Date(), startsOn = '' } = {}) {
  const today = now.toISOString().slice(0, 10);
  const rows = items.map((row) => (typeof row.toObject === 'function' ? row.toObject() : row));

  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

  const outstanding = rows.filter((row) => ['needed', 'requested'].includes(row.status));
  const out = rows.filter((row) => row.status === 'out');
  const overdue = rows.filter((row) => isOverdue(row, today));
  const missing = rows.filter((row) => row.status === 'missing');

  /*
   * Not ready, and the job has already started.
   *
   * The distinction that matters: three items still to sort out a fortnight before the window is
   * a normal Tuesday, and the same three on the morning of day one is somebody about to travel
   * without a laptop.
   */
  const started = Boolean(startsOn) && startsOn <= today;

  return {
    total: rows.length,
    counts,
    outstanding: outstanding.length,
    out: out.length,
    overdue: overdue.length,
    missing: missing.length,
    /** Nothing left to chase: nothing outstanding, nothing overdue, nothing lost. */
    settled: outstanding.length === 0 && overdue.length === 0 && missing.length === 0,
    notReadyAndStarted: started ? outstanding.length : 0,
    /** Who is holding something, so "who has the box" is answerable without opening rows. */
    holders: [
      ...new Set(rows.filter((row) => row.heldBy).map((row) => String(row.heldBy?._id ?? row.heldBy))),
    ].length,
  };
}

/**
 * Tagged items that are out on another engagement right now.
 *
 * The inventory question without an inventory: two engagements both listing "DB-02" as theirs next
 * week is the double-booking that leaves somebody on site without a box, and it is only findable
 * because a tag identifies a specific object rather than a kind of thing.
 *
 * Scoped to engagements the reader can see. A clash they cannot be told about would be a warning
 * naming work they have no access to.
 */
export async function tagClashes(audit, user) {
  const tagged = await KitItem.find({
    audit: audit._id,
    assetTag: { $nin: ['', null] },
  }).select('assetTag label');
  if (!tagged.length) return [];

  const tags = [...new Set(tagged.map((row) => row.assetTag))];
  const visible = await Audit.find(visibleAuditFilter(user, { _id: { $ne: audit._id } }))
    .select('name')
    .lean();
  const names = new Map(visible.map((row) => [String(row._id), row.name]));
  if (!names.size) return [];

  const elsewhere = await KitItem.find({
    assetTag: { $in: tags },
    status: { $in: KIT_OPEN_STATUSES },
    audit: { $in: [...names.keys()] },
  }).select('assetTag label status audit dueBack');

  return elsewhere.map((row) => ({
    assetTag: row.assetTag,
    label: row.label,
    status: row.status,
    dueBack: row.dueBack ?? '',
    audit: { _id: row.audit, name: names.get(String(row.audit)) ?? '' },
  }));
}

/**
 * Where a tagged item is, across everything the reader can see.
 *
 * The other direction of the same question, for somebody holding a box and wondering whose it is.
 */
export async function whereIs(tag, user) {
  const wanted = String(tag ?? '').trim();
  if (!wanted) return [];

  const visible = await Audit.find(visibleAuditFilter(user)).select('name').lean();
  const names = new Map(visible.map((row) => [String(row._id), row.name]));

  const rows = await KitItem.find({
    assetTag: wanted,
    audit: { $in: [...names.keys()] },
  })
    .populate({ path: 'heldBy', select: 'username firstname lastname' })
    .sort({ updatedAt: -1 });

  return rows.map((row) => ({
    _id: row._id,
    label: row.label,
    status: row.status,
    dueBack: row.dueBack ?? '',
    heldBy: row.heldBy,
    audit: { _id: row.audit, name: names.get(String(row.audit)) ?? '' },
    updatedAt: row.updatedAt,
  }));
}

/**
 * Kit facts for the engagement-health queue.
 *
 * Kept here rather than in the health service because it needs a query, and health is deliberately
 * synchronous over data already in hand. The route hands the result in.
 */
export async function kitHealthFor(auditIds, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const rows = await KitItem.find({
    audit: { $in: auditIds },
    status: { $in: KIT_OPEN_STATUSES },
  }).select('audit status dueBack');

  const byAudit = new Map();
  for (const row of rows) {
    const key = String(row.audit);
    const entry = byAudit.get(key) ?? { outstanding: 0, overdue: 0, missing: 0 };
    if (['needed', 'requested'].includes(row.status)) entry.outstanding += 1;
    if (row.status === 'missing') entry.missing += 1;
    if (isOverdue(row, today)) entry.overdue += 1;
    byAudit.set(key, entry);
  }
  return byAudit;
}

export const today = todayString;
export default kitSummary;
