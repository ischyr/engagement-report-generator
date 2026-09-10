import { useMemo, useState } from 'react';
import {
  CircleAlert,
  FileWarning,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  ShieldOff,
  Trash2,
  Undo2,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea, Toggle } from '../ui/Field.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Alert } from '../ui/Alert.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import { RichTextEditor } from '../editor/RichTextEditor.jsx';

/**
 * What the test changed on somebody else's system.
 *
 * Testing is not read-only. You disable a control to see what happens, you PATCH an object you do
 * not own to prove that you can, you upload a file to find out whether it is executed, you delete a
 * row to see whether the API checks ownership before or after. All of that is the work, and until
 * this tab existed none of it was written down anywhere the client could be told about or the team
 * could clean up: it lived in somebody's shell history and a message that began "sorry".
 *
 * ## The three fields that make this more than a notes tab
 *
 * **Before** is what somebody types back in. It is plain text, and deliberately so — what is wanted
 * is something copy-and-pasteable at three in the morning, not something that looks nice.
 *
 * **After** is what it is now, so the person doing the cleanup can tell whether they are looking at
 * their own change or somebody else's.
 *
 * **Put back** is the one that matters at the end of a job. Preflight refuses to approve a report
 * while anything reversible is still standing, which turns "we think we tidied up" into something
 * the app will not let you skip.
 *
 * ## The order of the list
 *
 * Outstanding first, always, whatever order they were recorded in. This screen is read twice: while
 * working, when the newest matters, and at the end of a job, when the unfinished matters. The second
 * is the one that goes wrong.
 */
const ACTIONS = [
  { value: 'created', label: 'Created' },
  { value: 'modified', label: 'Modified' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'executed', label: 'Executed' },
  { value: 'disabled', label: 'Disabled or bypassed' },
  { value: 'other', label: 'Something else' },
];

const EMPTY = {
  title: '',
  action: 'modified',
  target: '',
  host: '',
  before: '',
  after: '',
  revertPlan: '',
  notes: '',
  at: '',
  authorisedBy: '',
  reversible: true,
  print: true,
  credentialsUsed: [],
};

export default function IntrusiveTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/intrusions`, { initial: [] });
  const credentials = useResource(`/audits/${audit._id}/credentials`, { initial: null });

  /**
   * The accounts, out of the envelope.
   *
   * That endpoint answers `{ enabled, disabledReason, credentials }` rather than a bare array,
   * because whether the vault is switched on at all is part of what a caller needs to know.
   * Treating the envelope as the list is the kind of mistake that costs nothing until an
   * engagement has one credential, and then throws during render and blanks the page.
   *
   * Both shapes accepted, so this keeps working if the endpoint is ever simplified.
   */
  const accounts = useMemo(() => {
    const answer = credentials.data;
    if (Array.isArray(answer)) return answer;
    return Array.isArray(answer?.credentials) ? answer.credentials : [];
  }, [credentials.data]);

  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);

  const rows = useMemo(() => {
    const list = Array.isArray(data) ? [...data] : [];
    /* Outstanding first, then irreversible, then everything already put back. */
    const rank = (entry) => {
      if (!entry.revertedAt && entry.reversible !== false) return 0;
      if (entry.reversible === false) return 1;
      return 2;
    };
    return list.sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0));
  }, [data]);

  const outstanding = rows.filter((entry) => !entry.revertedAt && entry.reversible !== false);
  const irreversible = rows.filter((entry) => entry.reversible === false);

  const save = async () => {
    if (!draft) return;
    if (!draft.title.trim() && !draft.target.trim()) {
      toast.error('Say what it was', 'A title or a target — something to find it again by.');
      return;
    }
    setBusy(true);
    try {
      const body = { ...draft };
      if (draft._id) await api.put(`/audits/${audit._id}/intrusions/${draft._id}`, body);
      else await api.post(`/audits/${audit._id}/intrusions`, body);
      setDraft(null);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error, 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  const revert = async (entry, undo = false) => {
    setBusy(true);
    try {
      await api.post(`/audits/${audit._id}/intrusions/${entry._id}/revert`, { undo });
      await reload({ quiet: true });
      if (!undo) {
        toast.success(
          'Marked as put back',
          outstanding.length === 1
            ? 'That was the last one outstanding.'
            : `${outstanding.length - 1} still to undo.`
        );
      }
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/audits/${audit._id}/intrusions/${removing._id}`);
      setRemoving(null);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingBlock />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={ShieldOff}
          title="What we changed"
          description="Everything this test created, modified or deleted on the client's systems, with the value it had before so it can be put back. It prints as an appendix, and the report cannot be approved while anything reversible is still standing."
          actions={
            editable ? (
              <Button size="sm" icon={Plus} onClick={() => setDraft({ ...EMPTY })}>
                Record a change
              </Button>
            ) : null
          }
        />

        {outstanding.length ? (
          <CardBody>
            {/*
              The one thing this screen exists to say. Loud, above everything, and counted:
              at the end of a job this is the list somebody walks down.
            */}
            <Alert
              tone="warning"
              icon={CircleAlert}
              title={`${outstanding.length} ${outstanding.length === 1 ? 'change has' : 'changes have'} not been put back`}
            >
              The report cannot be approved until each one is reverted, or marked as something that
              cannot be undone so the client is told about it instead.
            </Alert>
          </CardBody>
        ) : null}
      </Card>

      {draft ? (
        <Card>
          <CardHeader
            icon={draft._id ? Pencil : Plus}
            title={draft._id ? 'Edit the change' : 'A change we made'}
            description="Enough that somebody else could undo it without asking you."
          />
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="What was it"
                placeholder="Disabled MFA on the test user"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
              <Select
                label="What did you do"
                value={draft.action}
                onChange={(event) => setDraft({ ...draft, action: event.target.value })}
              >
                {ACTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Input
                label="Where"
                hint="The endpoint, object or path — exactly enough to find it again."
                placeholder="PATCH /api/users/4471/mfa"
                value={draft.target}
                onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              />
              <Input
                label="Host"
                placeholder="portal.example.com"
                value={draft.host}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {/*
                Plain text, both of them, and the labels say why. This is the field somebody reads
                at the end of a long day with a terminal open beside it.
              */}
              <Textarea
                label="The value before"
                hint="What somebody types back in. Paste the body, the field, the setting."
                rows={4}
                className="font-mono text-xs"
                value={draft.before}
                onChange={(event) => setDraft({ ...draft, before: event.target.value })}
              />
              <Textarea
                label="And after"
                hint="What it is now, so the next person knows whose change they are looking at."
                rows={4}
                className="font-mono text-xs"
                value={draft.after}
                onChange={(event) => setDraft({ ...draft, after: event.target.value })}
              />
            </div>

            <Textarea
              label="How to put it back"
              hint="Only when the old value is not enough on its own."
              rows={2}
              value={draft.revertPlan}
              onChange={(event) => setDraft({ ...draft, revertPlan: event.target.value })}
            />

            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-muted">
                What happened, and what it looked like
              </p>
              {/* The same editor as a finding, so a screenshot pastes straight in. */}
              <RichTextEditor
                value={draft.notes}
                onChange={(html) => setDraft({ ...draft, notes: html })}
                editable={editable}
                minHeight={200}
                placeholder="Paste the screenshot of how the endpoint behaved."
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="When"
                placeholder="22 Jul 2026, 14:10"
                value={draft.at}
                onChange={(event) => setDraft({ ...draft, at: event.target.value })}
              />
              <Input
                label="Who agreed to it"
                hint="For the ones that needed asking. Their name, not ours."
                placeholder="Marijke de Vries"
                value={draft.authorisedBy}
                onChange={(event) => setDraft({ ...draft, authorisedBy: event.target.value })}
              />
              <Select
                label="Which account"
                hint="What it was done with, for the credentials appendix."
                value={draft.credentialsUsed?.[0] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    credentialsUsed: event.target.value ? [event.target.value] : [],
                  })
                }
              >
                <option value="">Not with a borrowed account</option>
                {accounts.map((credential) => (
                  <option key={credential._id} value={credential._id}>
                    {credential.label}
                    {credential.username ? ` (${credential.username})` : ''}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Toggle
                checked={draft.reversible}
                onChange={(next) => setDraft({ ...draft, reversible: next })}
                label="This can be undone"
                hint="Off for something that cannot: a deleted row with no backup. The report says so rather than implying it was tidied up."
              />
              <Toggle
                checked={draft.print}
                onChange={(next) => setDraft({ ...draft, print: next })}
                label="Include it in the report"
                hint="Off for changes to our own infrastructure, which are not the client's business."
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={save} loading={busy}>
                {draft._id ? 'Save' : 'Record it'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={FileWarning}
          title="Nothing changed yet"
          description="Record anything this test creates, modifies or deletes on the client's systems, with the value it had before. It becomes the cleanup list at the end of the job and an appendix in the report — the one a client's operations team reads before they sign it off."
          actionLabel={editable ? 'Record a change' : undefined}
          actionIcon={Plus}
          onAction={editable ? () => setDraft({ ...EMPTY }) : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((entry) => {
            const done = Boolean(entry.revertedAt);
            const cannot = entry.reversible === false;
            return (
              <Card key={entry._id} className={cn(done && 'opacity-70')}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{entry.title || entry.target || 'An untitled change'}</span>
                      <Badge tone={done ? 'success' : cannot ? 'danger' : 'warning'}>
                        {done ? 'Put back' : cannot ? 'Cannot be undone' : 'Still standing'}
                      </Badge>
                      {entry.print === false ? <Badge tone="neutral">Not in the report</Badge> : null}
                    </span>
                  }
                  description={
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                      <span>{ACTIONS.find((a) => a.value === entry.action)?.label ?? entry.action}</span>
                      {entry.target ? <span className="font-mono">{entry.target}</span> : null}
                      {entry.host ? <span>on {entry.host}</span> : null}
                      {entry.at ? <span>{entry.at}</span> : null}
                      {entry.authorisedBy ? <span>agreed by {entry.authorisedBy}</span> : null}
                    </span>
                  }
                  actions={
                    editable ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {done ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Undo2}
                            onClick={() => revert(entry, true)}
                            disabled={busy}
                          >
                            Not actually
                          </Button>
                        ) : cannot ? null : (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={RotateCcw}
                            onClick={() => revert(entry)}
                            disabled={busy}
                          >
                            Put back
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Pencil}
                          title="Edit"
                          onClick={() => setDraft({ ...EMPTY, ...entry })}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Remove the record"
                          className="hover:text-crit"
                          onClick={() => setRemoving(entry)}
                        />
                      </span>
                    ) : null
                  }
                />
                <CardBody className="flex flex-col gap-3">
                  {entry.before || entry.after ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-fg-subtle">
                          Before
                        </p>
                        <pre className="overflow-x-auto rounded-lg border border-line-soft bg-canvas/60 px-3 py-2 font-mono text-[0.6875rem] text-fg-muted">
                          {entry.before || '—'}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-fg-subtle">
                          After
                        </p>
                        <pre className="overflow-x-auto rounded-lg border border-line-soft bg-canvas/60 px-3 py-2 font-mono text-[0.6875rem] text-fg-muted">
                          {entry.after || '—'}
                        </pre>
                      </div>
                    </div>
                  ) : null}

                  {entry.revertPlan && !done ? (
                    <p className="text-xs text-fg-muted">
                      <span className="font-medium text-fg">To undo:</span> {entry.revertPlan}
                    </p>
                  ) : null}

                  {entry.notes ? (
                    <div
                      className="engy-prose text-sm text-fg-muted"
                      dangerouslySetInnerHTML={{ __html: entry.notes }}
                    />
                  ) : null}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-fg-subtle">
                    {entry.credentialsUsed?.length ? (
                      <span className="flex items-center gap-1.5">
                        <KeyRound size={11} />
                        {entry.credentialsUsed
                          .map(
                            (id) =>
                              accounts.find((row) => row._id === id)?.label ??
                              'an account since removed'
                          )
                          .join(', ')}
                      </span>
                    ) : null}
                    {done ? (
                      <span>
                        Put back {formatDateTime(entry.revertedAt)}
                        {displayName(entry.revertedBy) ? ` by ${displayName(entry.revertedBy)}` : ''}
                        {entry.revertNote ? ` — ${entry.revertNote}` : ''}
                      </span>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {irreversible.length ? (
        <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
          {irreversible.length} {irreversible.length === 1 ? 'change' : 'changes'} cannot be undone.
          Those do not block the report; they print in it, so the client is told rather than
          reassured.
        </p>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        loading={busy}
        title="Remove this record?"
        confirmLabel="Remove the record"
        tone="danger"
        message={
          'This deletes the record of the change, not the change itself. If it has not been put ' +
          'back, it will still be that way and nothing will be watching for it any more.'
        }
      />
    </div>
  );
}
