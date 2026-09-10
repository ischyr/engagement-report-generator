import { AlertTriangle } from 'lucide-react';

import { displayName, formatDateTime } from '../../lib/utils.js';
import { Modal } from './Modal.jsx';
import { Button } from './Button.jsx';

/**
 * Shown when the server refuses a save because someone else edited the same thing
 * first (HTTP 409 from the freshness check).
 *
 * Both ways out are offered explicitly, because only the person looking at the
 * screen knows which copy is worth keeping. Nothing is decided for them, and
 * neither copy is thrown away silently — which is the whole point of the check.
 */
export default function ConflictDialog({
  open,
  onClose,
  onDiscard,
  onOverwrite,
  label = 'this item',
  current,
  loading = false,
}) {
  const editor = current?.updatedBy ?? current?.author ?? null;
  const when = current?.updatedAt ? formatDateTime(current.updatedAt) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Someone else got there first"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Keep editing
          </Button>
          <Button variant="secondary" onClick={onDiscard} disabled={loading}>
            Discard mine, load theirs
          </Button>
          <Button variant="danger" onClick={onOverwrite} loading={loading}>
            Overwrite theirs
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-med/12 text-med">
          <AlertTriangle size={16} />
        </span>
        <div className="flex flex-col gap-2 text-sm leading-relaxed text-fg-muted">
          <p>
            Your changes to <span className="font-medium text-fg">{label}</span> were not saved —{' '}
            {editor ? (
              <>
                <span className="font-medium text-fg">{displayName(editor)}</span> changed it
              </>
            ) : (
              'it changed on the server'
            )}
            {when ? ` at ${when}` : ''} while you were typing.
          </p>
          <p className="text-xs">
            Nothing has been lost yet. Copy anything you need out of the editor first — “Discard
            mine” replaces what is on screen with the saved version, and “Overwrite theirs” saves
            your copy over it.
          </p>
        </div>
      </div>
    </Modal>
  );
}
