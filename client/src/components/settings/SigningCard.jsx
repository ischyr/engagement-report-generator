import { useState } from 'react';
import { Download, FileSignature, KeyRound, RefreshCw, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { downloadBlob, filenameFromResponse, formatDateTime } from '../../lib/utils.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Alert } from '../ui/Alert.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';

/**
 * The key that lets a client prove a report came from here.
 *
 * Not a toggle, because there is nothing to switch: either a key exists and every report is signed,
 * or none does and nothing is. So the card shows the key it has, and the two things you can do to
 * it are generate and remove.
 *
 * The fingerprint is the whole interface. It is what somebody reads down a phone to a client once,
 * and after that every document that client is sent checks itself. So it is the largest thing here,
 * in a font you can read a character at a time.
 */
export default function SigningCard({ value, onGenerated }) {
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const key = value ?? {};
  const has = Boolean(key.fingerprint);

  const generate = async (replace = false) => {
    setWorking(true);
    try {
      const next = await api.post('/settings/signing/key', { replace });
      onGenerated?.(next);
      toast.success(
        replace ? 'A new signing key' : 'Signing is on',
        'Every report generated from now on is signed. Send the public key to your clients once.'
      );
      setReplacing(false);
    } catch (error) {
      toast.fromError(error, 'Could not generate a key');
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    setWorking(true);
    try {
      const answer = await api.del('/settings/signing/key');
      onGenerated?.({ enabled: false, fingerprint: '' });
      toast.success(
        'Signing is off',
        answer?.orphaned
          ? `${answer.orphaned} signed ${
              answer.orphaned === 1 ? 'document' : 'documents'
            } can no longer be checked against a key published from here.`
          : 'Reports will go out unsigned.'
      );
      setRemoving(false);
    } catch (error) {
      toast.fromError(error, 'Could not remove the key');
    } finally {
      setWorking(false);
    }
  };

  const downloadKey = async () => {
    try {
      const response = await api.raw('/settings/signing/public-key');
      downloadBlob(await response.blob(), filenameFromResponse(response, 'engy-signing-key.pub.pem'));
    } catch (error) {
      toast.fromError(error, 'Could not download the public key');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={FileSignature}
        title="Signing the deliverable"
        description="Signs every report with a key that never leaves this server, so a client can prove the document came from you and has not been altered. The delivery register proves which file you sent; this proves it to somebody who does not have to trust the register."
      />
      <CardBody className="flex flex-col gap-4">
        {has ? (
          <>
            <div className="rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-3">
              <p className="flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
                <KeyRound size={12} />
                Fingerprint
              </p>
              {/*
                Breakable, because it is read aloud and pasted into a phone call. A fingerprint
                that runs off the side of a card is one nobody checks.
              */}
              <p className="mt-1.5 break-all font-mono text-xs text-fg">{key.fingerprint}</p>
              <p className="mt-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
                Ed25519
                {key.createdAt ? `, generated ${formatDateTime(key.createdAt)}` : ''}. Confirm this
                with each client once, by a route that is not email, and every document they receive
                from then on checks itself.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={Download} onClick={downloadKey}>
                Public key
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                onClick={() => setReplacing(true)}
                disabled={working}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                className="text-crit hover:text-crit"
                onClick={() => setRemoving(true)}
                disabled={working}
              >
                Remove
              </Button>
            </div>

            <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
              The signature for a report is on its Delivery tab, as a small archive holding the
              signature, this key and a page of instructions for whoever receives it.
            </p>
          </>
        ) : (
          <>
            <Alert tone="info" title="No key yet">
              Reports are going out unsigned. Generating a key takes a moment and changes nothing
              about the documents themselves: the signature is a separate small file, and a client
              who ignores it sees no difference.
            </Alert>
            <div>
              <Button icon={KeyRound} onClick={() => generate(false)} loading={working}>
                Generate a signing key
              </Button>
            </div>
            <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
              The private half is encrypted with your <span className="font-mono">VAULT_KEY</span>{' '}
              and never leaves this server. Without a vault key configured, this cannot store one.
            </p>
          </>
        )}
      </CardBody>

      {/*
        Replacing is the destructive one, and the wording says what is actually lost: not the old
        documents, and not their signatures, but the ability to hand anybody the key that checks
        them. That distinction is the difference between a shrug and a phone call to every client.
      */}
      <ConfirmDialog
        open={replacing}
        onClose={() => setReplacing(false)}
        onConfirm={() => generate(true)}
        loading={working}
        title="Replace the signing key?"
        confirmLabel="Replace it"
        tone="danger"
        message={
          'Every report already signed keeps its signature, and those signatures stay valid. But ' +
          'they were made with this key, and the public key published from here will be the new ' +
          'one: clients holding the old key will need the new one, and anything they check with ' +
          'the old one will fail until they have it.'
        }
      />

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={remove}
        loading={working}
        title="Remove the signing key?"
        confirmLabel="Remove it"
        tone="danger"
        message={
          'Reports will go out unsigned, and the key that checks the ones already sent will no ' +
          'longer be available from here. Both halves are forgotten, and this cannot be undone.'
        }
      />
    </Card>
  );
}
