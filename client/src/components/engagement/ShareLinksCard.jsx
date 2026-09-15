import { useState } from 'react';
import { BellRing, Copy, Eye, Link2, Plus, Send, ShieldOff } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea, Toggle } from '../ui/Field.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Alert } from '../ui/Alert.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';

/**
 * Links that let the client see their own findings.
 *
 * On the Delivery tab because that is where the report leaves: the link is the other half of
 * sending it, and the two questions people ask here — what did they get, and have they done
 * anything about it — are next to each other.
 *
 * The URL is shown once, at the moment it is made, and never again. Only a hash of the token is
 * kept, so the app genuinely cannot show it twice; somebody who loses it makes another and revokes
 * the first, which is a better outcome than a link this app could hand out repeatedly.
 */
export default function ShareLinksCard({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/share/link/${audit._id}`, {
    initial: { links: [] },
  });

  /*
   * The contacts at this engagement's client, so a link can be sent to a person rather than to an
   * address somebody retypes. Fetched only while the form is open — a card that is mostly a list
   * of existing links has no reason to pull the contact book on every render of the tab.
   */
  const [making, setMaking] = useState(false);
  const contacts = useResource(making ? '/data/clients' : null, { initial: [] });
  const theirs = (Array.isArray(contacts.data) ? contacts.data : (contacts.data?.items ?? [])).filter(
    (person) => String(person.company?._id ?? person.company ?? '') === String(audit.company?._id ?? audit.company ?? '')
  );

  const [draft, setDraft] = useState({
    label: '',
    days: 30,
    allowUpdates: true,
    kind: 'findings',
    /** Who to send it to. Empty is the old behaviour: make it, copy it, send it yourself. */
    recipients: [],
    typed: '',
    message: '',
    copyToMe: false,
    /** Days between chases. Zero is off, and stays off unless somebody chooses otherwise. */
    remindEveryDays: 0,
  });
  const [fresh, setFresh] = useState(null);
  /** What the send did, reported beside the link rather than as a toast that scrolls away. */
  const [sending, setSending] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [busy, setBusy] = useState(false);

  const links = data?.links ?? [];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const create = async () => {
    setBusy(true);
    try {
      /* A typed address counts as a recipient without being a contact — see the note by the box. */
      const typed = draft.typed.trim();
      const recipients = [
        ...draft.recipients,
        ...(typed ? [{ name: '', email: typed }] : []),
      ];

      const made = await api.post(`/share/link/${audit._id}`, {
        label: draft.label.trim(),
        days: Number(draft.days),
        allowUpdates: draft.allowUpdates,
        kind: draft.kind,
        recipients,
        message: draft.message.trim(),
        copyToMe: draft.copyToMe,
        remindEveryDays: Number(draft.remindEveryDays) || 0,
      });
      setFresh(`${origin}${made.path}`);
      setSending(made.sending ?? null);
      setMaking(false);
      setDraft({
        label: '',
        days: 30,
        allowUpdates: true,
        kind: 'findings',
        recipients: [],
        typed: '',
        message: '',
        copyToMe: false,
        remindEveryDays: 0,
      });
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    try {
      await api.post(`/share/link/${audit._id}/${pendingRevoke._id}/revoke`);
      setPendingRevoke(null);
      await reload({ quiet: true });
      toast.success('That link stops working now');
    } catch (error) {
      toast.fromError(error);
    }
  };

  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Copied');
    } catch {
      /* A browser that refuses the clipboard still shows the URL to select by hand. */
    }
  };

  if (loading) return null;

  return (
    <Card>
      <CardHeader
        icon={Link2}
        title="The client's own link"
        description="A private page for the client: what was found and what they have fixed, or — during the test — how far along it is. No account, no password, so it expires and you can withdraw it."
        actions={
          editable ? (
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => setMaking(true)}>
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
            {/*
              What happened to the send, next to the link rather than in a toast. A toast that says
              "the mail server refused it" and then disappears leaves somebody believing the client
              has the link.
            */}
            {sending?.attempted ? (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                {sending.sent.length
                  ? `Sent to ${sending.sent.map((person) => person.email).join(', ')}.`
                  : 'Nobody was sent it.'}
                {sending.refused?.length
                  ? ` Could not send to ${sending.refused.join(', ')}.`
                  : ''}
                {sending.reason ? ` ${sending.reason}` : ''}
              </p>
            ) : (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                Only a hash of it is stored, so it cannot be shown again. Send it the way you would
                send the report.
              </p>
            )}
          </Alert>
        </CardBody>
      ) : null}

      {making ? (
        <CardBody className="flex flex-col gap-3 border-b border-line-soft">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <Input
              label="Who it is for"
              autoFocus
              placeholder="Dana at Northwind"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              hint="Only you see this. It names the link in the log if they change something."
            />
            <Select
              label="Good for"
              value={String(draft.days)}
              onChange={(event) => setDraft({ ...draft, days: event.target.value })}
              options={[
                { value: '7', label: 'A week' },
                { value: '30', label: 'A month' },
                { value: '90', label: 'Three months' },
                { value: '180', label: 'Six months' },
              ]}
            />
          </div>
          {/*
            Which question the link answers, asked before anything else about it, because it
            decides what the other controls even mean: a progress link has no findings on it to
            mark as fixed.
          */}
          <Select
            label="What it shows"
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
            options={[
              { value: 'findings', label: 'The findings, once the report has gone' },
              { value: 'status', label: 'How far along the test is — no findings' },
            ]}
            hint={
              draft.kind === 'status'
                ? 'Counts by severity, how much of the scope has been reached, and the assets they need to do something about. No titles, no write-ups, nothing they could mistake for the report.'
                : 'What was found, and a button to say what they have fixed.'
            }
          />
          {draft.kind === 'findings' ? (
            <Toggle
              checked={draft.allowUpdates}
              onChange={(allowUpdates) => setDraft({ ...draft, allowUpdates })}
              label="They can mark findings as fixed"
              hint="Off makes it read-only — for somebody who should see the position and not change it, like their auditor."
            />
          ) : null}

          {/*
            Who to send it to.
            Optional throughout: leaving it empty makes the link exactly as it was made before this
            existed, and the URL still comes back to be copied. Sending happens now or never — only
            a hash is kept, so there is no later.
          */}
          <div className="rounded-lg border border-line-soft p-3">
            <p className="text-xs font-medium text-fg">Send it to them</p>
            <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">
              Optional. Leave it empty and you will get the link to send yourself — which is what
              this did before. It can only be sent now: only a hash of it is kept, so there is no
              second chance at the address.
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
                                    name: [person.firstname, person.lastname].filter(Boolean).join(' '),
                                    email: person.email,
                                    client: person._id,
                                  },
                                ],
                          })
                        }
                        className="size-3.5 accent-brand-500"
                      />
                      <span className="truncate">
                        {[person.firstname, person.lastname].filter(Boolean).join(' ') || person.email}
                      </span>
                      <span className="truncate text-fg-subtle">{person.email}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                No contacts recorded for this client yet — add them under Clients &amp; data, or
                type an address below.
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
                  placeholder="Optional — leave it empty and it gets a sentence that suits the kind of link."
                  value={draft.message}
                  onChange={(event) => setDraft({ ...draft, message: event.target.value })}
                />
                <Toggle
                  className="mt-2"
                  checked={draft.copyToMe}
                  onChange={(copyToMe) => setDraft({ ...draft, copyToMe })}
                  label="Copy me in"
                  hint="So you have your own record of what they were sent, and when."
                />

                {/*
                  Chasing, which only makes sense on a link that can be acted on and that somebody
                  is actually receiving — so it is drawn inside the recipients block and only for a
                  findings link. Off by default and deliberately: this is the one thing the app
                  sends to somebody outside the firm without anybody deciding to at the time.
                */}
                {draft.kind === 'findings' && draft.allowUpdates ? (
                  <Select
                    className="mt-2"
                    label="Remind them about what is still open"
                    value={String(draft.remindEveryDays)}
                    onChange={(event) =>
                      setDraft({ ...draft, remindEveryDays: Number(event.target.value) })
                    }
                    options={[
                      { value: '0', label: 'No — I will chase them myself' },
                      { value: '7', label: 'Every week' },
                      { value: '14', label: 'Every fortnight' },
                      { value: '30', label: 'Every month' },
                    ]}
                    hint="Stops on its own once everything is marked fixed, when the link expires, or after five — whichever comes first. It says how many are left and never what they are."
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMaking(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={create}>
              Make it
            </Button>
          </div>
        </CardBody>
      ) : null}

      <CardBody className="p-0">
        {links.length ? (
          <ul className="divide-y divide-line-soft">
            {links.map((link) => (
              <li key={link._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {link.label || 'Unnamed link'}
                  </span>
                  <span className="block text-[0.6875rem] text-fg-subtle">
                    {link.revokedAt
                      ? `withdrawn ${timeAgo(link.revokedAt)}`
                      : link.live
                        ? `expires ${formatDate(link.expiresAt)}`
                        : `expired ${formatDate(link.expiresAt)}`}
                    {link.kind === 'status' ? ' · progress only' : link.allowUpdates ? '' : ' · read-only'}
                  </span>
                </span>

                <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
                  <Eye size={12} />
                  {link.views === 0
                    ? 'not opened'
                    : `${link.views} view${link.views === 1 ? '' : 's'}${
                        link.lastViewedAt ? `, last ${timeAgo(link.lastViewedAt)}` : ''
                      }`}
                </span>

                {/*
                  Whether the app sent it, and to whom.
                  Absent rather than "not sent" when the list is empty: a link somebody copied and
                  pasted themselves was sent perfectly well, and this has no way of knowing.
                */}
                {link.reminder?.everyDays ? (
                  <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
                    <BellRing size={12} />
                    {`chasing every ${link.reminder.everyDays} days${
                      link.reminder.sent ? `, ${link.reminder.sent} sent` : ''
                    }`}
                  </span>
                ) : null}

                {link.sentTo?.length ? (
                  <span
                    className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle"
                    title={link.sentTo.map((person) => person.email).join(', ')}
                  >
                    <Send size={12} />
                    {link.sentTo.length === 1
                      ? `sent to ${link.sentTo[0].email} ${timeAgo(link.sentTo[0].at)}`
                      : `sent to ${link.sentTo.length} people ${timeAgo(link.sentTo[0].at)}`}
                  </span>
                ) : null}

                {link.live ? (
                  <Badge tone="success">live</Badge>
                ) : (
                  <Badge tone="neutral">{link.revokedAt ? 'withdrawn' : 'expired'}</Badge>
                )}

                {editable && link.live ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={ShieldOff}
                    title="Stop this link working"
                    className="hover:text-crit"
                    onClick={() => setPendingRevoke(link)}
                  >
                    Withdraw
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-center text-xs text-fg-muted">
            No links yet. One is usually worth making when the report goes out.
          </p>
        )}
      </CardBody>

      <ConfirmDialog
        open={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        onConfirm={revoke}
        title="Withdraw this link?"
        confirmLabel="Withdraw it"
        message={`${
          pendingRevoke?.label || 'That link'
        } stops working immediately. Anybody who has it will see that it is no longer valid, and you can make another.`}
      />
    </Card>
  );
}
