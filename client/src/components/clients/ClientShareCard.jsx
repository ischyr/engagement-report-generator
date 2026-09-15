import { useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { Alert } from '../ui/Alert.jsx';
import { Button } from '../ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Input, Select, Textarea, Toggle } from '../ui/Field.jsx';

/**
 * A link showing this client everything the firm has done for them.
 *
 * Deliberately here rather than on an engagement, because it is not about one — and because a
 * control with this reach should sit somewhere a person has gone on purpose. An engagement link
 * forwarded to the wrong reader exposes one job; this one exposes the shape of a client's whole
 * relationship with the firm, and the card says so rather than leaving somebody to work it out.
 *
 * Read-only in every sense: nothing on the page behind it can be changed, and the server refuses
 * every write through a link of this kind. Work that has not been reported is listed by name with
 * no numbers, and restricted engagements are not listed at all — both decided on the server, both
 * worth repeating here, because the person pressing this is entitled to know what they are
 * handing over before they press it.
 */
export default function ClientShareCard({ companyId, companyName }) {
  const toast = useToast();
  const contacts = useResource(companyId ? '/data/clients' : null, { initial: [] });
  const theirs = (Array.isArray(contacts.data) ? contacts.data : (contacts.data?.items ?? [])).filter(
    (person) => String(person.company?._id ?? person.company ?? '') === String(companyId)
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [sending, setSending] = useState(null);
  const [draft, setDraft] = useState({
    label: '',
    days: 90,
    recipients: [],
    typed: '',
    message: '',
    copyToMe: false,
  });

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const create = async () => {
    setBusy(true);
    try {
      const typed = draft.typed.trim();
      const made = await api.post(`/share/link/company/${companyId}`, {
        label: draft.label.trim(),
        days: Number(draft.days),
        recipients: [...draft.recipients, ...(typed ? [{ name: '', email: typed }] : [])],
        message: draft.message.trim(),
        copyToMe: draft.copyToMe,
      });
      setFresh(`${origin}${made.path}`);
      setSending(made.sending ?? null);
      setOpen(false);
      setDraft({ label: '', days: 90, recipients: [], typed: '', message: '', copyToMe: false });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy it — select it and copy by hand.');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Share2}
        title="Share their history with them"
        description="One link showing this client every engagement you have reported for them, what was found, and what is still open. Read-only."
        actions={
          !open ? (
            <Button variant="secondary" size="sm" icon={Link2} onClick={() => setOpen(true)}>
              Make a link
            </Button>
          ) : null
        }
      />

      {fresh ? (
        <CardBody className="border-b border-line-soft">
          <Alert tone="success" title="Here it is — this is the only time it is shown">
            <p className="mb-2 break-all font-mono text-[0.6875rem] text-fg">{fresh}</p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" icon={Copy} onClick={() => copy(fresh)}>
                Copy it
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                Done
              </Button>
            </div>
            {sending?.attempted ? (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                {sending.sent.length
                  ? `Sent to ${sending.sent.map((person) => person.email).join(', ')}.`
                  : 'Nobody was sent it.'}
                {sending.refused?.length ? ` Could not send to ${sending.refused.join(', ')}.` : ''}
                {sending.reason ? ` ${sending.reason}` : ''}
              </p>
            ) : (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                Only a hash of it is stored, so it cannot be shown again.
              </p>
            )}
          </Alert>
        </CardBody>
      ) : null}

      {open ? (
        <CardBody className="flex flex-col gap-3">
          {/*
            Said before the controls rather than after them. Somebody about to hand this over is
            entitled to know its reach while they are deciding, not once they have decided.
          */}
          <Alert tone="warning" title="This is wider than an engagement link">
            <p className="text-[0.6875rem]">
              Whoever holds it sees every engagement you have <strong>reported</strong> for{' '}
              {companyName || 'this client'} — names, dates, and counts by severity. Work still in
              progress is listed by name with no numbers, restricted engagements are not listed at
              all, and no finding titles or write-ups appear anywhere on it.
            </p>
          </Alert>

          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <Input
              label="Who it is for"
              autoFocus
              placeholder="Dana at Northwind"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              hint="Only you see this."
            />
            <Select
              label="Good for"
              value={String(draft.days)}
              onChange={(event) => setDraft({ ...draft, days: event.target.value })}
              options={[
                { value: '30', label: 'A month' },
                { value: '90', label: 'Three months' },
                { value: '180', label: 'Six months' },
              ]}
            />
          </div>

          <div className="rounded-lg border border-line-soft p-3">
            <p className="text-xs font-medium text-fg">Send it to them</p>
            <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">
              Optional. Leave it empty and you will get the link to send yourself. It can only be
              sent now — only a hash of it is kept.
            </p>
            {theirs.length ? (
              <div className="mt-2 flex flex-col gap-1">
                {theirs.map((person) => {
                  const picked = draft.recipients.some((entry) => entry.email === person.email);
                  return (
                    <label
                      key={person._id}
                      className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-fg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            recipients: picked
                              ? draft.recipients.filter((entry) => entry.email !== person.email)
                              : [
                                  ...draft.recipients,
                                  {
                                    name: [person.firstname, person.lastname]
                                      .filter(Boolean)
                                      .join(' '),
                                    email: person.email,
                                    client: person._id,
                                  },
                                ],
                          })
                        }
                        className="size-3.5 accent-brand-500"
                      />
                      <span className="truncate">
                        {[person.firstname, person.lastname].filter(Boolean).join(' ') ||
                          person.email}
                      </span>
                      <span className="truncate text-fg-subtle">{person.email}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                No contacts recorded for this client yet.
              </p>
            )}
            <Input
              className="mt-2"
              placeholder="or an address, if they are not a contact yet"
              value={draft.typed}
              onChange={(event) => setDraft({ ...draft, typed: event.target.value })}
            />
            {draft.recipients.length || draft.typed.trim() ? (
              <>
                <Textarea
                  className="mt-2"
                  label="A note to go with it"
                  rows={3}
                  value={draft.message}
                  onChange={(event) => setDraft({ ...draft, message: event.target.value })}
                />
                <Toggle
                  className="mt-2"
                  checked={draft.copyToMe}
                  onChange={(copyToMe) => setDraft({ ...draft, copyToMe })}
                  label="Copy me in"
                />
              </>
            ) : null}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={create} disabled={busy}>
              Make the link
            </Button>
          </div>
        </CardBody>
      ) : null}
    </Card>
  );
}
