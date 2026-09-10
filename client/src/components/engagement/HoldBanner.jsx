import { useState } from 'react';
import { OctagonPause, Play } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Button } from '../ui/Button.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Textarea } from '../ui/Field.jsx';

/**
 * Work on this engagement has stopped.
 *
 * Loud, above everything, on every tab — because the failure it prevents is somebody opening the
 * engagement on Monday and carrying on. It deliberately locks nothing: standing down means stop
 * *testing*, and writing up what you already did is usually the next thing asked for.
 */
export default function HoldBanner({ audit, editable, onReload }) {
  const toast = useToast();
  const [resuming, setResuming] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const hold = (audit.holds ?? []).filter((entry) => !entry.endedAt).pop();
  if (!hold) return null;

  const resume = async () => {
    setSaving(true);
    try {
      const result = await api.del(`/audits/${audit._id}/hold`, {
        body: { resumeNote: note },
      });
      setResuming(false);
      setNote('');
      await onReload?.();
      toast.success(
        'Work has restarted',
        result.notified
          ? `${result.notified} person(s) told.`
          : 'Nobody else needed telling.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-start gap-3 rounded-card border border-crit/40 bg-crit/[0.08] px-5 py-4">
        <OctagonPause size={20} className="mt-0.5 shrink-0 text-crit" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">Work on this engagement has stopped.</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">{hold.reason}</p>
          <p className="mt-1.5 text-[0.625rem] text-fg-subtle">
            Stopped by {displayName(hold.startedBy) || 'somebody'}{' '}
            <span title={formatDateTime(hold.startedAt)}>{timeAgo(hold.startedAt)}</span>. Nothing
            is locked — writing up what you already did is fine. Do not test anything further.
          </p>
        </div>
        {editable ? (
          <Button variant="secondary" size="sm" icon={Play} onClick={() => setResuming(true)}>
            Start again
          </Button>
        ) : null}
      </div>

      <Modal
        open={resuming}
        onClose={() => setResuming(false)}
        title="Start work again?"
        description="Everybody who was told to stop will be told it has restarted."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResuming(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={resume}>
              Start again
            </Button>
          </>
        }
      >
        <Textarea
          label="What changed"
          rows={3}
          hint="Optional, and worth writing: the reason it stopped is recorded, so the reason it restarted should be too."
          placeholder="Client confirmed the outage was unrelated — cleared to continue from Tuesday."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal>
    </>
  );
}

/** The button that stops it, kept beside the banner so the two words match. */
export function HoldButton({ audit, onReload }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const stop = async () => {
    setSaving(true);
    try {
      const result = await api.post(`/audits/${audit._id}/hold`, { reason });
      setOpen(false);
      setReason('');
      await onReload?.();
      toast.success(
        'Work stopped',
        result.notified
          ? `${result.notified} person(s) told, including anybody booked onto it.`
          : 'Nobody else was booked onto it.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        icon={OctagonPause}
        title="The client rang — stop testing"
        onClick={() => setOpen(true)}
      >
        Stop work
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Stop work on this engagement?"
        description="Everybody working on it, and anybody booked onto it, is told straight away."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={saving}
              disabled={!reason.trim()}
              onClick={stop}
            >
              Stop work
            </Button>
          </>
        }
      >
        <Textarea
          label="Why"
          required
          rows={3}
          autoFocus
          /* Required, because "stopped" without a reason is a mystery to whoever finds it on
             Monday — and this is exactly the record somebody asks about weeks later. */
          hint="Goes to everybody who is told, and into the engagement's log."
          placeholder="Client reported an unrelated outage and asked us to pause until they confirm."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="mt-3 rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-2.5 text-[0.6875rem] leading-relaxed text-fg-subtle">
          Nothing is locked. Stopping means stop testing — writing up what has already been done
          is usually the next thing asked for, and an app that froze the engagement would push
          that into a text file.
        </p>
      </Modal>
    </>
  );
}
