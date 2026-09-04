import { useState } from 'react';
import { Copy, Eye, Link2, Plus, ShieldOff } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Toggle } from '../ui/Field.jsx';
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

  const [making, setMaking] = useState(false);
  const [draft, setDraft] = useState({ label: '', days: 30, allowUpdates: true });
  const [fresh, setFresh] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [busy, setBusy] = useState(false);

  const links = data?.links ?? [];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const create = async () => {
    setBusy(true);
    try {
      const made = await api.post(`/share/link/${audit._id}`, {
        label: draft.label.trim(),
        days: Number(draft.days),
        allowUpdates: draft.allowUpdates,
      });
      setFresh(`${origin}${made.path}`);
      setMaking(false);
      setDraft({ label: '', days: 30, allowUpdates: true });
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
        description="A private page showing this engagement's findings and letting them mark what they have fixed. No account, no password — so it expires, and you can withdraw it."
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
            <p className="mt-2 text-[0.6875rem] text-fg-subtle">
              Only a hash of it is stored, so it cannot be shown again. Send it the way you would
              send the report.
            </p>
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
          <Toggle
            checked={draft.allowUpdates}
            onChange={(allowUpdates) => setDraft({ ...draft, allowUpdates })}
            label="They can mark findings as fixed"
            hint="Off makes it read-only — for somebody who should see the position and not change it, like their auditor."
          />
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
                    {link.allowUpdates ? '' : ' · read-only'}
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
