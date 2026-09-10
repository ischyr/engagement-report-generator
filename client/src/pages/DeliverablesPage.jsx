import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Building2,
  FileCheck2,
  FileSearch,
  Fingerprint,
  Hash,
  Send,
  ShieldQuestion,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useResource, useDebounced } from '../hooks/useResource.js';
import { useToast } from '../context/ToastContext.jsx';
import { cn, displayName, formatDate, formatDateTime } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Stat } from '../components/ui/Misc.jsx';
import { Badge, StateBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input, Select, Toggle } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';

const CHANNEL_LABEL = {
  email: 'Email',
  portal: 'Portal',
  share: 'File share',
  person: 'In person',
  other: 'Other',
};

/**
 * SHA-256 of a file, computed in the browser.
 *
 * The same helper the engagement's Delivery tab uses, for the same reason: identifying a document
 * does not require uploading a second copy of it, and this page holds no files. `crypto.subtle`
 * needs a secure context — localhost counts, plain http on a LAN does not — so a pasted digest
 * stays available as the fallback.
 */
async function sha256(file) {
  if (!window.crypto?.subtle) throw new Error('insecure-context');
  const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const bytes = (size) => {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The first twelve characters of a digest, click to copy all sixty-four.
 *
 * Not `TagChip`, which wraps whatever it is given in `{{ .braces }}` — that component is for
 * template tags and would present a hash as something a template could interpolate.
 */
function HashChip({ hash }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      title={`${hash} — click to copy`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(hash);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        } catch {
          /* A browser that refuses the clipboard still shows the digest in the tooltip. */
        }
      }}
      className="inline-flex items-center rounded-md bg-canvas/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-fg-muted ring-1 ring-line transition hover:text-fg hover:ring-brand-500/30"
    >
      {copied ? <span className="text-low">copied</span> : `${hash.slice(0, 12)}…`}
    </button>
  );
}

/**
 * Every report that has left the building.
 *
 * The delivery record existed and was only readable one engagement at a time, which answers "what
 * did this client get" only if you already know which engagement to open. The questions people
 * actually arrive with run the other way: what did we send them in March, which version are they
 * arguing about, and — the one nothing else answers — somebody has handed us a file, is it ours.
 */
export default function DeliverablesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState(params.get('q') ?? '');
  const search = useDebounced(query, 300);
  const [client, setClient] = useState(params.get('client') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [latestOnly, setLatestOnly] = useState(params.get('latestOnly') === '1');
  const [unhashedOnly, setUnhashedOnly] = useState(params.get('unhashedOnly') === '1');
  /** A digest being looked up. Replaces the text search, because it is an exact question. */
  const [hash, setHash] = useState(params.get('hash') ?? '');
  const [identifying, setIdentifying] = useState('');
  const fileRef = useRef(null);

  /** Pages already loaded, kept so "load more" appends rather than replaces. */
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const qs = new URLSearchParams();
  if (hash) qs.set('hash', hash);
  else if (search) qs.set('q', search);
  if (client) qs.set('client', client);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (latestOnly) qs.set('latestOnly', '1');
  if (unhashedOnly) qs.set('unhashedOnly', '1');

  const { data, error, loading } = useResource(`/deliveries?${qs.toString()}`);
  const { data: filters } = useResource('/deliveries/filters', { initial: null });

  // The URL carries the filters, so a register view is a link somebody can send.
  useEffect(() => {
    setParams(qs, { replace: true });
    // Any change of filter invalidates the pages appended under the old one.
    setExtra([]);
    setCursor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- qs is rebuilt every render
  }, [search, client, from, to, latestOnly, unhashedOnly, hash]);

  /*
   * And carries them *in*, not just out.
   *
   * The filters were read from the URL once, at mount, which made a pasted link work and the back
   * button do nothing — the address changed and the page went on showing the previous filters.
   * Each field is compared before being set, so this and the effect above settle rather than
   * writing to each other for ever.
   */
  const paramHash = params.get('hash') ?? '';
  const paramQuery = params.get('q') ?? '';
  const paramClient = params.get('client') ?? '';
  const paramFrom = params.get('from') ?? '';
  const paramTo = params.get('to') ?? '';
  const paramLatest = params.get('latestOnly') === '1';
  const paramUnhashed = params.get('unhashedOnly') === '1';

  useEffect(() => {
    if (paramHash !== hash) setHash(paramHash);
    // Compared against the debounced value, not the box: mid-typing the two legitimately
    // differ, and resetting the box from the URL would fight the person using it.
    if (paramQuery !== search) setQuery(paramQuery);
    if (paramClient !== client) setClient(paramClient);
    if (paramFrom !== from) setFrom(paramFrom);
    if (paramTo !== to) setTo(paramTo);
    if (paramLatest !== latestOnly) setLatestOnly(paramLatest);
    if (paramUnhashed !== unhashedOnly) setUnhashedOnly(paramUnhashed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driven by the URL alone
  }, [paramHash, paramQuery, paramClient, paramFrom, paramTo, paramLatest, paramUnhashed]);

  const rows = [...(data?.deliveries ?? []), ...extra];
  const totals = data?.totals ?? null;
  const match = data?.match ?? null;
  // The cursor of the last page fetched, or the first page's if none has been.
  const nextBefore = extra.length ? cursor : (data?.nextBefore ?? null);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const next = new URLSearchParams(qs);
      next.set('before', nextBefore);
      const page = await api.get(`/deliveries?${next.toString()}`);
      setExtra((current) => [...current, ...(page.deliveries ?? [])]);
      setCursor(page.nextBefore ?? null);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const identify = async (file) => {
    if (!file) return;
    setIdentifying(file.name);
    try {
      const digest = await sha256(file);
      setQuery('');
      setHash(digest);
    } catch {
      toast.fromError(
        new Error('This browser will not hash a file here'),
        'Paste the digest instead — hashing needs https or localhost.'
      );
    } finally {
      setIdentifying('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clearHash = () => {
    setHash('');
    setIdentifying('');
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Deliverables"
        description="Every report that has left the building, across every engagement — what went, to whom, when, and exactly which file."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(event) => identify(event.target.files?.[0])}
            />
            <Button
              variant="secondary"
              icon={Upload}
              loading={Boolean(identifying)}
              onClick={() => fileRef.current?.click()}
              title="Hash a file in this browser and find which delivery it was"
            >
              Identify a file
            </Button>
          </>
        }
      />

      {totals ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Deliveries"
            value={totals.deliveries}
            sub={`${totals.engagements} engagement${totals.engagements === 1 ? '' : 's'}, ${
              totals.clients
            } client${totals.clients === 1 ? '' : 's'}`}
            icon={Send}
          />
          <Stat
            label="Changed since sending"
            value={totals.stale}
            sub="the report has been edited since the client got it"
            tone={totals.stale ? 'med' : undefined}
            icon={TriangleAlert}
          />
          <Stat
            label="Cannot say"
            value={totals.unknown}
            sub="recorded before the report’s fingerprint was kept"
            icon={ShieldQuestion}
          />
          <Stat
            label="Recorded without a digest"
            value={totals.unhashed}
            sub="these cannot be proved against a file later"
            tone={totals.unhashed ? 'med' : undefined}
            icon={Fingerprint}
          />
        </div>
      ) : null}

      {/*
        A hash lookup is a different mode, not a filter, so it says so and offers a way out. The
        two failure cases are deliberately distinguishable: a digest that is not a SHA-256 at all
        is a typo, and one that matches nothing is an answer.
      */}
      {match ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3',
            !match.valid
              ? 'border-crit/25 bg-crit/[0.06]'
              : match.found
                ? 'border-low/25 bg-low/[0.06]'
                : 'border-med/25 bg-med/[0.06]'
          )}
        >
          <Hash
            size={15}
            className={cn(
              'shrink-0',
              !match.valid ? 'text-crit' : match.found ? 'text-low' : 'text-med'
            )}
          />
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
            {!match.valid ? (
              match.reason
            ) : match.found ? (
              <>
                <strong className="font-semibold text-fg">
                  {match.found === 1
                    ? '1 delivery matches this file.'
                    : `${match.found} deliveries match this file.`}
                </strong>{' '}
                The same document can legitimately have gone out more than once.
              </>
            ) : (
              <>
                <strong className="font-semibold text-fg">
                  Nothing recorded matches this file.
                </strong>{' '}
                Either it never went out from here, or it went out before anybody recorded a
                digest — {totals?.unhashed ?? 0} deliveries have none.
              </>
            )}
            <span className="mt-1 block truncate font-mono text-[0.625rem] text-fg-subtle">
              {match.hash}
            </span>
          </span>
          <Button variant="ghost" size="sm" icon={X} onClick={clearHash}>
            Clear
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon={FileCheck2}
          title="The register"
          description="Read-only. A delivery is recorded, corrected and removed on the engagement that owns it, where the activity log is."
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Version, filename, recipient, note…"
              className="min-w-56 flex-1"
            />
            <Select
              label="Client"
              value={client}
              onChange={(event) => setClient(event.target.value)}
              wrapperClassName="w-48"
              options={[
                { value: '', label: 'Every client' },
                ...(filters?.clients ?? []).map((entry) => ({
                  value: String(entry._id),
                  label: entry.name,
                })),
              ]}
            />
            <Input
              label="Sent from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              wrapperClassName="w-40"
            />
            <Input
              label="Sent to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              wrapperClassName="w-40"
            />
          </div>

          <div className="flex flex-wrap items-center gap-6 border-t border-line-soft pt-3">
            <Toggle
              checked={latestOnly}
              onChange={setLatestOnly}
              label="Only the current version"
              hint="One row per engagement — what each client holds now."
            />
            <Toggle
              checked={unhashedOnly}
              onChange={setUnhashedOnly}
              label="Only those without a digest"
              hint="The ones that cannot be proved against a file later."
            />
          </div>
        </CardBody>

        {loading && !data ? (
          <LoadingBlock label="Reading the register…" />
        ) : error ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSearch}
            title={hash ? 'No delivery matches that file' : 'Nothing recorded yet'}
            description={
              hash
                ? 'Clear the digest to go back to the whole register.'
                : 'A delivery is recorded on an engagement’s Delivery tab once the report has actually gone out. Everything recorded there appears here.'
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TH width="10rem">Sent</TH>
                <TH>Engagement</TH>
                <TH width="7rem">Version</TH>
                <TH>Went to</TH>
                <TH width="14rem">The file</TH>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row._id}>
                    <TD className="whitespace-nowrap">
                      <span className="block text-xs text-fg-muted">
                        {formatDate(row.sentAt)}
                      </span>
                      <span
                        className="mt-0.5 block text-[0.625rem] text-fg-subtle"
                        title={formatDateTime(row.sentAt)}
                      >
                        {CHANNEL_LABEL[row.channel] ?? row.channel}
                        {row.sentBy ? ` · ${displayName(row.sentBy)}` : ''}
                      </span>
                    </TD>

                    <TD className="max-w-xs">
                      <Link
                        to={`/engagements/${row.audit._id}?tab=delivery`}
                        className="block truncate text-xs text-fg transition hover:text-brand-300"
                      >
                        {row.audit.name}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.625rem] text-fg-subtle">
                        {row.audit.reference ? <span>{row.audit.reference}</span> : null}
                        {row.audit.client ? (
                          <Link
                            to={`/clients/${row.audit.client._id}`}
                            className="inline-flex items-center gap-1 transition hover:text-brand-300"
                          >
                            <Building2 size={10} />
                            {row.audit.client.name}
                          </Link>
                        ) : null}
                        <StateBadge state={row.audit.state} />
                      </span>
                    </TD>

                    {/*
                      Laid out by the parent rather than by a `block` on each badge.
                      `cn` is plain clsx with no tailwind-merge, so passing `block` to a Badge
                      left both it and the Badge's own `inline-flex` in the class list, and which
                      one wins is decided by Tailwind's stylesheet order rather than by the
                      attribute — `inline-flex` did, and the three of them piled onto one line
                      across the column. A flex column cannot be overridden from the inside.
                    */}
                    <TD className="whitespace-nowrap align-top">
                      <div className="flex flex-col items-start gap-1">
                        {/* The number and "current" read as one fact, so they share a line. */}
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs text-fg">{row.version || '—'}</span>
                          {row.isLatest ? <Badge tone="brand">current</Badge> : null}
                        </span>
                        {/*
                          Three states. "Unchanged" and "changed" are both claims; a row recorded
                          before the fingerprint was kept supports neither, and calling it
                          unchanged would be the most reassuring possible lie for this page to
                          tell.
                        */}
                        {row.changedSince === true ? (
                          <Badge tone="warning">report changed since</Badge>
                        ) : row.changedSince === null ? (
                          <Badge
                            tone="neutral"
                            title="No fingerprint was recorded with this delivery"
                          >
                            cannot say
                          </Badge>
                        ) : null}
                      </div>
                    </TD>

                    <TD className="max-w-xs">
                      {row.recipients.length ? (
                        <span className="block truncate text-xs text-fg-muted">
                          {row.recipients.map((entry) => entry.name || entry.email).join(', ')}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">nobody recorded</span>
                      )}
                      {row.note ? (
                        <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                          {row.note}
                        </span>
                      ) : null}
                    </TD>

                    <TD>
                      <span className="block truncate text-xs text-fg-muted" title={row.filename}>
                        {row.filename || '—'}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2">
                        {row.fileHash ? (
                          <HashChip hash={row.fileHash} />
                        ) : (
                          <span className="text-[0.625rem] text-med">no digest</span>
                        )}
                        {row.fileSize ? (
                          <span className="text-[0.625rem] text-fg-subtle">
                            {bytes(row.fileSize)}
                          </span>
                        ) : null}
                        {row.kind ? (
                          <span className="text-[0.625rem] uppercase text-fg-subtle">
                            {row.kind}
                          </span>
                        ) : null}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            {/* The register only grows, so it pages by cursor rather than loading all of it. */}
            {nextBefore ? (
              <CardBody className="flex items-center justify-center border-t border-line-soft">
                <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
                  Load more
                </Button>
              </CardBody>
            ) : (
              <CardBody className="border-t border-line-soft">
                <p className="text-center text-[0.625rem] text-fg-subtle">
                  {rows.length} of {totals?.deliveries ?? rows.length} shown — that is all of them.
                </p>
              </CardBody>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
