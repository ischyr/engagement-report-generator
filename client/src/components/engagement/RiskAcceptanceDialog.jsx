import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Textarea } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Recording that the client decided to live with one.
 *
 * "Risk accepted" is the only remediation status that closes a finding without anything being
 * fixed. The vulnerability is still there; what changed is that somebody with the authority to do
 * so decided not to change it. A report has to be able to say that — and saying it without a
 * reason and a name is making an assertion about somebody else's decision with nothing behind it,
 * which is the first thing disputed when the finding turns up again next year.
 *
 * So the server refuses the status without both, and this is where they are asked for. A dialog
 * rather than two more fields on the card, because the fields are meaningless in every other state
 * and a card carrying four permanently-empty boxes teaches people to ignore that part of the card.
 *
 * **Who accepted it is free text, and that is deliberate.** The person accepting a risk is at the
 * client — a CISO, a system owner, whoever signs — and none of them has an account here. Offering
 * a picker of our own consultants would record the wrong name on the one field where the name is
 * the whole point.
 */
export default function RiskAcceptanceDialog({ open, finding, onClose, onSave, saving = false }) {
  const [form, setForm] = useState({ reason: '', acceptedBy: '', acceptedAt: '', reviewOn: '' });

  /* Reset from the finding each time it opens, so editing an acceptance starts from what is there. */
  useEffect(() => {
    if (!open) return;
    const current = finding?.riskAcceptance ?? {};
    setForm({
      reason: current.reason ?? '',
      acceptedBy: current.acceptedBy ?? '',
      acceptedAt: current.acceptedAt ? String(current.acceptedAt).slice(0, 10) : '',
      reviewOn: current.reviewOn ?? '',
    });
  }, [open, finding]);

  const set = (patch) => setForm((previous) => ({ ...previous, ...patch }));
  const ready = form.reason.trim().length > 0 && form.acceptedBy.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Accept this risk"
      description="Records that the client decided to live with this one. It prints in the report beside the finding."
      size="md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSave({
            remediationStatus: 'accepted',
            riskAcceptance: {
              reason: form.reason.trim(),
              acceptedBy: form.acceptedBy.trim(),
              acceptedAt: form.acceptedAt || null,
              reviewOn: form.reviewOn || '',
            },
          });
        }}
      >
        <Alert tone="info" icon={ShieldCheck} title="This does not mean fixed">
          The vulnerability is still there. The report says so, and says who chose to leave it —
          which is what makes an accepted risk different from a closed one.
        </Alert>

        <Textarea
          label="Why"
          rows={4}
          required
          autoFocus
          hint="The client’s reasoning, in their words where you have them."
          placeholder="The host is reachable only from the management VLAN and is due for decommissioning in Q3."
          value={form.reason}
          onChange={(event) => set({ reason: event.target.value })}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Who accepted it"
            required
            hint="The person at the client who decided — a name and a role."
            placeholder="R. Whitfield, Head of Infrastructure"
            value={form.acceptedBy}
            onChange={(event) => set({ acceptedBy: event.target.value })}
          />
          <Input
            label="When"
            type="date"
            hint="Left blank, today is recorded."
            value={form.acceptedAt}
            onChange={(event) => set({ acceptedAt: event.target.value })}
          />
        </div>

        <Input
          label="Look at it again on"
          type="date"
          hint="Optional. An acceptance with no end is how a Critical quietly becomes permanent — a date here is what lets a later engagement ask about it."
          value={form.reviewOn}
          onChange={(event) => set({ reviewOn: event.target.value })}
        />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready || saving}>
            {saving ? 'Saving…' : 'Record the acceptance'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
