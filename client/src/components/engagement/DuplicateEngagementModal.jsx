import { useEffect, useState } from 'react';
import { Copy, Info } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';

import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Toggle } from '../ui/Field.jsx';

/**
 * What a copy is allowed to bring with it.
 *
 * The setup, not the work. Findings are off because the usual reason to duplicate is "another
 * job of this shape for this client", and a new engagement that arrives already claiming last
 * quarter's findings is worse than an empty one. Notes are off because a scratchpad is
 * personal to the job it was kept for.
 */
const PARTS = [
  { key: 'scope', label: 'Scope', hint: 'Hosts, services and groups.' },
  { key: 'sections', label: 'Narrative sections', hint: 'Methodology, approach, conclusion — the text you reuse.' },
  { key: 'checks', label: 'Test checklist', hint: 'The checks themselves. Nothing arrives already ticked.' },
  { key: 'customFields', label: 'Custom fields', hint: 'The fields, with their values.' },
  { key: 'team', label: 'Team', hint: 'The same collaborators and reviewers.' },
  { key: 'notes', label: 'Notes', hint: 'The tester’s scratchpad from the original.' },
  { key: 'findings', label: 'Findings', hint: 'For a retest. Each arrives as not fixed, renumbered, without comments.' },
];

const DEFAULTS = {
  scope: true,
  sections: true,
  checks: true,
  customFields: true,
  team: true,
  notes: false,
  findings: false,
};

/**
 * Another engagement of the same shape.
 *
 * A follow-up for the same client meant retyping the scope, the team, the checklist and the
 * template every time — so people copied the *previous report* in Word instead, which is how
 * last client's name ends up on this client's cover page.
 */
export default function DuplicateEngagementModal({ open, audit, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', reference: '', ...DEFAULTS });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !audit) return;
    setForm({ name: `${audit.name} (copy)`, reference: '', ...DEFAULTS });
  }, [open, audit]);

  const submit = async () => {
    setSaving(true);
    try {
      const result = await api.post(`/audits/${audit._id}/duplicate`, form);
      const counts = result.copied ?? {};
      toast.success(
        'Engagement duplicated',
        [
          counts.scope ? `${counts.scope} scope group(s)` : null,
          counts.sections ? `${counts.sections} section(s)` : null,
          counts.checks ? `${counts.checks} check(s)` : null,
          counts.findings ? `${counts.findings} finding(s)` : null,
          result.imagesRemoved
            ? `${result.imagesRemoved} screenshot(s) left behind`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      );
      onCreated?.(result.audit);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Duplicate this engagement"
      description="A new engagement with the same setup. It starts in progress, with no dates, no sign-offs and no delivery record — those belong to the job that earned them."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Copy}
            loading={saving}
            disabled={!form.name.trim()}
            onClick={submit}
          >
            Duplicate it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Input
            label="Reference"
            placeholder="PT-2026-052"
            hint="Left empty on purpose — a copy needs its own."
            value={form.reference}
            onChange={(event) => setForm({ ...form, reference: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-3">
          {PARTS.map((part) => (
            <Toggle
              key={part.key}
              checked={form[part.key]}
              onChange={(value) => setForm({ ...form, [part.key]: value })}
              label={part.label}
              hint={part.hint}
            />
          ))}
        </div>

        <p className="flex items-start gap-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
          <Info size={13} className="mt-0.5 shrink-0" />
          Screenshots are not copied. Evidence belongs to the engagement it was captured on, so
          any copied text arrives without its images and the captions are left in place as a
          reminder of what needs retaking.
        </p>
      </div>
    </Modal>
  );
}
