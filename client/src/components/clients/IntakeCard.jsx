import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Copy, Plus, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState } from '../ui/Feedback.jsx';

const STATUS_META = {
  open: { label: 'waiting on them', tone: 'neutral' },
  submitted: { label: 'answered', tone: 'success' },
  used: { label: 'engagement created', tone: 'brand' },
  cancelled: { label: 'withdrawn', tone: 'warning' },
};

/**
 * Pre-engagement questionnaires for this client.
 *
 * The link is handed back here rather than emailed — there is no SMTP in this app on purpose,
 * and delivering a URL is left to a channel the firm already trusts. Same arrangement as a
 * password invitation.
 */
export default function IntakeCard({ companyId, canWrite }) {
  const toast = useToast();
  const { data, reload } = useResource(`/intake?company=${companyId}`, { initial: [] });

  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState(null);
  const [pendingCancel, setPendingCancel] = useState(null);
  const [busy, setBusy] = useState('');

  const rows = data ?? [];

  const create = async () => {
    setCreating(true);
    try {
      const result = await api.post('/intake', { company: companyId, label });
      setLabel('');
      setIssued(`${window.location.origin}${result.path}`);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setCreating(false);
    }
  };

  const build = async (intake) => {
    setBusy(String(intake._id));
    try {
      const result = await api.post(`/intake/${intake._id}/engagement`, {});
      await reload({ quiet: true });
      toast.success(
        'Engagement created',
        `"${result.audit.name}" — a draft of what they asked for. Read it before you agree to it.`
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    try {
      await api.post(`/intake/${pendingCancel._id}/cancel`, {});
      setPendingCancel(null);
      await reload({ quiet: true });
      toast.success('Withdrawn', 'That link no longer works.');
    } catch (error) {
      toast.fromError(error);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={ClipboardList}
        title="Before we start"
        description="A questionnaire the client fills in: scope, dates, contacts, and what we must not do. What comes back is kept as they wrote it."
      />

      {canWrite ? (
        <CardBody className="flex flex-wrap items-end gap-3 border-b border-line-soft">
          <Input
            label="What is it for"
            placeholder="Annual external test"
            wrapperClassName="min-w-56 flex-1"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button variant="secondary" icon={Plus} loading={creating} onClick={create}>
            Make a link
          </Button>
        </CardBody>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="None sent"
          description="Scope, contacts and constraints usually arrive by email and get retyped. Sent as a form, they arrive as data — and stay on record as what the client actually said."
        />
      ) : (
        <CardBody className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const meta = STATUS_META[row.status] ?? STATUS_META.open;
            return (
              <div
                key={row._id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {row.label || 'Pre-engagement questionnaire'}
                  </span>
                  <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                    Sent by {displayName(row.requestedBy) || 'somebody'}
                    {row.submittedAt
                      ? ` · answered ${timeAgo(row.submittedAt)}`
                      : ` · open until ${formatDate(row.expiresAt)}`}
                  </span>
                </span>

                <Badge tone={meta.tone}>{meta.label}</Badge>

                {row.status === 'submitted' && canWrite ? (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === String(row._id)}
                    onClick={() => build(row)}
                  >
                    Create the engagement
                  </Button>
                ) : null}

                {row.status === 'used' && row.createdAudit ? (
                  <Link
                    to={`/engagements/${row.createdAudit}`}
                    className="text-[0.6875rem] text-brand-300 transition hover:text-brand-200"
                  >
                    Open it
                  </Link>
                ) : null}

                {row.status === 'open' && canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    title="Withdraw this link"
                    className="hover:text-crit"
                    onClick={() => setPendingCancel(row)}
                  />
                ) : null}
              </div>
            );
          })}
        </CardBody>
      )}

      {/*
        Shown once, right after it is made. There is nothing to come back for: only a hash of
        the token is stored, so the app cannot show the link again even to the person who
        asked for it.
      */}
      <Modal
        open={Boolean(issued)}
        onClose={() => setIssued(null)}
        title="Send them this link"
        description="Shown once. Only a hash of it is kept, so it cannot be shown again — make another if this one is lost."
        size="md"
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            Done
          </Button>
        }
      >
        <p className="rounded-lg bg-canvas px-3 py-2.5 font-mono text-xs break-all text-fg ring-1 ring-line">
          {issued}
        </p>
        <Button
          variant="ghost"
          size="sm"
          icon={Copy}
          className="mt-3"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(issued);
              toast.success('Copied');
            } catch {
              /* the link is on screen either way */
            }
          }}
        >
          Copy it
        </Button>
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingCancel)}
        onClose={() => setPendingCancel(null)}
        onConfirm={cancel}
        title="Withdraw this questionnaire?"
        message="The link stops working straight away. Anything already answered is kept."
        confirmLabel="Withdraw"
      />
    </Card>
  );
}
