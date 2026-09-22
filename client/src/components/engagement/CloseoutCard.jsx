import { useEffect, useState } from 'react';
import { PhoneCall } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName, formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Textarea } from '../ui/Field.jsx';

/**
 * The call at the end of the job.
 *
 * A kickoff is a structured record — on the proposal: when, who was there, what was agreed. The
 * engagement then captures the testing in enormous detail, produces a document, and stops. The
 * call where you walk the client through what you found, hear what they push back on, and agree
 * who fixes what by when has been living in somebody's notebook.
 *
 * It sits under Delivery rather than in a tab of its own, and the order is the argument: the report
 * went out, then this happened, then the retest. A twentieth tab would put the end of the job in a
 * place nobody passes through on the way to it.
 *
 * **Recordable after approval.** The report went out before the call happened, so a guard that
 * refused edits on an approved engagement would refuse this at exactly the moment it is written.
 * The server takes the same view — see the route, which checks read-only and nothing else.
 */
export default function CloseoutCard({ audit, editable, onReload }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const stored = audit.closeout ?? {};
  const held = Boolean(stored.at);

  useEffect(() => {
    setForm({
      heldOn: stored.heldOn ?? '',
      attendeesOurs: stored.attendeesOurs ?? '',
      attendeesTheirs: stored.attendeesTheirs ?? '',
      notes: stored.notes ?? '',
      disputed: stored.disputed ?? '',
      commitments: stored.commitments ?? '',
      retestOn: stored.retestOn ?? '',
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- the stored record, by its fields. */
  }, [stored.at, stored.heldOn, stored.notes, stored.disputed, stored.commitments, stored.retestOn]);

  if (!form) return null;
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/audits/${audit._id}/closeout`, form);
      toast.success(held ? 'Closeout updated' : 'Closeout recorded');
      setOpen(false);
      /* The page owns the engagement, so refetching it is how this card sees its own write. */
      await onReload?.({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Closeout"
        icon={PhoneCall}
        description="The call where you walked them through it — what they disputed, and what they committed to."
        actions={
          editable ? (
            <Button variant={held ? 'ghost' : 'secondary'} size="sm" onClick={() => setOpen(!open)}>
              {open ? 'Cancel' : held ? 'Edit' : 'Record it'}
            </Button>
          ) : null
        }
      />
      <CardBody>
        {open ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Held on"
                type="date"
                value={form.heldOn}
                onChange={(event) => set({ heldOn: event.target.value })}
              />
              <Input
                label="Retest agreed for"
                type="date"
                hint="Optional — but a closeout with no next date is how a retest stops happening."
                value={form.retestOn}
                onChange={(event) => set({ retestOn: event.target.value })}
              />
              <Input
                label="Who was there, ours"
                placeholder="T. Enache, A. Marin"
                value={form.attendeesOurs}
                onChange={(event) => set({ attendeesOurs: event.target.value })}
              />
              <Input
                label="And theirs"
                hint="Names and roles — none of these people has an account here."
                placeholder="R. Whitfield (Head of Infrastructure), D. Okafor (CISO)"
                value={form.attendeesTheirs}
                onChange={(event) => set({ attendeesTheirs: event.target.value })}
              />
            </div>
            <Textarea
              label="What was walked through"
              rows={5}
              placeholder="Took them through the four Criticals. They had already patched the deserialisation one."
              value={form.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
            <Textarea
              label="What they disputed"
              rows={3}
              hint="The sentence a retest starts from, and a year later the only record that the disagreement happened."
              placeholder="They dispute the severity on the SSRF — argue it is not reachable without a valid session."
              value={form.disputed}
              onChange={(event) => set({ disputed: event.target.value })}
            />
            <Textarea
              label="What they committed to"
              rows={3}
              hint="Commitments about the estate rather than about one finding — per-finding dates live on the findings."
              placeholder="Rebuilding the auth service in Q3. Nothing will be fixed on the legacy platform; it is being decommissioned."
              value={form.commitments}
              onChange={(event) => set({ commitments: event.target.value })}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} loading={saving}>
                {held ? 'Save' : 'Record the closeout'}
              </Button>
            </div>
          </div>
        ) : held ? (
          <dl className="flex flex-col gap-3 text-sm">
            <Row label="Held on" value={stored.heldOn ? formatDate(stored.heldOn) : 'Not said'} />
            {stored.attendeesTheirs ? <Row label="Their side" value={stored.attendeesTheirs} /> : null}
            {stored.notes ? <Row label="Walked through" value={stored.notes} /> : null}
            {stored.disputed ? <Row label="Disputed" value={stored.disputed} tone="warning" /> : null}
            {stored.commitments ? <Row label="Committed to" value={stored.commitments} /> : null}
            {stored.retestOn ? <Row label="Retest agreed for" value={formatDate(stored.retestOn)} /> : null}
            <p className="text-[0.6875rem] text-fg-subtle">
              Recorded by {displayName(stored.by) || 'somebody'} {timeAgo(stored.at)}.
            </p>
          </dl>
        ) : (
          <p className="text-xs leading-relaxed text-fg-muted">
            Nothing recorded yet. The per-finding decisions — a remediation date, a risk the client
            accepts — live on the findings themselves; this is for the conversation around them.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** One recorded answer. Multi-line values keep their line breaks; they were typed as paragraphs. */
function Row({ label, value, tone }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd
        className={`whitespace-pre-wrap text-sm leading-relaxed ${
          tone === 'warning' ? 'text-med' : 'text-fg'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
