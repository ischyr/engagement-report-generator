import { useState } from 'react';
import { Check, CalendarOff, EyeOff, Plus, Users, X } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName, formatDate } from '../../lib/utils.js';

import { Card, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';
import { leaveMeta, portionLabel } from './leave-meta.js';

const STATUS_TONE = { approved: 'success', requested: 'warning', declined: 'neutral', cancelled: 'neutral' };

/**
 * Who is away this month, as a list — and, for an admin, the queue of requests.
 *
 * The calendar above answers "is that week clear"; this answers "what did I agree to, and
 * what is waiting on me". Deliberately not colour-only: every row names its type in words,
 * because the hatched bars upstairs are a summary and this is the record.
 */
export default function TimeOffCard({ leave = [], onChanged, onAdd }) {
  const { user, isAdmin, canWrite } = useAuth();
  const toast = useToast();
  const me = String(user?.id ?? user?._id ?? '');

  const [busy, setBusy] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const decide = async (row, status) => {
    setBusy(row._id);
    try {
      await api.post(`/leave/${row._id}/decision`, { status });
      await onChanged?.();
      toast.success(status === 'approved' ? 'Approved' : 'Declined', 'They have been told.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const row = pendingDelete;
    setBusy(row._id);
    try {
      const result = await api.del(`/leave/${row._id}`);
      setPendingDelete(null);
      await onChanged?.();
      toast.success(
        result?.removed === false ? 'Cancelled' : 'Removed',
        result?.removed === false
          ? 'It stays on the record as cancelled, since it had already been approved.'
          : undefined
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const waiting = leave.filter((row) => row.status === 'requested');

  return (
    <>
      <Card>
        <CardHeader
          icon={CalendarOff}
          title="Time off this month"
          description="Holiday, sickness, training and the public holidays everybody gets. Days off come out of the available days utilisation is measured against."
          actions={
            <span className="flex items-center gap-2">
              {waiting.length ? (
                <Badge tone="warning">
                  {waiting.length} waiting{isAdmin ? ' on you' : ''}
                </Badge>
              ) : null}
              {canWrite ? (
                <Button variant="secondary" size="sm" icon={Plus} onClick={onAdd}>
                  Book time off
                </Button>
              ) : null}
            </span>
          }
        />

        {leave.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title="Nobody is off this month"
            description="Record holiday, sickness or training and it appears on the calendar above — so the next person to book that week can see it before they do."
            actionLabel={canWrite ? 'Book time off' : undefined}
            actionIcon={Plus}
            onAction={canWrite ? onAdd : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH>Who</TH>
              <TH>What</TH>
              <TH>From</TH>
              <TH>To</TH>
              <TH align="right">Days</TH>
              <TH>Note</TH>
              <TH width="7rem" />
            </THead>
            <TBody>
              {[...leave]
                .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
                .map((row) => {
                  const meta = leaveMeta(row.type);
                  const mine = (row.userId ?? '') === me;
                  const Icon = meta.icon;
                  return (
                    <TR key={row._id}>
                      <TD>
                        {row.everyone ? (
                          <span className="flex items-center gap-2 text-xs text-fg">
                            <Users size={14} className="text-fg-subtle" />
                            Everybody
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Avatar user={row.user} size={22} />
                            <span className="truncate text-xs text-fg">
                              {displayName(row.user) || 'Removed account'}
                            </span>
                            {mine ? <Badge tone="brand">you</Badge> : null}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <span className="flex items-center gap-2">
                          <Icon size={13} style={{ color: meta.hue }} className="shrink-0" />
                          <span className="text-xs text-fg-muted">{meta.label}</span>
                          {row.portion !== 'full' ? (
                            <Badge tone="neutral">{portionLabel(row.portion)} only</Badge>
                          ) : null}
                          <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">{formatDate(row.start)}</TD>
                      <TD className="whitespace-nowrap text-xs text-fg-muted">{formatDate(row.end)}</TD>
                      <TD align="right" className="font-mono text-xs tabular-nums text-fg-muted">
                        {row.workingDays ?? '—'}
                      </TD>
                      <TD className="max-w-xs truncate text-xs text-fg-subtle">
                        {/* Somebody else's reason is theirs. Saying one exists is honest; showing
                            it on a team page is not. */}
                        {row.noteHidden ? (
                          <span className="inline-flex items-center gap-1 text-fg-subtle" title="Only its owner and the admins can read the reason">
                            <EyeOff size={11} />
                            private
                          </span>
                        ) : (
                          row.note || '—'
                        )}
                      </TD>
                      <TD align="right">
                        <span className="flex items-center justify-end gap-1">
                          {isAdmin && row.status === 'requested' && !row.everyone ? (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                icon={Check}
                                title="Approve"
                                className="hover:text-low"
                                disabled={busy === row._id}
                                onClick={() => decide(row, 'approved')}
                              />
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                icon={X}
                                title="Decline"
                                className="hover:text-crit"
                                disabled={busy === row._id}
                                onClick={() => decide(row, 'declined')}
                              />
                            </>
                          ) : null}
                          {canWrite && (mine || isAdmin) ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              icon={CalendarOff}
                              title={row.status === 'requested' ? 'Withdraw' : 'Cancel this'}
                              className="hover:text-crit"
                              disabled={busy === row._id}
                              onClick={() => setPendingDelete(row)}
                            />
                          ) : null}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
            </TBody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title={pendingDelete?.status === 'requested' ? 'Withdraw this request?' : 'Cancel this time off?'}
        message={
          pendingDelete
            ? `${
                pendingDelete.everyone ? 'Everybody' : displayName(pendingDelete.user) || 'Somebody'
              }, ${leaveMeta(pendingDelete.type).label.toLowerCase()}, ${pendingDelete.start} → ${
                pendingDelete.end
              }.${
                pendingDelete.status === 'approved'
                  ? ' It stays on the record as cancelled, because it was approved.'
                  : ''
              }`
            : ''
        }
        confirmLabel={pendingDelete?.status === 'requested' ? 'Withdraw' : 'Cancel it'}
      />
    </>
  );
}
