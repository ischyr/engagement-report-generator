import { useState } from 'react';
import { Lock, LockOpen, ShieldAlert, Unlock } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Button } from '../ui/Button.jsx';
import { Avatar } from '../ui/Misc.jsx';

/**
 * Taking a finding, and saying so.
 *
 * The presence banner beside this says who else has the finding open. It is advisory on purpose, and
 * advisory covers most of a working day — but not the case that costs an hour: you are rewriting the
 * impact, somebody opens the finding, types a sentence, and the merge dialog they clicked through was
 * the only thing between your paragraph and nothing.
 *
 * So: an explicit lock. While you hold it, everybody else gets a read-only editor and the server
 * refuses their writes with a 423 — the enforcement is not here, because a lock a browser could
 * decline to honour is a suggestion with extra steps.
 *
 * Three things make a lock liveable rather than a nuisance, and all three are visible in this bar:
 * it names the holder, it lapses on its own once they stop being online, and a lead can always take
 * it. A team that cannot get past a lock works around the tool instead.
 *
 * @param {object} props
 * @param {object} props.lock The lock as the server describes it, or null.
 * @param {boolean} props.stale Whether the holder has gone quiet, so anybody may take it.
 */
export default function FindingLockBar({ auditId, finding, lock, editable, onChanged }) {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const holder = lock?.lockedBy ?? lock?.by ?? null;
  const heldByMe = holder && String(holder._id ?? holder.id) === String(user?.id);
  const isManager = isAdmin || user?.roles?.includes?.('manager');

  /*
   * Lapsed, judged the same way the server judges it: five minutes without a heartbeat. Shown rather
   * than hidden, because "Andrei locked this two hours ago and has gone home" is the only case where
   * taking somebody else's lock needs no conversation first.
   */
  const stale =
    holder && holder.lastSeenAt
      ? Date.now() - new Date(holder.lastSeenAt).getTime() > 5 * 60 * 1000
      : Boolean(holder);

  const act = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const take = (force = false) =>
    act(
      () => api.post(`/audits/${auditId}/findings/${finding._id}/lock`, { note, force }),
      force ? 'Lock taken over' : 'Locked — nobody else can save this now'
    );
  const release = () =>
    act(() => api.del(`/audits/${auditId}/findings/${finding._id}/lock`), 'Unlocked');

  if (!finding?._id) return null;

  /* ------------------------------------------------------------------ nobody holds it ---- */
  if (!holder) {
    if (!editable) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs ring-1 ring-line">
        <LockOpen size={14} className="shrink-0 text-fg-subtle" />
        <span className="text-fg-muted">
          Anyone can edit this finding. Lock it while you rewrite something, so nobody saves over you.
        </span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional: what you are doing"
          className="min-w-0 flex-1 rounded bg-canvas/60 px-2 py-1 text-xs text-fg ring-1 ring-line placeholder:text-fg-subtle focus:ring-2 focus:ring-brand-500 focus:outline-none sm:max-w-64"
        />
        <Button variant="secondary" size="sm" icon={Lock} loading={busy} onClick={() => take(false)}>
          Lock for editing
        </Button>
      </div>
    );
  }

  /* --------------------------------------------------------------------- I hold it ---- */
  if (heldByMe) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-low/10 px-3 py-2 text-xs ring-1 ring-low/25">
        <Lock size={14} className="shrink-0 text-low" />
        <span className="text-fg">
          <span className="font-medium">You have this finding locked</span>
          {lock?.lockedAt ? <span className="text-fg-muted"> since {timeAgo(lock.lockedAt)}</span> : null}
          {lock?.lockNote ? <span className="text-fg-muted"> — {lock.lockNote}</span> : null}
        </span>
        <span className="text-fg-subtle">Everybody else has it read-only.</span>
        <Button
          variant="secondary"
          size="sm"
          icon={Unlock}
          loading={busy}
          onClick={release}
          className="ml-auto"
        >
          Unlock
        </Button>
      </div>
    );
  }

  /* ------------------------------------------------------------ somebody else holds it ---- */
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-crit/10 px-3 py-2 text-xs ring-1 ring-crit/25">
      <Lock size={14} className="shrink-0 text-crit" />
      <Avatar user={holder} size={20} />
      <span className="text-fg">
        <span className="font-medium">{displayName(holder)}</span> has locked this finding
        {lock?.lockedAt ? ` at ${formatDateTime(lock.lockedAt)}` : ''} — it is read-only for you.
        {lock?.lockNote ? <span className="text-fg-muted"> “{lock.lockNote}”</span> : null}
      </span>
      {stale ? (
        <span className="flex items-center gap-1 text-med">
          <ShieldAlert size={12} />
          They have gone quiet, so this lock has lapsed.
        </span>
      ) : null}
      {editable && (stale || isManager) ? (
        <Button
          variant={stale ? 'secondary' : 'danger'}
          size="sm"
          icon={Unlock}
          loading={busy}
          onClick={() => take(true)}
          className="ml-auto"
          title={
            stale
              ? 'Their lock has lapsed — take it'
              : 'Take the lock off them. They will be told when they try to save.'
          }
        >
          {stale ? 'Take the lock' : 'Force unlock'}
        </Button>
      ) : (
        <span className="ml-auto text-fg-subtle">Ask them to unlock it, or ask a lead.</span>
      )}
    </div>
  );
}
