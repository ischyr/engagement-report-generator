import { useEffect, useState } from 'react';
import { CalendarSync, Copy } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select } from '../ui/Field.jsx';

const INTERVALS = [
  { value: '', label: 'Does not repeat' },
  { value: '3', label: 'Every quarter' },
  { value: '6', label: 'Every six months' },
  { value: '12', label: 'Every year' },
  { value: '24', label: 'Every two years' },
];

/**
 * Work that comes round again.
 *
 * The annual retest and the quarterly scan are the same engagement in the same shape every time,
 * created by hand and remembered by one person — who eventually leaves, or is away in the week it
 * was due. The failure is not that it is hard to create; it is that nobody notices it should
 * exist.
 *
 * It nudges rather than creates. An engagement appearing on its own, part-filled and with a team
 * booked onto it, is a surprise nobody asked for.
 */
export default function RepeatCard({ audit, editable, onPatch }) {
  const toast = useToast();
  const repeat = audit.repeat ?? {};

  const [months, setMonths] = useState(repeat.months ? String(repeat.months) : '');
  const [nextDue, setNextDue] = useState(repeat.nextDue ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMonths(audit.repeat?.months ? String(audit.repeat.months) : '');
    setNextDue(audit.repeat?.nextDue ?? '');
  }, [audit.repeat?.months, audit.repeat?.nextDue]);

  const dirty =
    months !== (repeat.months ? String(repeat.months) : '') || nextDue !== (repeat.nextDue ?? '');

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.put(`/audits/${audit._id}/repeat`, {
        months: months ? Number(months) : null,
        ...(months && nextDue ? { nextDue } : {}),
      });
      onPatch?.({ repeat: result.repeat });
      toast.success(
        result.repeat.months ? 'Recurrence set' : 'Recurrence cleared',
        result.repeat.months
          ? `Somebody will be told a month before ${formatDate(result.repeat.nextDue)}.`
          : 'Nothing will be scheduled from this engagement.'
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
        icon={CalendarSync}
        title="Does this come round again?"
        description="Annual retests and quarterly scans are the same job in the same shape every time. This does not create anything — it makes sure somebody is told before it is due."
        actions={
          repeat.months && repeat.nextDue ? (
            <Badge tone="brand" title={`Next due ${formatDate(repeat.nextDue)}`}>
              next {formatDate(repeat.nextDue)}
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="How often"
            value={months}
            options={INTERVALS}
            disabled={!editable}
            onChange={(event) => setMonths(event.target.value)}
          />
          {months ? (
            <Input
              label="Next one due"
              type="date"
              hint="Left empty, it is worked out from this engagement's end date."
              value={nextDue}
              disabled={!editable}
              onChange={(event) => setNextDue(event.target.value)}
            />
          ) : null}
        </div>

        {repeat.createdNext ? (
          <p className="flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
            <Copy size={12} />
            The next one has already been created from this engagement.
          </p>
        ) : null}

        {editable ? (
          <div className="flex items-center gap-3 border-t border-line-soft pt-3">
            <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={save}>
              Save
            </Button>
            <p className="min-w-0 flex-1 text-[0.625rem] leading-snug text-fg-subtle">
              A reminder goes to whoever created this engagement and whoever worked on it, a month
              before it is due, once.
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
