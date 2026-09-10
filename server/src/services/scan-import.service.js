/**
 * Turns scanner output into scope entries.
 *
 * Nmap XML only, for now: it is the scan every engagement starts with, it maps
 * exactly onto the hosts-and-services shape the scope model already has, and its
 * format is stable and self-describing.
 *
 * Parsing is done with targeted regexes rather than a DOM parser. Nmap's schema is
 * shallow and fixed — `<host>` containing `<address>`, `<hostnames>`, `<ports>`,
 * `<os>` — so this avoids a dependency for a job that does not need one. Anything
 * unrecognised is skipped rather than guessed at.
 */

import { badRequest } from '../utils/http-error.js';

const decodeXml = (value) =>
  String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');

/** Reads an attribute out of a start tag. */
const attr = (fragment, name) => {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(fragment);
  return match ? decodeXml(match[1]) : '';
};

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * @param {string} xml contents of an `nmap -oX` file
 * @param {{onlyOpen?: boolean, includeDown?: boolean}} [options]
 * @returns {{hosts: Array, stats: object, meta: object}}
 */
export function parseNmapXml(xml, options = {}) {
  const { onlyOpen = true, includeDown = false } = options;

  if (typeof xml !== 'string' || !/<nmaprun\b/.test(xml)) {
    throw badRequest(
      'That does not look like Nmap XML. Run your scan with -oX to produce it.'
    );
  }

  const runTag = /<nmaprun\b[^>]*>/.exec(xml)?.[0] ?? '';
  const meta = {
    scanner: attr(runTag, 'scanner') || 'nmap',
    version: attr(runTag, 'version'),
    args: attr(runTag, 'args'),
    startedAt: attr(runTag, 'startstr'),
  };

  const hosts = [];
  const stats = { hostsSeen: 0, hostsDown: 0, hostsImported: 0, services: 0, portsClosed: 0 };

  for (const match of xml.matchAll(/<host\b[^>]*>[\s\S]*?<\/host>/g)) {
    const block = match[0];
    stats.hostsSeen += 1;

    const statusTag = /<status\b[^>]*>/.exec(block)?.[0] ?? '';
    const state = attr(statusTag, 'state');
    if (state && state !== 'up') {
      stats.hostsDown += 1;
      if (!includeDown) continue;
    }

    // A host can carry several addresses (IPv4, IPv6, MAC); take the first of each
    // kind that is actually an address.
    let ip = '';
    for (const addressMatch of block.matchAll(/<address\b[^>]*\/?>/g)) {
      const type = attr(addressMatch[0], 'addrtype');
      const value = attr(addressMatch[0], 'addr');
      if (!value) continue;
      if (type === 'ipv4' || type === 'ipv6') {
        if (!ip) ip = value;
      }
    }

    // Prefer the reverse-DNS/user-supplied name over nothing.
    let hostname = '';
    for (const nameMatch of block.matchAll(/<hostname\b[^>]*\/?>/g)) {
      const name = attr(nameMatch[0], 'name');
      const type = attr(nameMatch[0], 'type');
      if (!name) continue;
      // "user" is what was typed on the command line — the most meaningful label.
      if (type === 'user') {
        hostname = name;
        break;
      }
      if (!hostname) hostname = name;
    }

    // OS: the highest-accuracy guess Nmap offers.
    let os = '';
    let bestAccuracy = -1;
    for (const osMatch of block.matchAll(/<osmatch\b[^>]*\/?>/g)) {
      const accuracy = Number(attr(osMatch[0], 'accuracy') || 0);
      const name = attr(osMatch[0], 'name');
      if (name && accuracy > bestAccuracy) {
        bestAccuracy = accuracy;
        os = name;
      }
    }

    const services = [];
    for (const portMatch of block.matchAll(/<port\b[^>]*>[\s\S]*?<\/port>|<port\b[^>]*\/>/g)) {
      const portBlock = portMatch[0];
      const portTag = /<port\b[^>]*>/.exec(portBlock)?.[0] ?? '';
      const portNumber = Number(attr(portTag, 'portid'));
      if (!Number.isInteger(portNumber)) continue;

      const stateTag = /<state\b[^>]*\/?>/.exec(portBlock)?.[0] ?? '';
      const portState = attr(stateTag, 'state');
      if (onlyOpen && portState !== 'open') {
        stats.portsClosed += 1;
        continue;
      }

      const serviceTag = /<service\b[^>]*\/?>/.exec(portBlock)?.[0] ?? '';
      const product = [attr(serviceTag, 'product'), attr(serviceTag, 'version')]
        .filter(Boolean)
        .join(' ');

      services.push({
        port: portNumber,
        protocol: attr(portTag, 'protocol') || 'tcp',
        name: attr(serviceTag, 'name') || (portState !== 'open' ? portState : ''),
        product,
      });
    }
    services.sort((a, b) => a.port - b.port);
    stats.services += services.length;

    if (!hostname && !ip) continue;
    // Nmap reports a bare IP as the hostname when there is no reverse DNS; keep
    // the columns meaning what they say.
    if (hostname && !ip && IPV4.test(hostname)) {
      ip = hostname;
      hostname = '';
    }

    hosts.push({ hostname, ip, os, services });
    stats.hostsImported += 1;
  }

  if (hosts.length === 0) {
    throw badRequest(
      stats.hostsSeen
        ? `The scan has ${stats.hostsSeen} host(s) but none were up with open ports.`
        : 'No hosts found in that scan file.'
    );
  }

  return { hosts, stats, meta };
}

/**
 * Merges parsed hosts into existing scope groups.
 *
 * Matching is on IP first, then hostname: re-importing a later scan of the same
 * range should update those hosts rather than duplicate them, which is what makes
 * this usable more than once per engagement.
 *
 * @returns {{scope: Array, added: number, updated: number}}
 */
export function mergeHostsIntoScope(existingScope, hosts, groupName) {
  const scope = (existingScope ?? []).map((group) => ({
    name: group.name ?? '',
    hosts: (group.hosts ?? []).map((host) => ({
      hostname: host.hostname ?? '',
      ip: host.ip ?? '',
      os: host.os ?? '',
      services: host.services ?? [],
    })),
  }));

  let target = scope.find((group) => group.name === groupName);
  if (!target) {
    target = { name: groupName, hosts: [] };
    scope.push(target);
  }

  // Index every host in the engagement, not just the target group — the same
  // machine should not appear twice under different group names.
  const index = new Map();
  for (const group of scope) {
    for (const host of group.hosts) {
      if (host.ip) index.set(`ip:${host.ip}`, host);
      if (host.hostname) index.set(`name:${host.hostname.toLowerCase()}`, host);
    }
  }

  let added = 0;
  let updated = 0;

  for (const incoming of hosts) {
    const existing =
      (incoming.ip && index.get(`ip:${incoming.ip}`)) ||
      (incoming.hostname && index.get(`name:${incoming.hostname.toLowerCase()}`)) ||
      null;

    if (existing) {
      // Fill gaps and refresh services; never blank out something already known.
      if (incoming.hostname && !existing.hostname) existing.hostname = incoming.hostname;
      if (incoming.ip && !existing.ip) existing.ip = incoming.ip;
      if (incoming.os) existing.os = incoming.os;
      if (incoming.services.length) existing.services = incoming.services;
      updated += 1;
      continue;
    }

    const host = { ...incoming };
    target.hosts.push(host);
    if (host.ip) index.set(`ip:${host.ip}`, host);
    if (host.hostname) index.set(`name:${host.hostname.toLowerCase()}`, host);
    added += 1;
  }

  return { scope, added, updated };
}

export default parseNmapXml;
