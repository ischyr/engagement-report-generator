import { useEffect, useRef, useState } from 'react';
import { Crosshair, ListTree, Plus, Radar, Save, Server, Trash2, Upload, Wand2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useUnsavedWork } from '../../context/UnsavedContext.jsx';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { cn } from '../../lib/utils.js';
import { Input, Textarea } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';
import ConflictDialog from '../ui/ConflictDialog.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';
import ScopeChangesCard from './ScopeChangesCard.jsx';
import HostBoard from './HostBoard.jsx';
import { Tabs } from '../ui/Misc.jsx';

const blankHost = () => ({
  hostname: '',
  ip: '',
  os: '',
  services: [],
  status: 'pending',
  statusNote: '',
  // Invisible in this editor and still listed, for the same reason `status` is: whatever this
  // object holds is what gets saved back, so a field missing here is a field wiped on save.
  notes: '',
});
const blankGroup = () => ({ name: '', hosts: [blankHost()] });

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Two ways to look at the same assets.
 *
 * The list is the report's scope: groups, rows, the thing a template loops over. The working view
 * is the same assets as *work* — what is done, what has findings on it, what to pick up next.
 * A toggle rather than a thirteenth tab, the way the Checks tab already splits itself.
 */
const VIEWS = [
  { value: 'list', label: 'The list', icon: ListTree },
  { value: 'work', label: 'Working view', icon: Server },
];

/**
 * Bulk entry: one asset per line. Accepts `host`, `ip`, `host,ip,os` or
 * `host ip os`, which covers pasting straight out of a scope document or an
 * nmap summary.
 */
function parseBulk(text) {
  const hosts = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line
      .split(/[,;\t]|\s{2,}|\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) continue;

    const host = blankHost();
    for (const part of parts) {
      if (IPV4.test(part) && !host.ip) host.ip = part;
      else if (!host.hostname) host.hostname = part;
      else host.os = host.os ? `${host.os} ${part}` : part;
    }
    // A bare IP should land in the ip column, not the hostname column.
    if (!host.ip && IPV4.test(host.hostname)) {
      host.ip = host.hostname;
      host.hostname = '';
    }
    hosts.push(host);
  }
  return hosts;
}

function BulkAddModal({ open, onClose, onAdd }) {
  const [text, setText] = useState('');
  const parsed = parseBulk(text);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Paste a list of assets"
      description="One per line. Hostname, IP and operating system can be separated by commas, tabs or spaces."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={parsed.length === 0}
            onClick={() => {
              onAdd(parsed);
              setText('');
              onClose();
            }}
          >
            Add {parsed.length || ''} asset{parsed.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <Textarea
        rows={9}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-xs"
        placeholder={'www.acme.example, 203.0.113.10, Ubuntu 22.04\napi.acme.example, 203.0.113.11\n198.51.100.24'}
      />
      {parsed.length ? (
        <p className="mt-2 text-xs text-fg-muted">
          Parsed {parsed.length} asset{parsed.length === 1 ? '' : 's'}. First:{' '}
          <span className="font-mono text-fg">
            {[parsed[0].hostname, parsed[0].ip, parsed[0].os].filter(Boolean).join(' · ')}
          </span>
        </p>
      ) : null}
    </Modal>
  );
}

/**
 * Imports an `nmap -oX` scan into the scope.
 *
 * Re-importable on purpose: hosts are matched on IP then hostname, so a later
 * scan of the same range refreshes services rather than duplicating rows. That is
 * the normal rhythm of an engagement — scan, test, rescan.
 */
function NmapImport({ auditId, onImported }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [group, setGroup] = useState('Imported from Nmap');
  const [busy, setBusy] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('group', group.trim() || 'Imported from Nmap');
      const result = await api.post(`/audits/${auditId}/scope/import`, body);

      const parts = [];
      if (result.added) parts.push(`${result.added} added`);
      if (result.updated) parts.push(`${result.updated} updated`);
      toast.success(
        parts.join(', ') || 'Nothing new',
        `${result.stats.services} open service(s) from ${result.stats.hostsSeen} scanned host(s)` +
          (result.stats.hostsDown ? `, ${result.stats.hostsDown} down and skipped` : '')
      );
      onImported?.(result);
    } catch (error) {
      toast.fromError(error, 'Could not read that scan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Import from Nmap"
        icon={Radar}
        description="Upload the XML from `nmap -oX scan.xml …` to fill in hosts, operating systems and open services."
      />
      <CardBody className="flex flex-wrap items-end gap-3">
        <Input
          label="Put them in this group"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          wrapperClassName="w-64"
          hint="An existing group with this name is reused."
        />
        <Button
          variant="secondary"
          icon={Upload}
          loading={busy}
          onClick={() => inputRef.current?.click()}
        >
          Choose scan XML
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".xml,text/xml,application/xml"
          className="hidden"
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <p className="w-full text-xs leading-relaxed text-fg-subtle">
          Only hosts that were up with open ports are imported. Running it again after
          a rescan updates the same hosts instead of duplicating them.
        </p>
      </CardBody>
    </Card>
  );
}

export default function ScopeTab({ audit, editable, onPatch, onReload }) {
  const toast = useToast();
  const [groups, setGroups] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [bulkFor, setBulkFor] = useState(null);
  const [view, setView] = useState('list');

  useUnsavedWork(dirty, 'The scope');
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    const incoming = (audit.scope ?? []).map((group) => ({
      name: group.name ?? '',
      /*
       * Named rather than spread, so the editor's shape is explicit — and every field the schema
       * has must appear here. A field left out is not merely invisible: this list is what gets
       * saved back, so an omission silently wipes it. `status` was exactly that.
       */
      hosts: (group.hosts ?? []).map((host) => ({
        hostname: host.hostname ?? '',
        ip: host.ip ?? '',
        os: host.os ?? '',
        services: host.services ?? [],
        status: host.status ?? 'pending',
        statusNote: host.statusNote ?? '',
        /*
         * Edited in the working view, never here — and carried anyway. This list is what the
         * save writes back, so leaving it out would silently delete every operator's notes the
         * next time anybody touched the scope. Exactly the trap `status` fell into once.
         */
        notes: host.notes ?? '',
      })),
    }));
    setGroups(incoming);
    setDirty(false);
  }, [audit]);

  const mutate = (updater) => {
    setGroups((current) => updater(structuredClone(current)));
    setDirty(true);
  };

  const save = async ({ force = false } = {}) => {
    setSaving(true);
    try {
      // Drop rows the user left completely blank.
      const payload = groups
        .map((group) => ({
          ...group,
          hosts: group.hosts.filter((h) => h.hostname || h.ip || h.os),
        }))
        .filter((group) => group.name || group.hosts.length);

      const updated = await api.put(`/audits/${audit._id}`, {
        scope: payload,
        // A scan import or someone else's scope edit should not be silently lost.
        ...(audit.detailsUpdatedAt && !force
          ? { expectedUpdatedAt: audit.detailsUpdatedAt }
          : {}),
      });
      setConflict(null);
      onPatch(updated);
      setDirty(false);
      toast.success('Scope saved');
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const hostCount = groups.reduce((sum, g) => sum + g.hosts.length, 0);

  if (view === 'work') {
    return (
      <div className="flex flex-col gap-4">
        <Tabs options={VIEWS} value={view} onChange={setView} size="sm" className="self-start" />
        {/*
          Unsaved edits on the list would be lost by the targeted saves the working view makes,
          and silently — so it says so rather than letting two editors write over each other.
        */}
        {dirty ? (
          <p className="rounded-lg border border-med/25 bg-med/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
            The list has unsaved changes. Go back and save them first — this view writes one asset
            at a time and would not carry them.
          </p>
        ) : null}
        <HostBoard audit={audit} editable={editable && !dirty} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs options={VIEWS} value={view} onChange={setView} size="sm" className="self-start" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          {hostCount === 0
            ? 'Nothing in scope yet.'
            : `${hostCount} asset${hostCount === 1 ? '' : 's'} across ${groups.length} group${groups.length === 1 ? '' : 's'}.`}{' '}
          Templates read this as the scope and hosts loops.
        </p>
        {editable ? (
          <Button
            variant="secondary"
            size="sm"
            icon={Plus}
            onClick={() => mutate((next) => [...next, blankGroup()])}
          >
            Add group
          </Button>
        ) : null}
      </div>

      {editable ? (
        <NmapImport
          auditId={audit._id}
          onImported={(result) => onPatch({ scope: result.scope })}
        />
      ) : null}

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={Crosshair}
            title="No scope recorded"
            description="Group the assets you tested — for example one group per environment or network segment."
            actionLabel={editable ? 'Add a scope group' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => mutate((next) => [...next, blankGroup()]) : undefined}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group, groupIndex) => (
            <Card key={groupIndex}>
              <CardHeader
                title={
                  <input
                    value={group.name}
                    disabled={!editable}
                    placeholder="Group name (e.g. Production web tier)"
                    onChange={(event) =>
                      mutate((next) => {
                        next[groupIndex].name = event.target.value;
                        return next;
                      })
                    }
                    className="w-full min-w-0 bg-transparent text-sm font-semibold text-fg placeholder:text-fg-subtle focus:outline-none"
                  />
                }
                actions={
                  editable ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={Wand2}
                        onClick={() => setBulkFor(groupIndex)}
                      >
                        Paste list
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={Plus}
                        onClick={() =>
                          mutate((next) => {
                            next[groupIndex].hosts.push(blankHost());
                            return next;
                          })
                        }
                      >
                        Row
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Remove group"
                        className="hover:text-crit"
                        onClick={() =>
                          mutate((next) => next.filter((_, index) => index !== groupIndex))
                        }
                      />
                    </>
                  ) : null
                }
              />
              {/* Coverage where the group is discussed, so "40 of 47" needs no counting. */}
              {group.hosts.length ? (
                <CardBody className="border-b border-line-soft py-2">
                  <p className="text-[0.6875rem] text-fg-subtle">
                    {group.hosts.filter((h) => (h.status ?? 'pending') === 'tested').length} of{' '}
                    {group.hosts.length} reached
                    {group.hosts.some((h) => h.status === 'excluded')
                      ? ` · ${group.hosts.filter((h) => h.status === 'excluded').length} agreed not to test`
                      : ''}
                  </p>
                </CardBody>
              ) : null}

              {group.hosts.length === 0 ? (
                <CardBody>
                  <p className="text-xs text-fg-subtle">
                    No assets in this group yet — add a row or paste a list.
                  </p>
                </CardBody>
              ) : (
                <Table>
                  <THead>
                    <TH>Hostname</TH>
                    <TH>IP address</TH>
                    <TH>Operating system</TH>
                    <TH width="9rem">Reached</TH>
                    <TH width="3rem" />
                  </THead>
                  <TBody>
                    {group.hosts.map((host, hostIndex) => (
                      <TR key={hostIndex}>
                        {['hostname', 'ip', 'os'].map((key) => (
                          <TD key={key} className="p-0">
                            <input
                              value={host[key]}
                              disabled={!editable}
                              placeholder={
                                key === 'hostname'
                                  ? 'www.acme.example'
                                  : key === 'ip'
                                    ? '203.0.113.10'
                                    : 'Ubuntu 22.04'
                              }
                              onChange={(event) =>
                                mutate((next) => {
                                  next[groupIndex].hosts[hostIndex][key] = event.target.value;
                                  return next;
                                })
                              }
                              className="w-full bg-transparent px-4 py-3 text-sm text-fg placeholder:text-fg-subtle focus:bg-white/[0.03] focus:outline-none"
                            />
                          </TD>
                        ))}
                        {/*
                          Whether the asset was actually reached.

                          Three states, not a tick: "we did not get to it" and "we agreed not to"
                          are different sentences at closeout, and a report that conflates them is
                          the one that gets queried. It is a plain select rather than a cycle of
                          icons because the value is printed in the report and has to be
                          unambiguous to whoever sets it.
                        */}
                        <TD className="p-0">
                          <select
                            value={host.status ?? 'pending'}
                            disabled={!editable}
                            onChange={(event) =>
                              mutate((next) => {
                                next[groupIndex].hosts[hostIndex].status = event.target.value;
                                return next;
                              })
                            }
                            className={cn(
                              'w-full cursor-pointer bg-transparent px-4 py-3 text-xs focus:bg-white/[0.03] focus:outline-none',
                              (host.status ?? 'pending') === 'tested'
                                ? 'text-low'
                                : host.status === 'excluded'
                                  ? 'text-fg-subtle'
                                  : 'text-med'
                            )}
                          >
                            <option value="pending">Not reached</option>
                            <option value="tested">Tested</option>
                            <option value="excluded">Not tested</option>
                          </select>
                        </TD>
                        <TD align="right">
                          {editable ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              icon={Trash2}
                              title="Remove asset"
                              className="hover:text-crit"
                              onClick={() =>
                                mutate((next) => {
                                  next[groupIndex].hosts.splice(hostIndex, 1);
                                  return next;
                                })
                              }
                            />
                          ) : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          ))}
        </div>
      )}

      {editable && (dirty || groups.length > 0) ? (
        <div className="sticky bottom-4 z-20 flex items-center justify-end gap-3 rounded-card border border-line bg-overlay/95 px-4 py-3 shadow-pop backdrop-blur">
          <p className="mr-auto text-xs text-fg-muted">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </p>
          <Button
            variant="primary"
            icon={Save}
            loading={saving}
            disabled={!dirty}
            onClick={() => save()}
          >
            Save scope
          </Button>
        </div>
      ) : null}

      <BulkAddModal
        open={bulkFor !== null}
        onClose={() => setBulkFor(null)}
        onAdd={(hosts) =>
          mutate((next) => {
            const target = next[bulkFor];
            // Replace the single blank starter row rather than appending after it.
            const existing = target.hosts.filter((h) => h.hostname || h.ip || h.os);
            target.hosts = [...existing, ...hosts];
            return next;
          })
        }
      />

      {/* Under the scope itself: this says how it got to be what it is. */}
      <ScopeChangesCard audit={audit} editable={editable} />

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={() => {
          setConflict(null);
          onReload?.({ quiet: true });
        }}
        onOverwrite={() => save({ force: true })}
        label="the scope"
        current={conflict}
        loading={saving}
      />
    </div>
  );
}
