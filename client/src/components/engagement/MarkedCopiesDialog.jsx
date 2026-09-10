import { useState } from 'react';
import { Fingerprint, Plus, Trash2, UserRound } from 'lucide-react';

import { api } from '../../lib/api.js';
import { downloadBlob, filenameFromResponse } from '../../lib/utils.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * One copy of the report per recipient, each marked with the name of the person it is for.
 *
 * ## What it is for
 *
 * A report that turns up somewhere it should not. The register already answers "is this the file we
 * sent" from its hash, and stops there: four people were sent the same bytes, so the answer is four
 * names. A copy each turns that into one name.
 *
 * It is a deterrent, not a control, and the wording here says so rather than overselling it —
 * anybody can open a .docx and delete a line. What it defends against is the ordinary case, which
 * is a file forwarded without a thought.
 *
 * ## Why the recipients are typed rather than picked
 *
 * They are prefilled from the engagement's contacts, because that is usually who it goes to, and
 * they are editable because the person sending it is the one who knows whether it is going to the
 * three contacts on file or to two of them and somebody's auditor.
 */
export default function MarkedCopiesDialog({ open, onClose, audit, contacts = [], onRecorded }) {
  const toast = useToast();
  const [rows, setRows] = useState(() =>
    (contacts.length ? contacts : [{ name: '', email: '' }]).map((entry) => ({
      client: entry._id ?? null,
      name: [entry.firstname, entry.lastname].filter(Boolean).join(' ') || entry.name || '',
      email: entry.email ?? '',
    }))
  );
  const [version, setVersion] = useState('');
  const [working, setWorking] = useState(false);

  const named = rows.filter((row) => row.name.trim());

  const make = async () => {
    setWorking(true);
    try {
      const response = await api.raw(`/audits/${audit._id}/report/copies`, {
        method: 'POST',
        body: {
          recipients: named.map((row) => ({
            client: row.client || undefined,
            name: row.name.trim(),
            email: row.email.trim() || undefined,
          })),
          version: version.trim() || undefined,
          record: true,
        },
      });

      downloadBlob(await response.blob(), filenameFromResponse(response, 'copies.zip'));

      /*
       * Whether the marking reached the page, said plainly.
       *
       * Every copy is traceable through its own hash and the document's properties whatever the
       * template does. Whether it *says* whose it is depends on the template using the copy line,
       * and a tester who believes in a watermark that is not there is worse off than one who knows.
       */
      const marked = response.headers.get('X-Engy-Copies-Marked') === 'true';
      toast.success(
        `${named.length} marked ${named.length === 1 ? 'copy' : 'copies'}`,
        marked
          ? 'Each one names its recipient on every page, and the register can trace any of them back.'
          : 'Recorded and traceable by hash, but your template does not print the copy line, so none of them says whose it is on the page.'
      );
      onRecorded?.();
      onClose();
    } catch (error) {
      toast.fromError(error, 'Could not make the copies');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="A marked copy for each recipient"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={make} loading={working} disabled={!named.length}>
            {named.length ? `Make ${named.length} ${named.length === 1 ? 'copy' : 'copies'}` : 'Make copies'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Alert tone="info" icon={Fingerprint} title="What this does">
          Each person gets their own document, marked with their name and hashed separately. If one
          of them turns up where it should not, the register names the copy it came from. It is a
          deterrent rather than a lock: the line can be deleted by somebody who thinks to.
        </Alert>

        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-2 w-5 shrink-0 text-center font-mono text-[0.6875rem] text-fg-subtle">
                {index + 1}
              </span>
              <Input
                wrapperClassName="flex-1"
                placeholder="Name, as it should appear on their copy"
                value={row.name}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry
                    )
                  )
                }
              />
              <Input
                wrapperClassName="flex-1"
                placeholder="Email (optional)"
                value={row.email}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, email: event.target.value } : entry
                    )
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                icon={Trash2}
                title="Remove"
                className="mt-1"
                onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
              />
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={Plus}
              onClick={() => setRows((current) => [...current, { client: null, name: '', email: '' }])}
            >
              Another recipient
            </Button>
          </div>
        </div>

        <Input
          label="Version"
          hint="What the client will call it. Recorded against all of these copies, because they are one act of sending."
          placeholder="1.0"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
        />

        <p className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-fg-subtle">
          <UserRound size={12} className="mt-0.5 shrink-0" />
          The archive holds one document per person, a signature for each if a signing key is
          configured, and a list of which hash belongs to whom. The delivery is recorded as sent.
        </p>
      </div>
    </Modal>
  );
}
