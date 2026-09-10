import { useState } from 'react';
import { Lock, ShieldAlert, Unlock } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Textarea } from '../ui/Field.jsx';

/**
 * How carefully this engagement has to be handled.
 *
 * Two levels, and everything the higher one means is enforced by the server rather than promised
 * here — so the card's job is to say plainly what happens, not to be the control that makes it
 * happen.
 */
export default function ClassificationCard({ audit, editable, onPatch }) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [asking, setAsking] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const restricted = audit.classification === 'restricted';

  const set = async (classification) => {
    setSaving(true);
    try {
      const result = await api.put(`/audits/${audit._id}/classification`, {
        classification,
        note,
      });
      onPatch?.(result);
      setAsking(null);
      setNote('');
      toast.success(
        classification === 'restricted' ? 'Marked restricted' : 'Marking removed',
        classification === 'restricted'
          ? 'Two-factor is now needed to open it, and the other rules apply from now on.'
          : 'It is handled like any other engagement again.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={restricted ? Lock : ShieldAlert}
        title="How sensitive is this?"
        description={
          restricted
            ? 'Marked restricted. The rules below are enforced, not advisory.'
            : 'Handled like any other engagement. Mark it restricted if the material warrants it.'
        }
        actions={
          restricted ? (
            <Badge tone="danger" icon={Lock}>
              restricted
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        {restricted && audit.classificationNote ? (
          <p className="rounded-lg border border-crit/25 bg-crit/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
            {audit.classificationNote}
          </p>
        ) : null}

        {restricted ? (
          <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-fg-muted">
            <li>· Two-factor authentication is required to open it — including for admins.</li>
            <li>· Borrowed credentials must expire, and can be stored for at most 30 days.</li>
            <li>· Findings cannot be promoted into the shared library everybody can read.</li>
            <li>· A copy of this engagement stays restricted.</li>
            <li>· It leaves the trash sooner than an ordinary engagement.</li>
          </ul>
        ) : null}

        {restricted && audit.classifiedAt ? (
          <p className="text-[0.625rem] text-fg-subtle">
            Marked by {displayName(audit.classifiedBy) || 'somebody'}{' '}
            {formatDateTime(audit.classifiedAt)}.
          </p>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
            {restricted ? (
              <Button
                variant="ghost"
                size="sm"
                icon={Unlock}
                disabled={!isAdmin}
                title={
                  isAdmin
                    ? 'Handle it like any other engagement again'
                    : 'Only an admin can take this off'
                }
                onClick={() => setAsking('standard')}
              >
                Remove the marking
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={Lock}
                onClick={() => setAsking('restricted')}
              >
                Mark restricted
              </Button>
            )}
            <p className="min-w-0 flex-1 text-[0.625rem] leading-snug text-fg-subtle">
              {/* The asymmetry is the design, so it is stated rather than discovered. */}
              Anybody who can edit may mark it restricted. Only an admin can take that off —
              removing protection is the direction worth a second person.
            </p>
          </div>
        ) : null}
      </CardBody>

      <Modal
        open={Boolean(asking)}
        onClose={() => setAsking(null)}
        title={asking === 'restricted' ? 'Mark this restricted?' : 'Remove the restricted marking?'}
        description={
          asking === 'restricted'
            ? 'It takes effect immediately, for everybody.'
            : 'It will be handled like any other engagement from now on. Anything already stored under the stricter rules stays as it is.'
        }
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant={asking === 'restricted' ? 'primary' : 'danger'}
              loading={saving}
              onClick={() => set(asking)}
            >
              {asking === 'restricted' ? 'Mark it' : 'Remove it'}
            </Button>
          </>
        }
      >
        {asking === 'restricted' ? (
          <Textarea
            label="Why"
            rows={3}
            autoFocus
            hint="Shown to anybody who finds it locked and wonders. Optional, and worth writing."
            placeholder="Client is under an NDA that covers the findings as well as the data."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        ) : (
          <p className="text-xs leading-relaxed text-fg-muted">
            Two-factor will no longer be required to open it, its findings can be promoted into
            the shared library, and it will sit in the trash for the ordinary retention window.
          </p>
        )}
      </Modal>
    </Card>
  );
}
