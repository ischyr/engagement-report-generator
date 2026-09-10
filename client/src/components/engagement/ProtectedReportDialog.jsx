import { useEffect, useState } from 'react';
import { Copy, KeyRound, Wand2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { downloadBlob, filenameFromResponse } from '../../lib/utils.js';
import { useToast } from '../../context/ToastContext.jsx';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * The report, in an archive the client needs a password to open.
 *
 * The same bytes Generate produces, wrapped in AES-256 — because the most sensitive document a
 * client receives all year was leaving here as a plain attachment on a plain mail.
 *
 * ## The password is yours to choose
 *
 * Typed, or taken from the button. The button asks the server for four words rather than assembling
 * something here: this is the one value in the flow that has to be unguessable, and the browser is
 * the wrong place to promise that. Words rather than characters because this password's whole life
 * is being read off one screen and typed into another — or dictated down a telephone, which is
 * exactly where `Tz9$kQ2v` gets transcribed wrongly.
 *
 * ## And it is not saved anywhere
 *
 * Not by the browser and not by the server: the archive is built, the file comes back, and the
 * password exists only where you put it. That is the whole point — a passphrase stored beside the
 * record of the document it opens is not a passphrase. Which also means this dialog has to say,
 * plainly, that losing it means generating the report again.
 */
export default function ProtectedReportDialog({ auditId, auditName, open, onClose, onDownloaded }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [openedWith, setOpenedWith] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [copied, setCopied] = useState(false);

  /* Cleared on every open: a password left in the box from last time is one nobody chose. */
  useEffect(() => {
    if (open) {
      setPassword('');
      setCopied(false);
    }
  }, [open]);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const answer = await api.get(`/audits/${auditId}/report/passphrase`);
      setPassword(answer.passphrase ?? '');
      setOpenedWith(answer.openedWith ?? '');
      setCopied(false);
    } catch (error) {
      toast.fromError(error, 'Could not suggest a passphrase');
    } finally {
      setSuggesting(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      /* A browser that refuses the clipboard is one where the box is selectable instead. */
      toast.info('Copy it from the box', 'This browser would not let the page use the clipboard.');
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      /*
       * A POST, because a password must not be in a URL — the browser's history, any proxy's log
       * and this server's own request line would all have it. The file comes back in the response.
       */
      const response = await api.raw(`/audits/${auditId}/report/protected`, {
        method: 'POST',
        /* An object: `request` serialises it and sets the content type. */
        body: { password },
      });
      const blob = await response.blob();
      const filename = filenameFromResponse(response, `${auditName ?? 'report'}.docx.zip`);
      downloadBlob(blob, filename);

      /* The digest of the archive, which is the artefact that leaves — the Delivery tab prefills. */
      const hash = response.headers.get('X-Report-Sha256');
      onDownloaded?.({
        filename,
        hash: hash ?? '',
        size: Number(response.headers.get('X-Report-Size')) || blob.size,
        kind: 'zip',
        at: new Date().toISOString(),
      });

      toast.success('Protected report downloaded', 'Send the password by another route.');
      onClose?.();
    } catch (error) {
      toast.fromError(error, 'Could not build the protected report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Download it protected"
      description="The same report Generate produces, in an AES-256 archive. Choose a password, or take the one it offers."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={KeyRound}
            loading={busy}
            disabled={password.trim().length < 8}
            onClick={download}
          >
            Build the archive
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <Input
            label="Password"
            /*
             * Deliberately readable. Every other password box in this app is masked because
             * somebody is proving who they are; this one exists to be read off the screen and
             * passed on, and hiding it would mean typing a passphrase twice and hoping.
             */
            type="text"
            spellCheck={false}
            autoComplete="off"
            wrapperClassName="flex-1"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setCopied(false);
            }}
            placeholder="At least eight characters"
            hint="Shown rather than masked — you have to be able to pass it on."
          />
          <Button
            variant="secondary"
            size="sm"
            icon={Wand2}
            loading={suggesting}
            onClick={suggest}
            title="Four random words, from the server"
          >
            Suggest
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={Copy}
            onClick={copy}
            disabled={!password}
            title="Copy the password"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <Alert tone="warning" icon={KeyRound} title="Nobody here can recover it">
          The password is not stored — not by this app and not in the delivery record. Send it to the
          client by some route other than the one carrying the file, and keep a copy if you will need
          to open the archive again. Losing it means generating the report afresh.
        </Alert>

        {openedWith ? (
          <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
            <span className="font-medium text-fg-muted">How the client opens it: </span>
            {openedWith}
          </p>
        ) : (
          <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
            Opened with 7-Zip or WinRAR on Windows, Archive Utility on macOS, or{' '}
            <span className="font-mono">7z x</span> on Linux. Windows Explorer&rsquo;s own zip
            support cannot open AES archives.
          </p>
        )}
      </div>
    </Modal>
  );
}
