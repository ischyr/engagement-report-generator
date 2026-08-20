import { useState } from 'react';
import { ArrowRightLeft, CheckCheck, Hash, Trash2, X } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { COMPLEXITY_LABELS, PRIORITY_LABELS } from '../../lib/utils.js';

import { Button } from '../ui/Button.jsx';
import { Select, Input, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';

/**
 * One action, applied to everything ticked.
 *
 * A forty-finding internal ends with somebody re-scoping every Medium to Low because the client has
 * a compensating control, or marking eleven things retested after a fix window. Both were forty
 * dialogs, which is why neither got done and the report went out with the severities from the first
 * afternoon.
 *
 * Only the scalar fields are here — severity, status, category, priority, complexity — plus moving,
 * deleting and renumbering. Never prose: bulk-editing a description would need a version per
 * finding and would be a worse feature than doing it one at a time. Because nothing here touches
 * text, a colleague retyping one of these descriptions cannot lose a word to a batch re-scoping.
 *
 * The bar reports what it *could not* do as carefully as what it did. A finding somebody else has
 * locked is skipped by the server rather than failing the batch, and saying "6 changed, 2 were
 * locked by Ana" is the difference between a feature people trust and one they work around.
 */

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'None'];

export default function BulkFindingBar({ audit, ids, onClear, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState('move');
  const [target, setTarget] = useState('');
  const [pendingDelete, setPendingDelete] = useState(false);

  /*
   * Only fetched when a move is actually being set up: most selections never open that dialog.
   * `/audits` scopes itself to the engagements this person is on, so the list is already right.
   */
  const others = useResource(dialog === 'transfer' ? '/audits' : null, { initial: [] });

  const count = ids.length;
  const many = `${count} finding${count === 1 ? '' : 's'}`;

  /** What came back, said in one line. The skipped half is the half people need. */
  const report = (result) => {
    const changed = result.changed?.length ?? 0;
    const locked = (result.skipped ?? []).filter((row) => row.reason === 'locked');
    const unchanged = (result.skipped ?? []).filter((row) => row.reason === 'unchanged');
    const missing = (result.skipped ?? []).filter((row) => row.reason === 'missing');

    const notes = [
      locked.length
        ? `${locked.length} skipped — held by ${[...new Set(locked.map((row) => row.by || 'somebody'))].join(', ')}`
        : null,
      unchanged.length ? `${unchanged.length} already were` : null,
      missing.length ? `${missing.length} no longer here` : null,
    ].filter(Boolean);

    if (!changed && notes.length) toast.info('Nothing changed', notes.join(' · '));
    else if (locked.length) toast.warning(`${changed} changed`, notes.join(' · '));
    else toast.success(`${changed} changed`, notes.join(' · ') || undefined);
  };

  const run = async (body, label) => {
    setBusy(label);
    try {
      const result = await api.post(`/audits/${audit._id}/findings/bulk`, { ids, ...body });
      report(result);
      setDialog(null);
      setValue('');
      setReason('');
      /* Cleared only on success: a failed batch leaves the selection so it can be retried. */
      onClear?.();
      await onDone?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
      setPendingDelete(false);
    }
  };

  const renumber = async () => {
    setBusy('renumber');
    try {
      const result = await api.post(`/audits/${audit._id}/findings/renumber`, {});
      toast.success(
        result.renumbered ? `${result.renumbered} renumbered` : 'Already in order',
        `VULN-01 to VULN-${String(result.total).padStart(2, '0')}, in the order shown.`
      );
      await onDone?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {/*
        Fixed to the bottom rather than in the list. A bar that scrolls away is a bar you tick
        forty things and then cannot find, and the selection is meant to survive scrolling.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur">
          <span className="mr-1 text-xs text-fg">
            <span className="font-mono text-sm">{count}</span> selected
          </span>

          <Button size="sm" variant="ghost" onClick={() => setDialog('severity')}>
            Severity
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog('status')}>
            Status
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog('field')}>
            Category…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={ArrowRightLeft}
            onClick={() => setDialog('transfer')}
          >
            Move
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Hash}
            loading={busy === 'renumber'}
            title="Renumber every finding so VULN-01 upwards matches the order shown"
            onClick={renumber}
          >
            Renumber
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            className="hover:text-crit"
            onClick={() => setPendingDelete(true)}
          >
            Delete
          </Button>

          <span className="mx-1 h-5 w-px bg-line-soft" />
          <Button size="icon-sm" variant="ghost" icon={X} title="Clear the selection" onClick={onClear} />
        </div>
      </div>

      {/* ------------------------------------------------------------- severity -- */}
      <Modal
        open={dialog === 'severity'}
        onClose={() => setDialog(null)}
        title={`Re-score ${many}`}
        description="This is an override: the CVSS vectors are untouched, and each finding will print the reason beside its score. Clearing it puts every one of them back on what its vector says."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'severity'}
              disabled={!value || (value !== 'clear' && !reason.trim())}
              onClick={() =>
                run(
                  {
                    action: 'severity',
                    value: value === 'clear' ? '' : value,
                    ...(value === 'clear' ? {} : { reason: reason.trim() }),
                  },
                  'severity'
                )
              }
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select
            label="Severity"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            options={[
              { value: '', label: 'Pick one' },
              ...SEVERITIES.map((entry) => ({ value: entry, label: entry })),
              { value: 'clear', label: 'Clear the override — use the score' },
            ]}
          />
          {value && value !== 'clear' ? (
            <Textarea
              label="Why"
              required
              rows={2}
              placeholder="Compensating control agreed with the client at the kickoff."
              hint="One sentence about all of them, which is what a batch re-score actually is. It prints beside each score."
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          ) : null}
        </div>
      </Modal>

      {/* --------------------------------------------------------------- status -- */}
      <Modal
        open={dialog === 'status'}
        onClose={() => setDialog(null)}
        title={`Set the status on ${many}`}
        description="Where each one stands in the remediation cycle. Every change is appended to that finding's own history, so a retest can say when it was marked and by whom."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'status'}
              disabled={!value}
              onClick={() => run({ action: 'status', value }, 'status')}
            >
              Apply
            </Button>
          </>
        }
      >
        <Select
          label="Status"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          options={[
            { value: '', label: 'Pick one' },
            { value: 'open', label: 'Not fixed' },
            { value: 'retesting', label: 'Retesting' },
            { value: 'fixed', label: 'Fixed' },
          ]}
        />
      </Modal>

      {/* ------------------------------------------- category, type, priority --- */}
      <Modal
        open={dialog === 'field'}
        onClose={() => setDialog(null)}
        title={`One field, on ${many}`}
        description="The tidying-up nobody does one at a time: a category typed three ways, a priority nobody set."
        size="sm"
        footer={
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <FieldRow
            label="Category"
            hint="Groups the findings in most report templates."
            busy={busy === 'category'}
            onApply={(next) => run({ action: 'category', value: next }, 'category')}
          />
          <FieldRow
            label="Type of vulnerability"
            hint="What it is, as the library and the taxonomy name it."
            busy={busy === 'vulnType'}
            onApply={(next) => run({ action: 'vulnType', value: next }, 'vulnType')}
          />
          <PickRow
            label="Priority"
            busy={busy === 'priority'}
            options={PRIORITY_LABELS}
            onApply={(next) => run({ action: 'priority', value: next }, 'priority')}
          />
          <PickRow
            label="Remediation complexity"
            busy={busy === 'complexity'}
            options={COMPLEXITY_LABELS}
            onApply={(next) => run({ action: 'complexity', value: next }, 'complexity')}
          />
        </div>
      </Modal>

      {/* ------------------------------------------------------------- transfer -- */}
      <Modal
        open={dialog === 'transfer'}
        onClose={() => setDialog(null)}
        title={`${mode === 'copy' ? 'Copy' : 'Move'} ${many}`}
        description="Each one gets a new number on the engagement it lands on. Review comments stay behind — they were a conversation about this report."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'transfer'}
              disabled={!target}
              onClick={() => run({ action: 'transfer', target, mode }, 'transfer')}
            >
              {mode === 'copy' ? 'Copy them' : 'Move them'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select
            label="Which engagement"
            autoFocus
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            options={[
              { value: '', label: others.loading ? 'Loading…' : 'Pick one' },
              ...(Array.isArray(others.data) ? others.data : [])
                .filter((row) => String(row._id) !== String(audit._id))
                /* An approved engagement is frozen; the server would refuse anyway. */
                .filter((row) => row.state !== 'APPROVED')
                .map((row) => ({
                  value: row._id,
                  label: [row.reference, row.name].filter(Boolean).join(' — '),
                })),
            ]}
          />
          <Select
            label="Move or copy"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            options={[
              { value: 'move', label: 'Move — they leave this engagement' },
              { value: 'copy', label: 'Copy — they stay here as well' },
            ]}
            hint="A copy to a different client leaves the screenshots behind. The bar will say how many."
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete}
        onClose={() => setPendingDelete(false)}
        onConfirm={() => run({ action: 'delete' }, 'delete')}
        loading={busy === 'delete'}
        title={`Delete ${many}?`}
        confirmLabel="Delete them"
        message="They go to the same trash a single delete uses, so any of them can be put back. Anything somebody else has locked is left alone."
      />
    </>
  );
}

/** A text field with its own Apply, so one dialog can offer four unrelated changes. */
function FieldRow({ label, hint, busy, onApply }) {
  const [text, setText] = useState('');
  return (
    <div className="flex items-end gap-2">
      <Input
        label={label}
        hint={hint}
        wrapperClassName="flex-1"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="sm" variant="secondary" icon={CheckCheck} loading={busy} onClick={() => onApply(text)}>
        Set
      </Button>
    </div>
  );
}

/** The same, for the two fields that are a number with names. */
function PickRow({ label, options, busy, onApply }) {
  const [picked, setPicked] = useState('');
  return (
    <div className="flex items-end gap-2">
      <Select
        label={label}
        wrapperClassName="flex-1"
        value={picked}
        onChange={(event) => setPicked(event.target.value)}
        options={[
          { value: '', label: 'Leave it' },
          ...Object.entries(options).map(([value, name]) => ({ value, label: name })),
          { value: 'clear', label: 'Clear it' },
        ]}
      />
      <Button
        size="sm"
        variant="secondary"
        icon={CheckCheck}
        loading={busy}
        disabled={!picked}
        onClick={() => onApply(picked === 'clear' ? null : Number(picked))}
      >
        Set
      </Button>
    </div>
  );
}
