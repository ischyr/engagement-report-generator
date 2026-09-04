import { useEffect, useMemo, useState } from 'react';
import { Mail, Paperclip, Plus, Send, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Textarea, Toggle } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Sends the report to the client, from here.
 *
 * The difference between this and the form beside it is which way round the facts travel. Recording
 * a delivery by hand is somebody telling the app what they did in their mail client, from memory,
 * with a hash they had to copy across. This *is* the sending — so the version, the filename, the
 * hash, the size and who actually received it are observed, and the register stops depending on
 * anybody's discipline.
 *
 * The report is rendered fresh at the moment of sending rather than reusing whatever this browser
 * last downloaded. A file in a downloads folder is not evidence of anything, and the bytes that go
 * to the client should be the bytes the register hashes.
 */
export default function SendReportDialog({ open, onClose, audit, contacts, suggestedVersion, onSent }) {
  const toast = useToast();
  /* Only while the dialog is open: it exists to say whether mail is configured at all. */
  const settings = useResource(open ? '/settings' : null, { initial: null });

  const [recipients, setRecipients] = useState([]);
  const [version, setVersion] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [copyToMe, setCopyToMe] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRecipients(contacts.filter((contact) => contact.email));
    setVersion(suggestedVersion ?? '');
    setSubject('');
    setMessage('');
  }, [open, contacts, suggestedVersion]);

  const mail = settings.data?.email;
  const ready = Boolean(mail?.enabled && (mail?.configured ?? true));
  const usable = useMemo(
    () => recipients.filter((entry) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(entry.email ?? '').trim())),
    [recipients]
  );

  const send = async () => {
    setSending(true);
    try {
      const result = await api.post(`/audits/${audit._id}/deliveries/send`, {
        recipients: usable.map((entry) => ({
          client: entry.client || undefined,
          name: entry.name ?? '',
          email: entry.email,
        })),
        version: version.trim(),
        subject: subject.trim(),
        message,
        copyToMe,
      });
      const refused = result.sent?.rejected ?? [];
      if (refused.length) {
        /*
         * A partial send is recorded and reported, not hidden. Three of four addresses reaching
         * the client is a fact worth having, and so is which one did not.
         */
        toast.warning(
          'Sent, but not to everybody',
          `${refused.map((entry) => entry.address).join(', ')} was refused by the mail server.`
        );
      } else {
        toast.success('The report was sent', `To ${result.sent?.accepted?.length ?? 0} recipient(s)`);
      }
      onSent?.(result);
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send the report"
      description="Renders the report as it stands, emails it to the client and records the delivery — version, hash and all."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Send}
            loading={sending}
            disabled={!ready || !usable.length}
            onClick={send}
          >
            {usable.length > 1 ? `Send to ${usable.length} people` : 'Send it'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {settings.loading ? null : !ready ? (
          <Alert tone="warning" icon={Mail} title="This instance cannot send email yet">
            An administrator needs to fill in a mail server under <strong>Settings → Email</strong>.
            Until then, generate the report and record the delivery by hand.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-fg">Recipients</p>
          {recipients.map((entry, index) => (
            <div key={`${entry.client ?? 'manual'}-${index}`} className="flex items-end gap-2">
              <Input
                placeholder="Name"
                value={entry.name ?? ''}
                onChange={(event) => {
                  const next = [...recipients];
                  next[index] = { ...next[index], name: event.target.value };
                  setRecipients(next);
                }}
                wrapperClassName="w-44"
              />
              <Input
                placeholder="name@client.example"
                value={entry.email ?? ''}
                onChange={(event) => {
                  const next = [...recipients];
                  next[index] = { ...next[index], email: event.target.value };
                  setRecipients(next);
                }}
                wrapperClassName="flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                icon={Trash2}
                title="Remove"
                className="mb-0.5 hover:text-crit"
                onClick={() => setRecipients(recipients.filter((_, i) => i !== index))}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            className="self-start"
            onClick={() => setRecipients([...recipients, { name: '', email: '' }])}
          >
            Add someone
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <Input
            label="Version"
            placeholder="1.0"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            hint="Blank takes the next one."
          />
          <Input
            label="Subject"
            placeholder={`${audit.name} — report${version ? ` version ${version}` : ''}`}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>

        <Textarea
          label="Covering note"
          rows={5}
          placeholder="As discussed — the report for the assessment that finished on Friday. Two criticals, both already fixed."
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          hint="Your own words. The attachment, its name and its SHA-256 are added underneath."
        />

        <Toggle
          checked={copyToMe}
          onChange={setCopyToMe}
          label="Send me a copy"
          hint="Most people keep their own record of what went out."
        />

        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <Paperclip size={13} className="shrink-0" />
          The report is generated when you press send, so it goes as it stands right now.
        </p>
      </div>
    </Modal>
  );
}
