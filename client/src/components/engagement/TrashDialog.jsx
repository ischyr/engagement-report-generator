import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, timeAgo } from '../../lib/utils.js';

import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Deleted engagements, and how long is left to change your mind.
 *
 * Deleting is a soft delete precisely so this screen can exist — an engagement is
 * weeks of work, and the retention window (Settings → Danger zone) is what turns a
 * mis-click into an inconvenience rather than a loss.
 */
export default function TrashDialog({ open, onClose, onRestored }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const { data, loading, reload } = useResource(open ? '/audits/trash' : null, {
    initial: { audits: [], retentionDays: null },
  });

  const [busyId, setBusyId] = useState(null);
  const [pendingPurge, setPendingPurge] = useState(null);

  const audits = data?.audits ?? [];
  const retentionDays = data?.retentionDays;

  const restore = async (audit) => {
    setBusyId(audit._id);
    try {
      await api.post(`/audits/${audit._id}/restore`, {});
      toast.success(`"${audit.name}" restored`);
      await reload({ quiet: true });
      onRestored?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async () => {
    if (!pendingPurge) return;
    setBusyId(pendingPurge._id);
    try {
      await api.del(`/audits/${pendingPurge._id}/purge`);
      toast.success('Deleted for good');
      setPendingPurge(null);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Trash"
        description={
          retentionDays
            ? `Deleted engagements are kept for ${retentionDays} day${
                retentionDays === 1 ? '' : 's'
              }, then purged automatically.`
            : 'Deleted engagements can be restored from here.'
        }
        size="lg"
      >
        {loading ? (
          <LoadingBlock label="Loading the trash…" />
        ) : audits.length === 0 ? (
          <EmptyState
            icon={Trash2}
            title="The trash is empty"
            description="Deleted engagements land here first, so nothing is lost to a mis-click."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {audits.map((audit) => (
              <li
                key={audit._id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{audit.name}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {[
                      audit.reference,
                      audit.company?.name,
                      `${audit.findingCount ?? 0} finding${audit.findingCount === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="mt-0.5 truncate text-[0.625rem] text-fg-subtle">
                    Deleted {timeAgo(audit.deletedAt)}
                    {audit.deletedBy ? ` by ${displayName(audit.deletedBy)}` : ''}
                  </p>
                </div>

                <Badge tone={audit.daysLeft <= 2 ? 'warning' : 'neutral'}>
                  {audit.daysLeft === 0
                    ? 'purged on the next sweep'
                    : `${audit.daysLeft} day${audit.daysLeft === 1 ? '' : 's'} left`}
                </Badge>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={RotateCcw}
                    loading={busyId === audit._id}
                    onClick={() => restore(audit)}
                  >
                    Restore
                  </Button>
                  {isAdmin ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Delete for good"
                      className="hover:text-crit"
                      onClick={() => setPendingPurge(audit)}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingPurge)}
        onClose={() => setPendingPurge(null)}
        onConfirm={purge}
        loading={Boolean(busyId) && busyId === pendingPurge?._id}
        title="Delete for good?"
        confirmLabel="Delete permanently"
        message={`"${pendingPurge?.name}", its findings, sections and activity log will be removed for good. This cannot be undone.`}
      />
    </>
  );
}
