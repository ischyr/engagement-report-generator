import { useEffect, useMemo, useState } from 'react';
import { ServerCog } from 'lucide-react';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Checkbox } from '../ui/Field.jsx';
import { SearchInput } from '../ui/Misc.jsx';
import { hostsFromScope, scopeHostsHtml } from '../../lib/scope-hosts.js';

/**
 * Picking the affected assets out of the scope instead of retyping them.
 *
 * One issue on nine of forty hosts was a paragraph somebody typed by hand, from a list in another
 * tab, at the end of a long day — and a report full of hand-typed addresses is a report with a
 * typo'd address in it somewhere. The scope is structured: it came out of an Nmap import, with
 * services and ports, so the affected-assets field can simply be filled from it.
 *
 * Two details make this worth more than the typing it saves:
 *
 *   - It writes both addresses when a host has both, because `host-view.service.js` matches
 *     findings to hosts by looking for either one in this very field. Assets picked here are
 *     therefore assets the per-host view finds, without anybody arranging that.
 *   - It leads with the count. "These nine of the forty" is the sentence a reader needs and the
 *     one nobody writes, and it is only truthful if something counts the scope for you.
 */
export default function ScopeHostPicker({ open, onClose, scope, onInsert }) {
  const groups = useMemo(() => hostsFromScope(scope), [scope]);
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.hosts.length, 0), [groups]);

  const [chosen, setChosen] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [withPorts, setWithPorts] = useState(true);

  /* A fresh choice each time it opens: last week's selection is never this finding's. */
  useEffect(() => {
    if (open) {
      setChosen(new Set());
      setFilter('');
    }
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          hosts: group.hosts.filter(
            (host) =>
              !needle ||
              `${host.hostname} ${host.ip} ${host.os} ${host.ports.join(' ')}`
                .toLowerCase()
                .includes(needle)
          ),
        }))
        .filter((group) => group.hosts.length),
    [groups, needle]
  );

  const toggle = (key) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** All of a group, or none of it — the common case is "the whole of the internal range". */
  const toggleGroup = (group) =>
    setChosen((current) => {
      const next = new Set(current);
      const keys = group.hosts.map((host) => host.key);
      if (keys.every((key) => next.has(key))) keys.forEach((key) => next.delete(key));
      else keys.forEach((key) => next.add(key));
      return next;
    });

  const picked = useMemo(
    () => groups.flatMap((group) => group.hosts).filter((host) => chosen.has(host.key)),
    [groups, chosen]
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Affected assets, from the scope"
      description={
        total
          ? `${total} host${total === 1 ? '' : 's'} in scope. Pick the ones this finding is about.`
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={ServerCog}
            disabled={!picked.length}
            onClick={() => onInsert(scopeHostsHtml(picked, { total, withPorts }))}
          >
            {picked.length ? `Insert ${picked.length} of ${total}` : 'Insert'}
          </Button>
        </>
      }
    >
      {!total ? (
        <p className="text-sm text-fg-muted">
          There is nothing in this engagement's scope yet. Import a scan or add hosts on the Scope
          tab and they will be offered here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter by address, OS or port…"
          />

          <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto">
            {visible.map((group) => {
              const all = group.hosts.every((host) => chosen.has(host.key));
              return (
                <div key={group.key} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <h4 className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">
                      {group.name}
                    </h4>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      className="rounded px-1.5 py-0.5 text-[0.6875rem] text-fg-muted transition hover:bg-white/5 hover:text-fg"
                    >
                      {all ? 'None' : `All ${group.hosts.length}`}
                    </button>
                  </div>

                  <ul className="divide-y divide-line-soft rounded-lg border border-line">
                    {group.hosts.map((host) => (
                      <li key={host.key} className="flex items-center gap-2.5 px-3 py-2">
                        <Checkbox
                          checked={chosen.has(host.key)}
                          onChange={() => toggle(host.key)}
                          id={`scope-host-${host.key}`}
                        />
                        <label
                          htmlFor={`scope-host-${host.key}`}
                          className="min-w-0 flex-1 cursor-pointer"
                        >
                          <span className="block truncate text-xs text-fg">
                            {host.hostname || host.ip}
                            {host.hostname && host.ip ? (
                              <span className="ml-1.5 font-mono text-fg-subtle">{host.ip}</span>
                            ) : null}
                          </span>
                          <span className="block truncate text-[0.6875rem] text-fg-subtle">
                            {[host.os, host.ports.length ? `${host.ports.join(', ')}` : '']
                              .filter(Boolean)
                              .join(' · ') || 'No services recorded'}
                          </span>
                        </label>
                        {/*
                          Shown rather than hidden: an excluded host is occasionally the right
                          answer ("this was in scope and we could not reach it"), and quietly
                          dropping it would hide a decision somebody made on the Scope tab.
                        */}
                        {host.status === 'excluded' ? (
                          <Badge tone="warning">Excluded</Badge>
                        ) : host.status === 'pending' ? (
                          <Badge tone="neutral">Not tested</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            {!visible.length ? (
              <p className="px-1 text-xs text-fg-subtle">Nothing in scope matches that.</p>
            ) : null}
          </div>

          <Checkbox
            checked={withPorts}
            onChange={setWithPorts}
            label="Include the ports found on each host"
            id="scope-host-ports"
          />
        </div>
      )}
    </Modal>
  );
}
