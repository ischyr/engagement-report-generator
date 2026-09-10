import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Copy,
  ImageOff,
  Archive,
  OctagonPause,
  Pin,
  Tag,
  Plus,
  ScrollText,
  TriangleAlert,
  Trash2,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { AUDIT_STATE_META, cn, timeAgo } from '../lib/utils.js';

import { Card } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Tabs, AvatarGroup } from '../components/ui/Misc.jsx';
import { Badge, StateBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { SeverityBar, SeverityLegend } from '../components/cvss/CvssEditor.jsx';
import TrashDialog from '../components/engagement/TrashDialog.jsx';
import DuplicateEngagementModal from '../components/engagement/DuplicateEngagementModal.jsx';

const STATE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'EDIT', label: AUDIT_STATE_META.EDIT.label },
  { value: 'REVIEW', label: AUDIT_STATE_META.REVIEW.label },
  { value: 'APPROVED', label: AUDIT_STATE_META.APPROVED.label },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function CreateEngagementModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const companies = useResource(open ? '/data/companies' : null, { initial: [] });
  const clients = useResource(open ? '/data/clients' : null, { initial: [] });
  const auditTypes = useResource(open ? '/data/audit-types' : null, { initial: [] });
  const languages = useResource(open ? '/data/languages' : null, { initial: [] });
  const templates = useResource(open ? '/templates?purpose=report' : null, { initial: [] });

  const [form, setForm] = useState({
    name: '',
    reference: '',
    auditType: '',
    language: 'en',
    company: '',
    client: '',
    template: '',
    date: todayIso(),
    date_start: '',
    date_end: '',
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  // Only offer contacts belonging to the chosen company.
  const clientOptions = useMemo(() => {
    const all = clients.data ?? [];
    const scoped = form.company
      ? all.filter((c) => (c.company?._id ?? c.company) === form.company)
      : all;
    return scoped.map((c) => ({
      value: c._id,
      label: [c.firstname, c.lastname].filter(Boolean).join(' ') || c.email,
    }));
  }, [clients.data, form.company]);

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setErrors({ name: 'Give the engagement a name' });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const payload = { ...form };
      // Empty strings would fail ObjectId validation server-side.
      for (const key of ['company', 'client', 'template']) if (!payload[key]) payload[key] = null;

      const audit = await api.post('/audits', payload);
      toast.success('Engagement created');
      onCreated?.(audit);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New engagement"
      description="You can change any of this later."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            Create engagement
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Engagement name"
          required
          autoFocus
          placeholder="Acme Web Platform Assessment"
          wrapperClassName="sm:col-span-2"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          error={errors.name}
        />
        <Input
          label="Reference"
          placeholder="PT-2026-014"
          hint="Your internal or client-facing job reference."
          value={form.reference}
          onChange={(e) => set({ reference: e.target.value })}
        />
        <Select
          label="Engagement type"
          placeholder="Not set"
          value={form.auditType}
          onChange={(e) => set({ auditType: e.target.value })}
          options={(auditTypes.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
          hint="Pre-fills the report sections configured for this type."
        />
        <Select
          label="Client company"
          placeholder="Not set"
          value={form.company}
          onChange={(e) => set({ company: e.target.value, client: '' })}
          options={(companies.data ?? []).map((c) => ({ value: c._id, label: c.name }))}
        />
        <Select
          label="Client contact"
          placeholder={form.company && clientOptions.length === 0 ? 'No contacts for this company' : 'Not set'}
          value={form.client}
          onChange={(e) => set({ client: e.target.value })}
          options={clientOptions}
        />
        <Select
          label="Report template"
          placeholder="Use the engagement type's template"
          value={form.template}
          onChange={(e) => set({ template: e.target.value })}
          options={(templates.data ?? []).map((t) => ({ value: t._id, label: t.name }))}
        />
        <Select
          label="Report language"
          value={form.language}
          onChange={(e) => set({ language: e.target.value })}
          options={(languages.data ?? []).map((l) => ({ value: l.locale, label: l.language }))}
        />
        <Input
          label="Report date"
          type="date"
          value={form.date}
          onChange={(e) => set({ date: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <Input
            label="Testing starts"
            type="date"
            value={form.date_start}
            onChange={(e) => set({ date_start: e.target.value })}
          />
          <Input
            label="Testing ends"
            type="date"
            value={form.date_end}
            onChange={(e) => set({ date_end: e.target.value })}
          />
        </div>
      </form>
    </Modal>
  );
}

/** How stale is worth mentioning. Under a fortnight, an engagement is simply in progress. */
const STALE_DAYS = 14;

/**
 * What needs somebody's attention, as facts rather than a score.
 *
 * Only rendered when there is something to say: a row with nothing wrong should look calm,
 * or the ones with a problem stop standing out. Each chip is the thing to do, not a rating.
 */
function HealthChips({ health, state }) {
  if (!health) return null;
  const chips = [];
  if (health.overdue) {
    chips.push({
      key: 'overdue',
      icon: TriangleAlert,
      tone: 'text-crit',
      label: 'past its end date',
      title: 'The client was promised an end date that has passed, and this is not signed off yet.',
    });
  }
  if (health.noEvidence) {
    chips.push({
      key: 'evidence',
      icon: ImageOff,
      tone: 'text-med',
      label: `${health.noEvidence} without evidence`,
      title: 'Findings with no screenshot in any of their fields.',
    });
  }
  if (health.checksOutstanding) {
    chips.push({
      key: 'checks',
      tone: 'text-fg-subtle',
      label: `${health.checksOutstanding}/${health.checksTotal} checks left`,
      title: 'Checks on this engagement that nobody has ticked.',
    });
  }
  // Staleness is only interesting while the work is supposed to be moving.
  if (health.staleDays >= STALE_DAYS && state !== 'APPROVED') {
    chips.push({
      key: 'stale',
      tone: 'text-fg-subtle',
      label: `quiet for ${health.staleDays} days`,
      title: 'Nothing has been changed here since then.',
    });
  }
  if (!chips.length) return null;

  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.title}
          className={`flex items-center gap-1 text-[0.625rem] ${chip.tone}`}
        >
          {chip.icon ? <chip.icon size={10} className="shrink-0" /> : null}
          {chip.label}
        </span>
      ))}
    </span>
  );
}

export default function EngagementsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { canWrite, user, isAdmin } = useAuth();
  const { data, error, loading, reload } = useResource('/audits', { initial: [] });

  const [search, setSearch] = useState('');
  const [state, setState] = useState('all');
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const list = Array.isArray(data) ? data : [];
  /** Every tag on screen, most used first — derived rather than fetched, since the rows are here. */
  const allTags = useMemo(() => {
    const tally = new Map();
    for (const audit of list) {
      for (const tag of audit.tags ?? []) tally.set(tag, (tally.get(tag) ?? 0) + 1);
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [list]);
  /** Narrows the list to the rows the health chips have something to say about. */
  const [attentionOnly, setAttentionOnly] = useState(false);

  /**
   * Tags the list is narrowed to, all of which must be present.
   *
   * `$all` rather than `$any` because that is what somebody means when they pick two: "PCI *and*
   * retest", not "either". Filtered here rather than by refetching, since the list is already in
   * hand — the server-side `?tags=` filter exists for anything that comes to the API directly.
   */
  const [tagFilter, setTagFilter] = useState([]);

  /** Anything the health chips would draw — the same rule, so the count matches the rows. */
  const needsAttention = (audit) =>
    Boolean(
      audit.health?.overdue ||
        audit.health?.noEvidence ||
        audit.health?.checksOutstanding ||
        (audit.health?.staleDays >= STALE_DAYS && audit.state !== 'APPROVED')
    );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return list.filter((audit) => {
      if (state !== 'all' && audit.state !== state) return false;
      if (attentionOnly && !needsAttention(audit)) return false;
      if (tagFilter.length && !tagFilter.every((tag) => (audit.tags ?? []).includes(tag)))
        return false;
      if (!needle) return true;
      return [audit.name, audit.reference, audit.auditType, audit.company?.name]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [list, search, state, attentionOnly, tagFilter]);

  const tabs = useMemo(
    () =>
      STATE_TABS.map((tab) => ({
        ...tab,
        count: tab.value === 'all' ? list.length : list.filter((a) => a.state === tab.value).length,
      })),
    [list]
  );

  /**
   * Pin, or unpin.
   *
   * The list is ordered by what was touched last, which is right until you are running
   * three jobs and a fourth keeps floating to the top because somebody commented on it.
   * The server does the ordering; this only has to ask and reload.
   */
  const [pinning, setPinning] = useState(null);
  /** The engagement being copied, if any. */
  const [duplicating, setDuplicating] = useState(null);
  const togglePin = async (audit) => {
    setPinning(audit._id);
    try {
      const result = await api.post(`/audits/${audit._id}/pin`, {});
      await reload({ quiet: true });
      if (!result.pinned) toast.success('Unpinned');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setPinning(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await api.del(`/audits/${pendingDelete._id}`);
      toast.success(
        'Moved to the trash',
        result?.retentionDays
          ? `You can restore it for the next ${result.retentionDays} day${
              result.retentionDays === 1 ? '' : 's'
            }.`
          : 'You can restore it from the trash.'
      );
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  const canDelete = (audit) =>
    isAdmin || (audit.creator?._id ?? audit.creator) === (user?.id ?? user?._id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Engagements"
        description="Each engagement holds its own findings, scope, narrative sections and template."
        actions={
          <>
            {/* The archive is not the trash, so it gets its own page rather than a dialog. */}
            <Button as={Link} to="/archive" variant="ghost" icon={Archive}>
              Archive
            </Button>
            <Button variant="ghost" icon={Trash2} onClick={() => setTrashOpen(true)}>
              Trash
            </Button>
            {canWrite ? (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New engagement
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Tabs options={tabs} value={state} onChange={setState} />
        <button
          type="button"
          onClick={() => setAttentionOnly((value) => !value)}
          aria-pressed={attentionOnly}
          title="Only engagements that are overdue, missing evidence, part-checked or quiet"
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ring-1 transition',
            attentionOnly
              ? 'bg-med/15 text-med ring-med/30'
              : 'bg-white/[0.03] text-fg-muted ring-line-soft hover:text-fg'
          )}
        >
          <TriangleAlert size={13} />
          Needs attention
          <span className="font-mono text-[0.625rem] text-fg-subtle">
            {list.filter(needsAttention).length}
          </span>
        </button>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name, reference or client…"
          className="w-full sm:ml-auto sm:w-72"
        />
      </div>

      {/*
        Only the tags actually in use, and only when there are any — a filter row that is empty
        on a fresh instance is furniture.
      */}
      {allTags.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag size={13} className="shrink-0 text-fg-subtle" />
          {allTags.map((tag) => {
            const on = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setTagFilter((current) =>
                    on ? current.filter((entry) => entry !== tag) : [...current, tag]
                  )
                }
                className={cn(
                  'rounded-md px-2 py-1 text-[0.6875rem] font-medium ring-1 ring-inset transition',
                  on
                    ? 'bg-brand-500/12 text-brand-300 ring-brand-500/30'
                    : 'bg-white/[0.03] text-fg-muted ring-line hover:text-fg'
                )}
              >
                {tag}
              </button>
            );
          })}
          {tagFilter.length ? (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              className="ml-1 text-[0.6875rem] text-fg-subtle transition hover:text-fg"
            >
              clear
            </button>
          ) : null}
        </div>
      ) : null}

      <Card>
        {loading ? (
          <SkeletonRows rows={6} columns={5} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={list.length === 0 ? 'No engagements yet' : 'Nothing matches those filters'}
            description={
              list.length === 0
                ? 'An engagement is the container for one assessment: its findings, its scope, and the template its report is built from.'
                : 'Try a different search term or switch back to All.'
            }
            actionLabel={list.length === 0 && canWrite ? 'New engagement' : undefined}
            actionIcon={Plus}
            onAction={list.length === 0 && canWrite ? () => setCreating(true) : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH width="2.5rem" />
              <TH>Engagement</TH>
              <TH>Findings</TH>
              <TH>Team</TH>
              <TH>Status</TH>
              <TH align="right">Updated</TH>
              <TH width="5rem" />
            </THead>
            <TBody>
              {filtered.map((audit) => (
                <TR
                  key={audit._id}
                  className="group"
                  onClick={() => navigate(`/engagements/${audit._id}`)}
                >
                  <TD>
                    {/* Always rendered, so the column never jumps: faint until it is
                        either pinned or hovered. */}
                    <button
                      type="button"
                      title={audit.pinned ? 'Unpin from the top of your list' : 'Pin to the top of your list'}
                      aria-label={audit.pinned ? `Unpin ${audit.name}` : `Pin ${audit.name}`}
                      aria-pressed={Boolean(audit.pinned)}
                      disabled={pinning === audit._id}
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePin(audit);
                      }}
                      className={cn(
                        'rounded-md p-1 transition',
                        audit.pinned
                          ? 'text-brand-300 hover:bg-white/5'
                          : 'text-fg-subtle opacity-0 hover:bg-white/5 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100'
                      )}
                    >
                      <Pin size={14} className={audit.pinned ? 'fill-current' : undefined} />
                    </button>
                  </TD>
                  <TD className="max-w-md">
                    <Link
                      to={`/engagements/${audit._id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="block truncate text-sm font-medium text-fg hover:text-brand-300"
                    >
                      {audit.name}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 truncate text-xs text-fg-muted">
                      {audit.reference ? <span>{audit.reference}</span> : null}
                      {audit.reference && audit.company?.name ? <span>·</span> : null}
                      {/* The client name goes to the client, not into the engagement:
                          "what else have we done for them" is one click from here. */}
                      {audit.company?._id ? (
                        <Link
                          to={`/clients/${audit.company._id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="truncate transition hover:text-brand-300"
                        >
                          {audit.company.name}
                        </Link>
                      ) : null}
                      {audit.auditType ? (
                        <>
                          <span>·</span>
                          <span className="truncate">{audit.auditType}</span>
                        </>
                      ) : null}
                      {!audit.reference && !audit.company?.name && !audit.auditType ? '—' : null}
                    </p>
                    <HealthChips health={audit.health} state={audit.state} />
                  </TD>
                  <TD className="w-56">
                    {audit.findingCount ? (
                      <div className="flex flex-col gap-1.5">
                        <SeverityBar counts={audit.severityCounts} total={audit.findingCount} />
                        <SeverityLegend counts={audit.severityCounts} className="gap-x-2.5" />
                      </div>
                    ) : (
                      <span className="text-xs text-fg-subtle">None yet</span>
                    )}
                  </TD>
                  <TD>
                    <AvatarGroup users={audit.collaborators ?? []} />
                  </TD>
                  <TD>
                    <StateBadge state={audit.state} />
                    {/*
                      Beside the state rather than replacing it: being stood down is a different
                      axis from where the report has got to, and an engagement can be both in
                      review and stopped.
                    */}
                    {(audit.tags ?? []).slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="ml-1.5 rounded bg-white/[0.05] px-1.5 py-0.5 text-[0.625rem] text-fg-subtle"
                      >
                        {tag}
                      </span>
                    ))}
                    {audit.onHold ? (
                      <Badge
                        tone="danger"
                        icon={OctagonPause}
                        className="ml-1.5"
                        title={
                          (audit.holds ?? []).filter((hold) => !hold.endedAt).pop()?.reason ??
                          'Work has stopped'
                        }
                      >
                        stopped
                      </Badge>
                    ) : null}
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                    {timeAgo(audit.updatedAt)}
                  </TD>
                  <TD align="right">
                    <span className="flex items-center justify-end gap-1">
                      {/* Anybody who can write may copy one: a duplicate takes nothing away
                          from the original, unlike deleting it. */}
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Copy}
                          title="Duplicate this engagement"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDuplicating(audit);
                          }}
                        />
                      ) : null}
                      {canWrite && canDelete(audit) ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Delete engagement"
                          className="hover:text-crit"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(audit);
                          }}
                        />
                      ) : null}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <DuplicateEngagementModal
        open={Boolean(duplicating)}
        audit={duplicating}
        onClose={() => setDuplicating(null)}
        onCreated={(created) => {
          setDuplicating(null);
          navigate(`/engagements/${created._id}`);
        }}
      />

      <CreateEngagementModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(audit) => {
          setCreating(false);
          navigate(`/engagements/${audit._id}`);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Move this engagement to the trash?"
        confirmLabel="Move to trash"
        message={`"${pendingDelete?.name}" will disappear from this list, but nothing is destroyed yet — you can restore it from the trash until the retention window runs out.`}
      />

      <TrashDialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={() => reload({ quiet: true })}
      />
    </div>
  );
}
