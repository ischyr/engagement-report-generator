import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  CheckCircle2,
  MapPin,
  PackageSearch,
  Plus,
  TriangleAlert,
  Trash2,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Stat } from '../ui/Misc.jsx';

const KIND_LABELS = {
  hardware: 'Hardware',
  connectivity: 'Connectivity',
  access: 'Access',
  consumable: 'Consumable',
  other: 'Other',
};

/**
 * The status ladder wears the status palette, and only the two bad ends wear a colour.
 *
 * "Needed" is a normal state on a list somebody is still writing, so colouring it would make a
 * fresh engagement look like a problem.
 */
const STATUS_META = {
  needed: { label: 'Needed', tone: 'neutral' },
  requested: { label: 'Asked for', tone: 'neutral' },
  ready: { label: 'Ready to go', tone: 'brand' },
  out: { label: 'Out with us', tone: 'info' },
  returned: { label: 'Back', tone: 'success' },
  missing: { label: 'Not come back', tone: 'danger' },
};

const BLANK = {
  label: '',
  kind: 'hardware',
  assetTag: '',
  status: 'needed',
  quantity: 1,
  heldBy: '',
  neededBy: '',
  dueBack: '',
  note: '',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * What this engagement needs, and where it got to.
 *
 * The drop box, the loaner laptop, the SIM, the site badge. Two failures worth preventing: turning
 * up on site without the thing, and finishing the job without getting it back — which is why
 * "not come back" is a state rather than something inferred from silence.
 */
export default function KitTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/kit`, { initial: null });
  const people = useResource('/users?active=true', { initial: [] });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState('');
  const [lookup, setLookup] = useState(null);

  const items = data?.items ?? [];
  const summary = data?.summary ?? null;
  const clashes = data?.clashes ?? [];
  const today = todayIso();

  const team = [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]
    .filter(Boolean)
    .filter((person, index, all) => all.findIndex((p) => String(p._id) === String(person._id)) === index);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        label: form.label,
        kind: form.kind,
        assetTag: form.assetTag,
        status: form.status,
        quantity: Number(form.quantity) || 1,
        heldBy: form.heldBy || null,
        neededBy: form.neededBy,
        dueBack: form.dueBack,
        note: form.note,
      };
      if (form._id) await api.put(`/audits/${audit._id}/kit/${form._id}`, payload);
      else await api.post(`/audits/${audit._id}/kit`, { items: [payload] });
      setForm(null);
      await reload({ quiet: true });
      toast.success(form._id ? 'Updated' : 'Added to the list');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  /** The suggested list, in one go — a starting point rather than a menu to read. */
  const addSuggested = async () => {
    setBusy('suggestions');
    try {
      const existing = new Set(items.map((item) => item.label.toLowerCase()));
      const wanted = (data?.suggestions ?? []).filter(
        (entry) => !existing.has(entry.label.toLowerCase())
      );
      if (!wanted.length) {
        toast.info('Nothing to add', 'The suggested items are all on the list already.');
        return;
      }
      await api.post(`/audits/${audit._id}/kit`, { items: wanted });
      await reload({ quiet: true });
      toast.success(`${wanted.length} item(s) added`, 'Edit or remove whatever you do not need.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (item, status) => {
    setBusy(String(item._id));
    try {
      await api.put(`/audits/${audit._id}/kit/${item._id}`, { status });
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/kit/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Removed from the list',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  /** Where a tagged item is, across everything you can see. */
  const findTag = async (tag) => {
    setBusy(`tag:${tag}`);
    try {
      const result = await api.get(
        `/audits/${audit._id}/kit-where/${encodeURIComponent(tag)}`
      );
      setLookup(result);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading the kit list…" />;

  return (
    <div className="flex flex-col gap-4">
      {summary?.total ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="On the list" value={summary.total} sub={`${summary.out} out with us`} icon={Boxes} />
          <Stat
            label="Still to sort out"
            value={summary.outstanding}
            sub={summary.notReadyAndStarted ? 'and testing has started' : 'needed or asked for'}
            tone={summary.notReadyAndStarted ? 'crit' : summary.outstanding ? 'med' : undefined}
          />
          <Stat
            label="Past due back"
            value={summary.overdue}
            sub="should be back by now"
            tone={summary.overdue ? 'med' : undefined}
          />
          <Stat
            label="Not come back"
            value={summary.missing}
            sub="somebody needs to find these"
            tone={summary.missing ? 'crit' : undefined}
          />
        </div>
      ) : null}

      {/*
        The double-booking. Only possible to spot because a tag names a specific object rather
        than a kind of thing, and it is the one that leaves somebody on site without a box.
      */}
      {clashes.length ? (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-med/25 bg-med/[0.06] px-4 py-3">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-med" />
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
            <strong className="font-semibold text-fg">
              {clashes.length === 1 ? 'One tagged item is' : `${clashes.length} tagged items are`}{' '}
              also on another engagement.
            </strong>
            <ul className="mt-1 flex flex-col gap-0.5">
              {clashes.map((clash) => (
                <li key={`${clash.assetTag}-${clash.audit._id}`}>
                  <span className="font-mono text-[0.625rem] text-fg">{clash.assetTag}</span> —{' '}
                  {STATUS_META[clash.status]?.label.toLowerCase() ?? clash.status} on{' '}
                  <Link
                    to={`/engagements/${clash.audit._id}?tab=kit`}
                    className="text-brand-300 transition hover:text-brand-200"
                  >
                    {clash.audit.name}
                  </Link>
                  {clash.dueBack ? `, due back ${formatDate(clash.dueBack)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          icon={Boxes}
          title="Kit"
          description="What this engagement needs and where it got to — the drop box, the laptop, the SIM, the badge. Add whatever you need; it is your list."
          actions={
            editable ? (
              <div className="flex items-center gap-2">
                {items.length === 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === 'suggestions'}
                    onClick={addSuggested}
                  >
                    Add the usual
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  size="sm"
                  icon={Plus}
                  onClick={() => setForm({ ...BLANK })}
                >
                  Add an item
                </Button>
              </div>
            ) : null
          }
        />

        {items.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="Nothing on the list"
            description="Add the things this job needs. The two failures worth preventing are turning up without something and finishing without getting it back — both start with writing it down."
            actionLabel={editable ? 'Add an item' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => setForm({ ...BLANK }) : undefined}
          />
        ) : (
          <CardBody className="flex flex-col gap-1.5">
            {items.map((item) => {
              const meta = STATUS_META[item.status] ?? STATUS_META.needed;
              const overdue = item.dueBack && item.dueBack < today && item.status !== 'returned';
              return (
                <div
                  key={item._id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-lg border bg-canvas/40 px-3 py-2.5',
                    item.status === 'missing'
                      ? 'border-crit/30'
                      : overdue
                        ? 'border-med/25'
                        : 'border-line-soft'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">
                        {item.quantity > 1 ? `${item.quantity} × ` : ''}
                        {item.label}
                      </span>
                      <Badge tone="neutral">{KIND_LABELS[item.kind] ?? item.kind}</Badge>
                      {item.assetTag ? (
                        <button
                          type="button"
                          title="Where else has this been?"
                          className="inline-flex items-center gap-1 rounded bg-canvas/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-fg-muted ring-1 ring-line transition hover:text-fg"
                          onClick={() => findTag(item.assetTag)}
                        >
                          <MapPin size={9} />
                          {item.assetTag}
                        </button>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-fg-muted">
                      {[
                        item.heldBy ? `with ${displayName(item.heldBy)}` : '',
                        item.neededBy ? `needed by ${formatDate(item.neededBy)}` : '',
                        item.dueBack ? `back by ${formatDate(item.dueBack)}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'nobody has it yet'}
                    </span>
                    {item.note ? (
                      <span className="mt-0.5 block text-[0.625rem] leading-relaxed text-fg-subtle">
                        {item.note}
                      </span>
                    ) : null}
                  </span>

                  {overdue && item.status !== 'missing' ? (
                    <Badge tone="warning">overdue</Badge>
                  ) : null}
                  <Badge tone={meta.tone}>{meta.label}</Badge>

                  {editable ? (
                    <>
                      {/* The two moves that actually happen, one click each. */}
                      {item.status === 'out' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy === String(item._id)}
                          onClick={() => setStatus(item, 'returned')}
                        >
                          Got it back
                        </Button>
                      ) : item.status !== 'returned' && item.status !== 'missing' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy === String(item._id)}
                          onClick={() => setStatus(item, 'out')}
                        >
                          Taking it
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={PackageSearch}
                        title="Edit this item"
                        onClick={() => setForm({ ...BLANK, ...item, heldBy: item.heldBy?._id ?? '' })}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Remove it from the list"
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(item)}
                      />
                    </>
                  ) : null}
                </div>
              );
            })}
          </CardBody>
        )}

        {summary?.settled && items.length ? (
          <CardBody className="flex items-center gap-2.5 border-t border-line-soft text-sm text-low">
            <CheckCircle2 size={16} />
            Nothing outstanding, nothing overdue, nothing lost.
          </CardBody>
        ) : null}
      </Card>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?._id ? 'Edit this item' : 'Add an item'}
        description="Whatever this job needs. A tag is worth adding for a specific object — it is what lets the app tell you the same box is out somewhere else."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.label?.trim()}
              onClick={save}
            >
              {form?._id ? 'Save' : 'Add it'}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="What is it"
              required
              placeholder="Drop box, loaner laptop, site badge…"
              wrapperClassName="sm:col-span-2"
              value={form.label}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
            />
            <Select
              label="Kind"
              value={form.kind}
              options={(data?.kinds ?? []).map((kind) => ({
                value: kind,
                label: KIND_LABELS[kind] ?? kind,
              }))}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            />
            <Select
              label="Where it has got to"
              value={form.status}
              options={(data?.statuses ?? []).map((status) => ({
                value: status,
                label: STATUS_META[status]?.label ?? status,
              }))}
              onChange={(event) => setForm({ ...form, status: event.target.value })}
            />
            <Input
              label="Asset tag"
              placeholder="DB-02"
              hint="Your own label for a specific object. Optional, and what makes a double-booking findable."
              value={form.assetTag}
              onChange={(event) => setForm({ ...form, assetTag: event.target.value })}
            />
            <Input
              label="How many"
              type="number"
              min={1}
              value={form.quantity}
              onChange={(event) => setForm({ ...form, quantity: event.target.value })}
            />
            <Select
              label="Who has it"
              value={form.heldBy}
              onChange={(event) => setForm({ ...form, heldBy: event.target.value })}
              options={[
                { value: '', label: 'Nobody yet' },
                ...team.map((person) => ({
                  value: String(person._id),
                  label: displayName(person),
                })),
              ]}
            />
            <Input
              label="Needed by"
              type="date"
              value={form.neededBy}
              onChange={(event) => setForm({ ...form, neededBy: event.target.value })}
            />
            <Input
              label="Due back"
              type="date"
              hint="What makes something show as overdue rather than simply out."
              wrapperClassName="sm:col-span-2"
              value={form.dueBack}
              onChange={(event) => setForm({ ...form, dueBack: event.target.value })}
            />
            <Textarea
              label="Note"
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="Borrowed from the Manchester office — has to be back for their job on the 20th."
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(lookup)}
        onClose={() => setLookup(null)}
        title={`Where ${lookup?.tag ?? 'it'} has been`}
        description="Every engagement you can see that lists this tag."
        size="md"
        footer={
          <Button variant="primary" onClick={() => setLookup(null)}>
            Close
          </Button>
        }
      >
        {lookup?.seen?.length ? (
          <ul className="flex flex-col gap-1.5">
            {lookup.seen.map((row) => (
              <li
                key={row._id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
              >
                <Link
                  to={`/engagements/${row.audit._id}?tab=kit`}
                  className="min-w-0 flex-1 truncate text-xs text-fg transition hover:text-brand-300"
                >
                  {row.audit.name}
                </Link>
                {row.heldBy ? (
                  <span className="text-[0.625rem] text-fg-subtle">
                    {displayName(row.heldBy)}
                  </span>
                ) : null}
                <Badge tone={STATUS_META[row.status]?.tone ?? 'neutral'}>
                  {STATUS_META[row.status]?.label ?? row.status}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-subtle">
            Only this engagement lists that tag — or the others are on work you cannot see.
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this item?"
        message={`"${pendingDelete?.label}" comes off the list. If it is out with somebody, mark it back instead — removing the row does not return the thing.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
