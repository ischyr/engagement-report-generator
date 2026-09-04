import { useMemo, useState } from 'react';
import {
  Bug,
  CheckCircle2,
  CircleDashed,
  KeyRound,
  MinusCircle,
  NotebookPen,
  Radar,
  Server,
} from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { cn } from '../../lib/utils.js';

import { Badge } from '../ui/Badge.jsx';
import { SearchInput, Stat, Tabs } from '../ui/Misc.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import HostWorkspace from './HostWorkspace.jsx';

const STATUS_META = {
  pending: { label: 'Not finished', tone: 'neutral', icon: CircleDashed, dot: 'bg-fg-subtle' },
  tested: { label: 'Tested', tone: 'success', icon: CheckCircle2, dot: 'bg-low' },
  excluded: { label: 'Excluded', tone: 'warning', icon: MinusCircle, dot: 'bg-med' },
};

const VIEWS = [
  { value: 'all', label: 'Everything' },
  { value: 'pending', label: 'Not finished' },
  { value: 'findings', label: 'Has findings' },
  { value: 'clean', label: 'Tested, nothing found' },
];

/**
 * The engagement seen host by host, which is how it is actually worked.
 *
 * The rest of the app is organised around findings, because that is what a report is made of. But
 * during the test the unit of work is an asset: you take a host, you go through it, you finish it,
 * you take the next one. Everything about that host was scattered across four places and nothing
 * anywhere said which ones were done.
 */
export default function HostBoard({ audit, editable }) {
  const { data, loading, reload } = useResource(`/audits/${audit._id}/hosts`, { initial: null });
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);

  const hosts = data?.hosts ?? [];
  const counts = data?.counts ?? null;

  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return hosts
      .filter((host) => {
        if (view === 'pending') return host.status === 'pending';
        if (view === 'findings') return host.findings > 0;
        if (view === 'clean') return host.status === 'tested' && host.findings === 0;
        return true;
      })
      .filter((host) =>
        text
          ? [host.hostname, host.ip, host.os, ...host.groups]
              .filter(Boolean)
              .some((value) => value.toLowerCase().includes(text))
          : true
      );
  }, [hosts, view, query]);

  if (loading && !data) return <LoadingBlock label="Reading the scope…" />;

  if (!hosts.length) {
    return (
      <EmptyState
        icon={Server}
        title="Nothing in the scope yet"
        description="Add assets on the list view — paste them in, or import an nmap scan — and they appear here as work to get through."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {counts ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Assets"
            value={counts.total}
            sub={`${counts.tested} tested, ${counts.pending} to go`}
            icon={Server}
          />
          <Stat
            label="With findings"
            value={counts.withFindings}
            sub="something was found on these"
            tone={counts.withFindings ? 'high' : undefined}
            icon={Bug}
          />
          {/*
            The number that decides what to pick up next: something was found here and nobody
            has said the host is finished, so there is probably more on it.
          */}
          <Stat
            label="Unfinished, with findings"
            value={counts.unfinishedWithFindings}
            sub="findings already, and not marked tested"
            tone={counts.unfinishedWithFindings ? 'crit' : undefined}
            icon={CircleDashed}
          />
          <Stat
            label="Tested, nothing found"
            value={counts.testedClean}
            sub="most hosts are clean — worth a glance before sign-off"
            icon={CheckCircle2}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Tabs options={VIEWS} value={view} onChange={setView} size="sm" />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Hostname, address, OS, group…"
          className="min-w-48 flex-1"
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Server}
          title="Nothing matches"
          description="No asset in the scope fits that filter."
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((host) => {
            const meta = STATUS_META[host.status] ?? STATUS_META.pending;
            return (
              <button
                key={host.key}
                type="button"
                onClick={() => setOpen(host.key)}
                className={cn(
                  'flex flex-col gap-2 rounded-xl border bg-surface/60 px-4 py-3 text-left transition',
                  'hover:border-brand-500/40 hover:bg-surface',
                  host.status === 'pending' && host.findings
                    ? 'border-crit/30'
                    : 'border-line-soft'
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', meta.dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">
                      {host.label}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[0.625rem] text-fg-subtle">
                      {[host.hostname && host.ip ? host.ip : null, host.os]
                        .filter(Boolean)
                        .join(' · ') || host.groups.join(', ') || '—'}
                    </span>
                  </span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>

                {/* Only what is there. A row of four zeroes on every clean host is noise. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-fg-subtle">
                  {host.findings ? (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        host.openFindings ? 'text-high' : 'text-fg-subtle'
                      )}
                    >
                      <Bug size={11} />
                      {host.findings} finding{host.findings === 1 ? '' : 's'}
                      {/* "(0 open)" is a worse way of saying "all fixed", and the two cases
                          deserve different colours anyway. */}
                      {host.openFindings === 0
                        ? ' · all fixed'
                        : host.openFindings !== host.findings
                          ? ` · ${host.openFindings} open`
                          : ''}
                    </span>
                  ) : null}
                  {host.services ? (
                    <span className="inline-flex items-center gap-1">
                      <Server size={11} />
                      {host.services} service{host.services === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {/* Icon plus a bare number reads as a mystery at a glance, so both say what
                      they are on hover — the label itself would make the row too busy. */}
                  {host.detections ? (
                    <span
                      className="inline-flex items-center gap-1"
                      title={`${host.detections} logged action${
                        host.detections === 1 ? '' : 's'
                      } against this asset`}
                    >
                      <Radar size={11} />
                      {host.detections}
                    </span>
                  ) : null}
                  {host.credentials ? (
                    <span
                      className="inline-flex items-center gap-1"
                      title={`${host.credentials} credential${
                        host.credentials === 1 ? '' : 's'
                      } mention this asset`}
                    >
                      <KeyRound size={11} />
                      {host.credentials}
                    </span>
                  ) : null}
                  {host.hasNotes ? (
                    <span className="inline-flex items-center gap-1 text-brand-300">
                      <NotebookPen size={11} />
                      notes
                    </span>
                  ) : null}
                </div>

                {host.statusNote ? (
                  <p className="truncate text-[0.625rem] leading-relaxed text-fg-muted">
                    {host.statusNote}
                  </p>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <HostWorkspace
        auditId={audit._id}
        hostKey={open}
        editable={editable}
        onClose={() => setOpen(null)}
        onSaved={() => reload({ quiet: true })}
      />
    </div>
  );
}
