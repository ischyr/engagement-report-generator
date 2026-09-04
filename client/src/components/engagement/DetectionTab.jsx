import { useState } from 'react';
import { Clock, Info, Plus, Radar, ShieldAlert, Trash2, Volume2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Stat } from '../ui/Misc.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

/**
 * Red is their failure, not ours.
 *
 * Worth stating, because the instinct is the other way round: an undetected action is a good
 * afternoon for the operator. But this table ends up in front of the client, and the colour has
 * to mean what it means to them.
 */
const OUTCOME_TONE = {
  'not-detected': 'danger',
  logged: 'warning',
  alerted: 'success',
  blocked: 'success',
  contacted: 'success',
  unknown: 'neutral',
};

const NOISE_TONE = { quiet: 'neutral', standard: 'neutral', loud: 'info' };

/** `datetime-local` speaks the operator's wall clock; the API speaks ISO. */
const toLocalInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
};

const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

const BLANK = {
  action: '',
  target: '',
  technique: '',
  occurredAt: '',
  outcome: 'unknown',
  noise: 'standard',
  detectedAt: '',
  respondedAt: '',
  source: '',
  notes: '',
  finding: '',
};

/**
 * What we did, and whether their side ever noticed.
 *
 * The findings list says what is broken. It cannot say whether anybody *saw* the testing, which
 * is a separate and usually more uncomfortable answer — and the one thing a client's own security
 * team can act on this week. Teams already keep this, in a spreadsheet or in the notes tab as a
 * list of times, and then retype it into the report on the last day.
 *
 * Logged as it happens, with a Now button, because a detection log filled in from memory a week
 * later is a set of guesses with minute precision.
 */
export default function DetectionTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/detections`, {
    initial: null,
  });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const events = data?.detections ?? [];
  const summary = data?.summary ?? null;
  const outcomes = data?.outcomes ?? [];
  const noiseLevels = data?.noiseLevels ?? [];
  const outcomeLabel = (value) =>
    outcomes.find((entry) => entry.value === value)?.label ?? value ?? '';
  const noiseLabel = (value) =>
    noiseLevels.find((entry) => entry.value === value)?.label ?? value ?? '';

  /** So a gap can be linked to the finding it became. */
  const findingOptions = (audit.findings ?? []).map((finding) => ({
    value: String(finding._id),
    label: `${finding.id ? `${finding.id} — ` : ''}${finding.title || 'Untitled finding'}`,
  }));

  const open = (event) => {
    if (event) {
      setForm({
        ...BLANK,
        ...event,
        occurredAt: toLocalInput(event.occurredAt),
        detectedAt: toLocalInput(event.detectedAt),
        respondedAt: toLocalInput(event.respondedAt),
        finding: event.finding ? String(event.finding) : '',
        _id: event._id,
      });
      return;
    }
    // Prefilled with now, because that is when the action happened in almost every case.
    setForm({ ...BLANK, occurredAt: toLocalInput(new Date()) });
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        action: form.action,
        target: form.target,
        technique: form.technique,
        occurredAt: fromLocalInput(form.occurredAt),
        outcome: form.outcome,
        noise: form.noise,
        // Cleared rather than omitted, so removing a time actually removes it.
        detectedAt: fromLocalInput(form.detectedAt),
        respondedAt: fromLocalInput(form.respondedAt),
        source: form.source,
        notes: form.notes,
        finding: form.finding || null,
      };
      if (form._id) await api.put(`/audits/${audit._id}/detections/${form._id}`, payload);
      else await api.post(`/audits/${audit._id}/detections`, payload);
      setForm(null);
      await reload({ quiet: true });
      toast.success(form._id ? 'Action updated' : 'Action logged');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/detections/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
        fallback: 'Removed from the log',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  /*
   * `not-detected` closes the question, so the two time fields would be a contradiction the
   * server refuses. Hidden rather than left to fail on save: the form should not offer a
   * combination it knows is invalid.
   */
  const timesApply = form && form.outcome !== 'not-detected';

  if (loading && !data) return <LoadingBlock label="Reading the detection log…" />;

  return (
    <div className="flex flex-col gap-4">
      {summary?.total ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Actions logged"
              value={summary.total}
              sub={
                summary.unconfirmed
                  ? `${summary.unconfirmed} still to confirm with the client`
                  : 'all outcomes confirmed'
              }
              icon={Radar}
            />
            <Stat
              label="Drew a response"
              value={`${summary.respondedPercent}%`}
              /* Of the confirmed rows — said out loud, because a percentage of an
                 unfinished log is a claim about the client made from our own paperwork. */
              sub={`${summary.responded} of ${summary.confirmed} confirmed`}
              tone={summary.respondedPercent >= 50 ? 'low' : 'crit'}
            />
            <Stat
              label="Median time to notice"
              value={summary.medianDetect || '—'}
              sub={summary.medianRespond ? `${summary.medianRespond} to respond` : 'no times recorded'}
              icon={Clock}
              tone="info"
            />
            <Stat
              label="Logged, no response"
              value={summary.loggedOnly}
              sub="their telemetry had it and nobody looked"
              tone={summary.loggedOnly ? 'med' : undefined}
            />
          </div>

          {/*
            The headline. Undetected quiet work is a normal result; undetected *loud* work is
            the finding, and it is the one sentence a client's security team acts on.
          */}
          {summary.loudMisses ? (
            <p className="flex items-start gap-2 rounded-lg border border-crit/25 bg-crit/[0.06] px-4 py-3 text-xs leading-relaxed text-fg-muted">
              <Volume2 size={15} className="mt-0.5 shrink-0 text-crit" />
              <span>
                <strong className="font-semibold text-fg">
                  {summary.loudMisses} of {summary.loudTotal} deliberately loud action
                  {summary.loudTotal === 1 ? '' : 's'} drew no response.
                </strong>{' '}
                These were not hidden. A report can say this plainly, and it is worth more to
                the client than the count of things nobody was meant to see.
              </span>
            </p>
          ) : summary.quietCatches ? (
            <p className="flex items-start gap-2 rounded-lg border border-low/25 bg-low/[0.06] px-4 py-3 text-xs leading-relaxed text-fg-muted">
              <Radar size={15} className="mt-0.5 shrink-0 text-low" />
              <span>
                They caught {summary.quietCatches} action{summary.quietCatches === 1 ? '' : 's'}{' '}
                that were meant to be quiet. Worth saying in the report — a detection section that
                only lists failures is not a fair one.
              </span>
            </p>
          ) : null}
        </>
      ) : null}

      <Card>
        <CardHeader
          icon={Radar}
          title="Detection"
          description="What the team did, and whether anybody on the client's side noticed. Log it as you go — the times are the whole point, and they cannot be reconstructed afterwards."
          actions={
            editable ? (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => open(null)}>
                Log an action
              </Button>
            ) : null
          }
        />

        {events.length === 0 ? (
          <EmptyState
            icon={Radar}
            title="Nothing logged yet"
            description="Record the things worth being caught for — a password spray, a dump, a beacon — and whether their monitoring said anything. It answers “were we seen”, which no finding can, and a template can print it as a timeline."
            actionLabel={editable ? 'Log an action' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => open(null) : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH width="11rem">When</TH>
              <TH>What we did</TH>
              <TH width="11rem">Their side</TH>
              <TH width="9rem">How long</TH>
              <TH width="5rem" />
            </THead>
            <TBody>
              {events.map((event) => (
                <TR key={event._id}>
                  <TD className="whitespace-nowrap">
                    <span className="block text-xs text-fg-muted">
                      {formatDateTime(event.occurredAt)}
                    </span>
                    {event.noise !== 'standard' ? (
                      <Badge tone={NOISE_TONE[event.noise] ?? 'neutral'} className="mt-0.5">
                        {noiseLabel(event.noise)}
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="max-w-md">
                    <span className="block text-xs text-fg">{event.action}</span>
                    {event.target || event.technique ? (
                      <span className="mt-0.5 block truncate font-mono text-[0.625rem] text-fg-subtle">
                        {[event.technique, event.target].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                    {event.notes ? (
                      <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                        {event.notes}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone={OUTCOME_TONE[event.outcome] ?? 'neutral'}>
                      {outcomeLabel(event.outcome)}
                    </Badge>
                    {event.source ? (
                      <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                        {event.source}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    {event.detectionLatency ? (
                      <span className="block">{event.detectionLatency} to notice</span>
                    ) : (
                      <span className="block text-fg-subtle">—</span>
                    )}
                    {event.responseLatency ? (
                      <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                        {event.responseLatency} to respond
                      </span>
                    ) : null}
                  </TD>
                  <TD align="right">
                    {editable ? (
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Info}
                          title="Edit this entry"
                          onClick={() => open(event)}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Remove this entry"
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(event)}
                        />
                      </span>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/*
        Grouped by whatever the team called the technique. A team that is consistent gets a
        coverage table out of it; a team that is not still gets its timeline above, which is
        why the field was never made a dropdown.
      */}
      {summary?.techniques?.length > 1 ? (
        <Card>
          <CardHeader
            icon={ShieldAlert}
            title="By technique"
            description="Where their monitoring holds and where it does not. Percentages are of the outcomes actually confirmed."
          />
          <CardBody className="flex flex-col gap-1.5">
            {summary.techniques.map((group) => (
              <div
                key={group.technique}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-fg">{group.technique}</span>
                <span className="text-[0.625rem] text-fg-subtle">
                  {group.total} action{group.total === 1 ? '' : 's'}
                  {group.unconfirmed ? `, ${group.unconfirmed} unconfirmed` : ''}
                </span>
                {/*
                  Nothing confirmed means there is no rate to draw, and an empty red bar reading
                  0% would accuse the client of a failure we have not established.
                */}
                {group.rated ? (
                  <>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/6">
                      <span
                        className={
                          group.respondedPercent >= 50
                            ? 'block h-full rounded-full bg-low'
                            : 'block h-full rounded-full bg-crit'
                        }
                        style={{ width: `${group.respondedPercent}%` }}
                      />
                    </span>
                    <Badge tone={group.respondedPercent >= 50 ? 'success' : 'danger'}>
                      {group.respondedPercent}% answered
                    </Badge>
                  </>
                ) : (
                  <Badge tone="neutral">not confirmed yet</Badge>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?._id ? 'Edit a logged action' : 'Log an action'}
        description="When you did it, and what happened on their side. Leave the outcome as “not confirmed” until you have actually asked."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!form?.action?.trim() || !form?.occurredAt}
              onClick={save}
            >
              {form?._id ? 'Save' : 'Log it'}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Textarea
              label="What you did"
              required
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="Password spray against the VPN portal, 400 attempts across 90 accounts."
              value={form.action}
              onChange={(event) => setForm({ ...form, action: event.target.value })}
            />
            <Input
              label="Against what"
              placeholder="vpn.acme.example, WS-014, the service account"
              value={form.target}
              onChange={(event) => setForm({ ...form, target: event.target.value })}
            />
            <Input
              label="Technique"
              hint="However your team refers to it — an ATT&CK id, a name, both. Matching entries are grouped."
              placeholder="T1110.003 — Password spraying"
              value={form.technique}
              onChange={(event) => setForm({ ...form, technique: event.target.value })}
            />

            <Input
              label="When"
              type="datetime-local"
              required
              /* A Now button because this gets filled in mid-action, and typing a
                 timestamp is exactly the friction that leaves the log empty. */
              actions={
                <button
                  type="button"
                  className="text-[0.6875rem] font-medium text-brand-300 transition hover:text-brand-200"
                  onClick={() => setForm({ ...form, occurredAt: toLocalInput(new Date()) })}
                >
                  now
                </button>
              }
              value={form.occurredAt}
              onChange={(event) => setForm({ ...form, occurredAt: event.target.value })}
            />
            <Select
              label="How loud was it meant to be"
              hint="The claim only means something with this next to it: loud and unnoticed is a finding, quiet and unnoticed is a Tuesday."
              value={form.noise}
              options={noiseLevels}
              onChange={(event) => setForm({ ...form, noise: event.target.value })}
            />

            <Select
              label="What happened on their side"
              wrapperClassName="sm:col-span-2"
              value={form.outcome}
              options={outcomes}
              onChange={(event) =>
                setForm({
                  ...form,
                  outcome: event.target.value,
                  // Switching to "not detected" clears the times it contradicts, rather
                  // than keeping them hidden and failing on save.
                  ...(event.target.value === 'not-detected'
                    ? { detectedAt: '', respondedAt: '' }
                    : {}),
                })
              }
            />

            {timesApply ? (
              <>
                <Input
                  label="When they noticed"
                  type="datetime-local"
                  hint="Leave empty if you know they saw it but not when."
                  value={form.detectedAt}
                  onChange={(event) => setForm({ ...form, detectedAt: event.target.value })}
                />
                <Input
                  label="When somebody acted"
                  type="datetime-local"
                  hint="Separate on purpose — an alert nobody triages for three days is a different problem."
                  value={form.respondedAt}
                  onChange={(event) => setForm({ ...form, respondedAt: event.target.value })}
                />
              </>
            ) : null}

            <Input
              label="How you know"
              placeholder="Their SOC called, EDR console, confirmed on the closeout call"
              value={form.source}
              onChange={(event) => setForm({ ...form, source: event.target.value })}
            />
            {findingOptions.length ? (
              <Select
                label="Written up as"
                hint="Optional. Link the gap to the finding it became."
                value={form.finding}
                onChange={(event) => setForm({ ...form, finding: event.target.value })}
                options={[{ value: '', label: 'Not written up' }, ...findingOptions]}
              />
            ) : null}
            <Textarea
              label="Notes"
              rows={2}
              wrapperClassName="sm:col-span-2"
              placeholder="Anything the next tester should know — which control fired, what the alert said, who was on shift."
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this entry?"
        message={`"${pendingDelete?.action}" leaves the timeline, and the detection figures are recalculated without it.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
