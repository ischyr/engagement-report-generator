/**
 * An engagement seen host by host, which is how it is actually worked.
 *
 * The app is organised around findings, because that is what a report is made of. But during the
 * test an operator's unit of work is an **asset**: you take a host, you go through it, you finish
 * it, you take the next one. Everything about that host was scattered — the services in the scope
 * list, the findings that touch it somewhere in a list of forty, the credentials in the vault, the
 * detection log by time rather than by target — and nothing anywhere said "these six are done and
 * these nine are not".
 *
 * Nothing here is a new link between records. It is all *matching* on the addresses a host already
 * has, so it works on every engagement that already exists without anybody re-tagging anything —
 * and every match reports which field it came from, so an operator can see why something is listed
 * rather than trusting it.
 */

import { htmlToPlainText } from './ooxml/html-parser.js';

/**
 * A host's identity is its address.
 *
 * Hosts are `_id: false` subdocuments, so there is no id to address one by. That turns out to
 * suit the domain: the scope importer already matches on IP then hostname when a rescan comes in,
 * so "the same host" has always meant "the same address" here. Correcting a typo in an address
 * therefore makes it a different host, which is the same thing a rescan would conclude.
 */
export const hostKey = (host) =>
  String(host?.ip || host?.hostname || '')
    .trim()
    .toLowerCase();

export const hostLabel = (host) => host?.hostname || host?.ip || 'Unnamed asset';

/** Both addresses, since a finding might name either. */
export const hostAliases = (host) =>
  [host?.ip, host?.hostname].map((value) => String(value ?? '').trim()).filter(Boolean);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a piece of text names this host.
 *
 * The boundaries are the whole trick. A plain `includes` reports `acme.test` as affected by every
 * finding about `api.acme.test`, and `10.0.0.1` as affected by everything about `10.0.0.10` — so
 * the busiest host in any engagement would be whichever one had the shortest name. Requiring that
 * neither neighbour is a word character, a dot or a hyphen makes a match mean the address itself.
 */
export function mentions(text, aliases) {
  if (!text) return false;
  const haystack = String(text);
  return aliases.some((alias) => {
    const pattern = new RegExp(`(^|[^\\w.-])${escapeRegex(alias)}($|[^\\w.-])`, 'i');
    return pattern.test(haystack);
  });
}

/** Rich text has to be read as words, not as markup — a hostname inside an href is not a mention. */
const plain = (html) => {
  if (!html) return '';
  try {
    return htmlToPlainText(html);
  } catch {
    return '';
  }
};

/**
 * Where a match came from, so the operator can judge it.
 *
 * A finding's affected-assets field is the one meant for this and is worth trusting; a hostname
 * appearing in a title or a proof of concept is good evidence too, but seeing which it was is
 * the difference between a fact and a guess.
 */
function matchedFields(finding, aliases) {
  const where = [];
  // `scope` on a finding is the affected hosts/URLs field — named before the engagement had a
  // scope of its own, and worth knowing about when reading this.
  if (mentions(finding.scope, aliases)) where.push('affected assets');
  if (mentions(finding.title, aliases)) where.push('title');
  if (mentions(plain(finding.poc), aliases)) where.push('proof of concept');
  return where;
}

const asObject = (row) => (typeof row?.toObject === 'function' ? row.toObject() : row);

/** Every host in the scope, flattened, with the group it belongs to. */
export function flattenHosts(audit) {
  const out = [];
  for (const group of audit.scope ?? []) {
    const raw = asObject(group);
    for (const host of raw.hosts ?? []) {
      const key = hostKey(host);
      if (!key) continue;
      out.push({ ...host, group: raw.name ?? '', key });
    }
  }
  /*
   * The same address listed in two groups is one asset with two entries, and the working view is
   * about the asset. The first wins; the groups it appears in are collected so nothing is hidden.
   */
  const merged = new Map();
  for (const host of out) {
    const existing = merged.get(host.key);
    if (existing) {
      if (host.group && !existing.groups.includes(host.group)) existing.groups.push(host.group);
      continue;
    }
    merged.set(host.key, { ...host, groups: host.group ? [host.group] : [] });
  }
  return [...merged.values()];
}

/**
 * What touches one host, from everything the engagement holds.
 *
 * @param {object} audit a loaded engagement
 * @param {object} host one row from `flattenHosts`
 * @param {{detections?: Array, credentials?: Array}} extra records that live outside the audit
 */
export function hostWork(audit, host, { detections = [], credentials = [] } = {}) {
  const aliases = hostAliases(host);

  const findings = (audit.findings ?? [])
    .map(asObject)
    .map((finding) => ({ finding, where: matchedFields(finding, aliases) }))
    .filter((row) => row.where.length)
    .map(({ finding, where }) => ({
      _id: finding._id,
      id: finding.id ?? '',
      identifier: finding.identifier,
      title: finding.title,
      cvssv3: finding.cvssv3 ?? '',
      severityOverride: finding.severityOverride ?? '',
      remediationStatus: finding.remediationStatus ?? 'open',
      evidenceCount: finding.evidenceCount ?? 0,
      /** Which field named this host — 'affected' is the one meant for it. */
      matchedIn: where,
    }));

  /*
   * `relatedNotes`, not `notes`. The host carries its own `notes` — the operator's scratch pad —
   * and spreading a second field of the same name over it replaced the pad with this list, which
   * is how a textarea ended up being handed an array.
   */
  const relatedNotes = (audit.notes ?? [])
    .map(asObject)
    .filter((note) => mentions(note.title, aliases) || mentions(plain(note.content), aliases))
    .map((note) => ({ _id: note._id, title: note.title, pinned: Boolean(note.pinned) }));

  const seen = detections
    .map(asObject)
    .filter((row) => mentions(row.target, aliases) || mentions(row.action, aliases))
    .map((row) => ({
      _id: row._id,
      action: row.action,
      occurredAt: row.occurredAt,
      outcome: row.outcome,
      noise: row.noise,
    }));

  const keys = credentials
    .map(asObject)
    .filter((row) => mentions(row.url, aliases) || mentions(row.label, aliases))
    .map((row) => ({ _id: row._id, label: row.label, username: row.username ?? '' }));

  return { findings, relatedNotes, detections: seen, credentials: keys };
}

/**
 * The board: every asset with enough on it to decide what to pick up next.
 *
 * Counts rather than contents — this is the list you scan, and pulling every matched finding for
 * forty hosts to show four numbers each would make the page heavier than the engagement.
 */
export function hostBoard(audit, { detections = [], credentials = [] } = {}) {
  const hosts = flattenHosts(audit).map((host) => {
    const work = hostWork(audit, host, { detections, credentials });
    return {
      key: host.key,
      label: hostLabel(host),
      hostname: host.hostname ?? '',
      ip: host.ip ?? '',
      os: host.os ?? '',
      groups: host.groups,
      services: (host.services ?? []).length,
      status: host.status ?? 'pending',
      statusNote: host.statusNote ?? '',
      /** Whether anything has been written here, without shipping the text to a list view. */
      hasNotes: Boolean((host.notes ?? '').trim()),
      findings: work.findings.length,
      /** Findings still open, because that is the number that decides what to do next. */
      openFindings: work.findings.filter((row) => row.remediationStatus !== 'fixed').length,
      detections: work.detections.length,
      credentials: work.credentials.length,
      relatedNotes: work.relatedNotes.length,
    };
  });

  const counts = {
    total: hosts.length,
    tested: hosts.filter((host) => host.status === 'tested').length,
    pending: hosts.filter((host) => host.status === 'pending').length,
    excluded: hosts.filter((host) => host.status === 'excluded').length,
    withFindings: hosts.filter((host) => host.findings > 0).length,
    /*
     * Finished, and nothing to show for it. Not a criticism — most hosts are clean — but it is
     * the pile worth a second look before a report says the estate was tested.
     */
    testedClean: hosts.filter((host) => host.status === 'tested' && host.findings === 0).length,
    /** The opposite, and the one that actually matters: findings on something nobody finished. */
    unfinishedWithFindings: hosts.filter(
      (host) => host.status === 'pending' && host.findings > 0
    ).length,
  };

  return { hosts, counts };
}

/**
 * Finds a host by either of its addresses.
 *
 * The canonical key is the IP where there is one, because that is what dedupes two entries for
 * the same asset. But a person following a link, or typing one, has whichever address they were
 * looking at — so resolution accepts either, and only the identity is canonical.
 */
export function findHost(audit, key) {
  const wanted = String(key ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  return (
    flattenHosts(audit).find((row) =>
      hostAliases(row).some((alias) => alias.toLowerCase() === wanted)
    ) ?? null
  );
}

/** One host, in full, or null when nothing in the scope has that address. */
export function hostDetail(audit, key, extra = {}) {
  const host = findHost(audit, key);
  if (!host) return null;

  return {
    key: host.key,
    label: hostLabel(host),
    hostname: host.hostname ?? '',
    ip: host.ip ?? '',
    os: host.os ?? '',
    groups: host.groups,
    services: host.services ?? [],
    status: host.status ?? 'pending',
    statusNote: host.statusNote ?? '',
    notes: host.notes ?? '',
    ...hostWork(audit, host, extra),
  };
}

export default hostBoard;
