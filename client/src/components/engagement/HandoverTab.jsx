import { useState } from 'react';
import { ArrowRightLeft, KeyRound, TriangleAlert, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Textarea, Input } from '../ui/Field.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../ui/Feedback.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';

/**
 * What one tester tells the next one.
 *
 * A week-long job with two people on it runs on somebody remembering to say where they stopped, and
 * the two places that lands today are a chat message that scrolls away and the notes tab, which is
 * freeform and becomes a wall nobody reads to the bottom of. Four short fields, attributed and
 * timestamped, read newest first — which is the only order it is ever read in.
 *
 * None of it reaches a report. It is about the work, not about the target.
 */
const BLANK = { did: '', next: '', blockers: '', credentials: '' };

export default function HandoverTab({ audit, editable }) {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const { data, error, loading, reload } = useResource(`/audits/${audit._id}/handovers`, {
    initial: [],
    // A colleague ending their session is exactly the thing you want to see without reloading.
    poll: 8_000,
  });
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const entries = Array.isArray(data) ? data : [];
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const empty = !form.did.trim() && !form.next.trim() && !form.blockers.trim();

  const submit = async () => {
    setSaving(true);
    try {
      await api.post(`/audits/${audit._id}/handovers`, form);
      setForm(BLANK);
      toast.success('Handover logged');
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/audits/${audit._id}/handovers/${pendingDelete._id}`);
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    }
  };

  const mine = (entry) => String(entry.author?._id ?? entry.author) === String(user?.id);

  return (
    <div className="flex flex-col gap-5">
      {editable ? (
        <Card>
          <CardHeader
            title="End of session"
            icon={ArrowRightLeft}
            description="Written for whoever is on this job next — including you, on Monday, having forgotten all of it."
          />
          <CardBody className="flex flex-col gap-3">
            <Textarea
              label="What I did"
              rows={3}
              placeholder="Finished the authenticated crawl. Confirmed the IDOR on /documents and wrote it up as finding 01."
              value={form.did}
              onChange={(event) => set({ did: event.target.value })}
            />
            <Textarea
              label="What is next"
              rows={2}
              placeholder="The API host has not been touched. Start with the v2 invoice endpoints."
              value={form.next}
              onChange={(event) => set({ next: event.target.value })}
            />
            <Textarea
              label="In the way"
              rows={2}
              placeholder="Staging is returning 502 since about 15:00. Their ops team knows."
              value={form.blockers}
              onChange={(event) => set({ blockers: event.target.value })}
            />
            <Input
              label="Accounts used"
              placeholder="portal: test.customer@… · api: svc-scanner (read only)"
              hint="Names only. Passwords belong on the Credentials tab, which is not read by as many people as this."
              value={form.credentials}
              onChange={(event) => set({ credentials: event.target.value })}
            />
            <div className="flex items-center justify-end gap-3">
              {empty ? (
                <span className="text-xs text-fg-subtle">
                  Say what you did, what is next, or what is in the way.
                </span>
              ) : null}
              <Button variant="primary" size="sm" loading={saving} disabled={empty} onClick={submit}>
                Log the handover
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Handovers"
          description={
            entries.length
              ? `${entries.length} session${entries.length === 1 ? '' : 's'} logged, newest first.`
              : undefined
          }
        />
        {loading && !entries.length ? (
          <LoadingBlock label="Loading…" />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ArrowRightLeft}
            title="No handovers yet"
            description="At the end of a session, say what you did and what is left. It is the one thing that makes a two-person engagement work."
          />
        ) : (
          <CardBody className="flex flex-col gap-3">
            {entries.map((entry) => (
              <article
                key={entry._id}
                className="flex flex-col gap-2 rounded-xl bg-canvas/40 p-3.5 ring-1 ring-line"
              >
                <header className="flex flex-wrap items-center gap-2 text-xs">
                  <Avatar user={entry.author} size={22} />
                  <span className="font-medium text-fg">{displayName(entry.author)}</span>
                  <span className="text-fg-subtle">{timeAgo(entry.createdAt)}</span>
                  {mine(entry) || isAdmin ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Remove this entry"
                      className="ml-auto hover:text-crit"
                      onClick={() => setPendingDelete(entry)}
                    />
                  ) : null}
                </header>

                {entry.did ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{entry.did}</p>
                ) : null}

                {entry.next ? (
                  <p className="flex gap-2 whitespace-pre-wrap rounded-lg bg-brand-500/[0.07] px-3 py-2 text-sm leading-relaxed text-fg">
                    <ArrowRightLeft size={14} className="mt-0.5 shrink-0 text-brand-300" />
                    {entry.next}
                  </p>
                ) : null}

                {entry.blockers ? (
                  <p className="flex gap-2 whitespace-pre-wrap rounded-lg bg-med/10 px-3 py-2 text-sm leading-relaxed text-fg">
                    <TriangleAlert size={14} className="mt-0.5 shrink-0 text-med" />
                    {entry.blockers}
                  </p>
                ) : null}

                {entry.credentials ? (
                  <p className="flex items-start gap-2 text-xs text-fg-muted">
                    <KeyRound size={13} className="mt-0.5 shrink-0 text-fg-subtle" />
                    <span className="font-mono">{entry.credentials}</span>
                  </p>
                ) : null}
              </article>
            ))}
          </CardBody>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this handover?"
        confirmLabel="Remove"
        message="It is a record of a session that happened. Removing it does not change anything else on the engagement."
      />
    </div>
  );
}
