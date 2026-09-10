/**
 * Turning the engagement's scope into something an affected-assets field can be filled from.
 *
 * Pure on purpose, and in `lib` rather than beside the picker, for the same reason `figures.js` is:
 * the shape of the sentence that ends up in a report is worth a test, and a test cannot mount a
 * dialog. `ScopeHostPicker.jsx` chooses; this decides what the words are.
 */

/** A port as it should read: the number alone, unless the protocol is the surprising one. */
const portLabel = (service) => {
  const port = Number(service?.port);
  if (!Number.isFinite(port) || port <= 0) return '';
  const protocol = String(service?.protocol ?? '').toLowerCase();
  return protocol && protocol !== 'tcp' ? `${port}/${protocol}` : String(port);
};

/**
 * The scope, flattened into groups of pickable hosts.
 *
 * Hosts carry no id — `_id: false` on the subschema, because a host's identity is its address —
 * so the key here is positional. That is right for a dialog, which is looking at one render of
 * one scope, and would be wrong for anything stored.
 */
export function hostsFromScope(scope) {
  const groups = [];

  (Array.isArray(scope) ? scope : []).forEach((group, groupIndex) => {
    const hosts = (group?.hosts ?? [])
      .map((host, hostIndex) => {
        const ports = [
          ...new Set((host?.services ?? []).map(portLabel).filter(Boolean)),
        ].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

        return {
          key: `${groupIndex}-${hostIndex}`,
          hostname: String(host?.hostname ?? '').trim(),
          ip: String(host?.ip ?? '').trim(),
          os: String(host?.os ?? '').trim(),
          status: host?.status ?? 'pending',
          ports,
        };
      })
      /* A row with neither address is a half-typed line on the Scope tab, not an asset. */
      .filter((host) => host.hostname || host.ip);

    if (hosts.length) {
      groups.push({
        key: String(groupIndex),
        name: String(group?.name ?? '').trim() || 'Scope',
        hosts,
      });
    }
  });

  return groups;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * One host, as it should appear in a report.
 *
 * Both addresses when there are both, and not for tidiness: `host-view.service.js` decides which
 * findings affect which host by looking for either address in this field, so writing both is what
 * makes a picked asset show up on that host's page.
 */
export function hostLine(host, { withPorts = true } = {}) {
  const address =
    host.hostname && host.ip ? `${host.hostname} (${host.ip})` : host.hostname || host.ip;
  const ports = withPorts && host.ports.length ? ` — ${host.ports.join(', ')}` : '';
  return `${address}${ports}`;
}

/**
 * The insertion: a sentence that counts, then the list.
 *
 * The count is the point. "These nine of the forty" is what a reader of the finding actually needs
 * in order to know whether it is an isolated mistake or the estate's default configuration, and
 * nobody writes it by hand because counting the scope is tedious and goes stale.
 */
export function scopeHostsHtml(hosts, { total = hosts.length, withPorts = true } = {}) {
  if (!hosts.length) return '';

  const lead =
    hosts.length >= total
      ? total === 1
        ? 'The one host in scope:'
        : `All ${total} hosts in scope:`
      : `${hosts.length} of the ${total} hosts in scope:`;

  const items = hosts
    .map((host) => `<li>${escapeHtml(hostLine(host, { withPorts }))}</li>`)
    .join('');

  return `<p>${lead}</p><ul>${items}</ul>`;
}

export default { hostsFromScope, hostLine, scopeHostsHtml };
