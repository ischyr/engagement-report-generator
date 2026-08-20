import { useMemo, useState } from 'react';
import { ArrowRightLeft, Copy, Info } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Select } from '../ui/Field.jsx';

/**
 * Files this finding on a different engagement.
 *
 * Two situations, both ordinary: it was written on the wrong one, and the same issue turned up
 * on a second job for the same client. Both used to mean copying five rich-text fields through
 * the clipboard, which loses the screenshots — so findings stayed where they did not belong.
 */
export default function TransferFindingCard({ auditId, finding, dirty, onMoved, onCopied }) {
  const toast = useToast();
  // The engagements this person can write to; the list route already scopes itself.
  const { data } = useResource('/audits', { initial: [] });
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState('');

  const options = useMemo(() => {
    const list = Array.isArray(data) ? data : [];
    return list
      .filter((entry) => String(entry._id) !== String(auditId))
      // An approved engagement is frozen, and the server would refuse anyway.
      .filter((entry) => entry.state !== 'APPROVED')
      .map((entry) => ({
        value: entry._id,
        label: [entry.reference, entry.name].filter(Boolean).join(' — '),
        company: entry.company?.name ?? '',
      }));
  }, [data, auditId]);

  const chosen = options.find((option) => option.value === target);

  const transfer = async (mode) => {
    if (!target) return;
    setBusy(mode);
    try {
      const result = await api.post(`/audits/${auditId}/findings/${finding._id}/transfer`, {
        target,
        mode,
      });
      const where = result.targetReference || result.targetName;
      if (mode === 'move') {
        toast.success(`Moved to ${where}`, `It is finding ${result.identifier} there now.`);
        onMoved?.(result);
      } else {
        toast.success(
          `Copied to ${where}`,
          result.imagesRemoved
            ? `${result.imagesRemoved} screenshot${
                result.imagesRemoved === 1 ? '' : 's'
              } stayed here — that is a different client.`
            : 'Evidence came across too.'
        );
        onCopied?.(result);
      }
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  if (!options.length) return null;

  return (
    <Card>
      <CardHeader
        icon={ArrowRightLeft}
        title="File this somewhere else"
        description="Move it if it was written on the wrong engagement, or copy it if the same issue belongs on two jobs. Review comments stay behind either way — they were about this report."
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Engagement"
            wrapperClassName="min-w-0 flex-1"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            options={[{ value: '', label: 'Choose an engagement…' }, ...options]}
          />
          <Button
            variant="secondary"
            icon={Copy}
            loading={busy === 'copy'}
            disabled={!target || dirty || Boolean(busy)}
            title={dirty ? 'Save the finding first' : 'Leave this one here and add a copy there'}
            onClick={() => transfer('copy')}
          >
            Copy
          </Button>
          <Button
            variant="secondary"
            icon={ArrowRightLeft}
            loading={busy === 'move'}
            disabled={!target || dirty || Boolean(busy)}
            title={dirty ? 'Save the finding first' : 'Move it there and remove it from here'}
            onClick={() => transfer('move')}
          >
            Move
          </Button>
        </div>

        {chosen ? (
          <p className="flex items-start gap-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
            <Info size={13} className="mt-0.5 shrink-0" />
            {chosen.company
              ? `${chosen.label} belongs to ${chosen.company}. `
              : `${chosen.label} has no client set. `}
            A move takes the screenshots with it. A copy keeps them only when both engagements
            are for the same client — evidence is one client's data, and it does not travel to
            another.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
