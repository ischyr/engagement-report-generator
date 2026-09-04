import { useMemo, useState } from 'react';
import { Copy, Info, PenLine, ShieldCheck, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDate, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input } from '../ui/Field.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import SignaturePad from './SignaturePad.jsx';

/** What people sign a pentest report as. Free text, because every firm words it differently. */
const ROLE_SUGGESTIONS = ['Tested by', 'Reviewed by', 'Approved by', 'Quality assured by'];

const todayIso = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/**
 * Where the team signs the engagement.
 *
 * Reports end with a page of names, and a name typed by whoever generated the document is not a
 * signature. Each person draws their own here and the report prints it as a real image.
 *
 * Deliberately separate from sign-off. Approving a report is assurance about its text, tracked
 * with a fingerprint so a signature given before a rewrite stops counting; this is a mark for
 * the document. Keeping them apart means a drawing cannot be mistaken for governance.
 */
export default function SignaturesTab({ audit, editable }) {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/signatures`, {
    initial: null,
  });

  const me = String(user?.id ?? user?._id ?? '');
  const signatures = data?.signatures ?? [];
  /** The caller's own most recent signature from another engagement, if they have one. */
  const previous = data?.previous ?? null;
  const mine = signatures.find((entry) => String(entry.user?._id ?? entry.user) === me) ?? null;

  const [drawing, setDrawing] = useState(null);
  /**
   * Whether the pending signature was drawn now or reused from a previous engagement.
   *
   * Tracked so the pane can say which it is about to save: a reused image with an empty pad
   * underneath it would otherwise look like nothing is going to happen.
   */
  const [reused, setReused] = useState(false);
  const [form, setForm] = useState({ role: '', title: '', statement: '', signedOn: todayIso() });
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [open, setOpen] = useState(false);

  /** Who on the team has not signed — the reason somebody opens this tab. */
  const missing = useMemo(() => {
    const signed = new Set(signatures.map((entry) => String(entry.user?._id ?? entry.user)));
    const team = new Map();
    for (const member of [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]) {
      const id = String(member?._id ?? member ?? '');
      if (id && !signed.has(id) && typeof member === 'object') team.set(id, member);
    }
    return [...team.values()];
  }, [signatures, audit.creator, audit.collaborators, audit.reviewers]);

  const startSigning = () => {
    // Your own last wording is the best guess, then whatever you used elsewhere.
    setForm({
      role: mine?.role ?? previous?.role ?? '',
      title: mine?.title ?? previous?.title ?? user?.title ?? '',
      statement: mine?.statement ?? previous?.statement ?? '',
      signedOn: todayIso(),
    });
    setDrawing(null);
    setReused(false);
    setOpen(true);
  };

  const save = async () => {
    if (!drawing) return;
    setSaving(true);
    try {
      await api.post(`/audits/${audit._id}/signatures`, { image: drawing, ...form });
      setOpen(false);
      setDrawing(null);
      setReused(false);
      await reload({ quiet: true });
      toast.success(mine ? 'Signature replaced' : 'Signed', 'It prints on the report as an image.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/audits/${audit._id}/signatures/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Signature removed');
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading the signatures…" />;

  return (
    <div className="flex flex-col gap-4">
      {/* The boundary, said once and plainly: this is not the approval. */}
      <p className="flex items-start gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
        <Info size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
        <span>
          A signature here is your hand on the document — the report prints it as an image on the
          sign-off page. It is not the same as approving the report: that is the sign-off card on
          the Overview, which tracks whether your approval still covers the text as it stands.
        </span>
      </p>

      <Card>
        <CardHeader
          icon={PenLine}
          title="Signatures"
          description="Everyone signs their own. Nobody — not even an admin — can draw somebody else's; that is the only thing that makes a mark worth having."
          actions={
            editable ? (
              <Button variant="primary" size="sm" icon={PenLine} onClick={startSigning}>
                {mine ? 'Sign again' : 'Sign'}
              </Button>
            ) : null
          }
        />

        {signatures.length === 0 ? (
          <EmptyState
            icon={PenLine}
            title="Nobody has signed yet"
            description="Draw your signature and the report can print it under your name, with your title and the date, instead of a typed line."
            actionLabel={editable ? 'Sign' : undefined}
            actionIcon={PenLine}
            onAction={editable ? startSigning : undefined}
          />
        ) : (
          <CardBody className="grid gap-3 sm:grid-cols-2">
            {signatures.map((entry) => {
              const isMine = String(entry.user?._id ?? entry.user) === me;
              return (
                <div
                  key={entry._id}
                  className="flex flex-col gap-2 rounded-lg border border-line-soft bg-canvas/40 p-3"
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar user={entry.user} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{entry.name}</span>
                        {isMine ? <Badge tone="brand">you</Badge> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[0.6875rem] text-fg-subtle">
                        {[entry.title, entry.role].filter(Boolean).join(' · ') || 'No title given'}
                      </span>
                    </span>
                    {editable && (isMine || isAdmin) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title={isMine ? 'Remove your signature' : `Remove ${entry.name}'s signature`}
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(entry)}
                      />
                    ) : null}
                  </div>

                  {/* White, because that is the paper it is printed on. */}
                  <div className="rounded-md bg-white p-2">
                    <img
                      src={entry.image}
                      alt={`Signature of ${entry.name}`}
                      className="mx-auto h-20 object-contain"
                    />
                  </div>

                  {entry.statement ? (
                    <p className="text-[0.6875rem] leading-relaxed text-fg-muted">
                      {entry.statement}
                    </p>
                  ) : null}
                  <p className="text-[0.625rem] text-fg-subtle" title={formatDateTime(entry.signedAt)}>
                    Signed {formatDate(entry.signedOn)}
                  </p>
                </div>
              );
            })}
          </CardBody>
        )}

        {missing.length ? (
          <CardBody className="border-t border-line-soft">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-fg-subtle">
              <ShieldCheck size={12} className="shrink-0" />
              Not signed yet:
              {missing.map((member) => (
                <span key={member._id} className="text-fg-muted">
                  {displayName(member)}
                </span>
              ))}
            </p>
          </CardBody>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------ signing */}
      {open ? (
        <Card>
          <CardHeader
            icon={PenLine}
            title={mine ? 'Sign again' : 'Sign this engagement'}
            description="Signing again replaces your own mark rather than adding a second one."
          />
          <CardBody className="flex flex-col gap-4">
            {/*
              The one you drew last time, offered rather than imposed.
              Signing is still an act: it takes a click, and drawing a fresh one replaces it.
            */}
            {previous ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5">
                <span className="rounded-md bg-white p-1.5">
                  <img
                    src={previous.image}
                    alt="Your signature from a previous engagement"
                    className="h-10 object-contain"
                  />
                </span>
                <span className="min-w-0 flex-1 text-[0.6875rem] leading-relaxed text-fg-muted">
                  You signed another engagement with this
                  {previous.signedOn ? ` on ${formatDate(previous.signedOn)}` : ''}. Reuse it, or
                  draw a new one below — whichever you do last is what gets saved.
                </span>
                <Button
                  variant={reused ? 'primary' : 'secondary'}
                  size="sm"
                  icon={Copy}
                  onClick={() => {
                    setDrawing(previous.image);
                    setReused(true);
                  }}
                >
                  {reused ? 'Reusing this' : 'Reuse it'}
                </Button>
              </div>
            ) : null}

            <SignaturePad
              onChange={(image) => {
                setDrawing(image);
                // Drawing after reusing means the drawing wins, and the label has to follow.
                if (image) setReused(false);
              }}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="Signing as"
                placeholder="Tested by"
                list="signature-roles"
                hint="How the report introduces you."
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value })}
              />
              <datalist id="signature-roles">
                {ROLE_SUGGESTIONS.map((role) => (
                  <option key={role} value={role} />
                ))}
              </datalist>
              <Input
                label="Title"
                placeholder="Senior Security Consultant"
                hint="Captured as it is now, so a later promotion cannot re-title a signed document."
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
              <Input
                label="Date"
                type="date"
                value={form.signedOn}
                onChange={(event) => setForm({ ...form, signedOn: event.target.value })}
              />
            </div>

            <Input
              label="Statement above the signature"
              placeholder="I confirm the testing described in this report was carried out as stated."
              value={form.statement}
              onChange={(event) => setForm({ ...form, statement: event.target.value })}
            />

            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setDrawing(null);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              {drawing ? (
                <span className="text-[0.625rem] text-fg-subtle">
                  {reused ? 'Reusing your previous signature' : 'Saving what you drew above'}
                </span>
              ) : null}
              <Button
                variant="primary"
                icon={PenLine}
                loading={saving}
                disabled={!drawing}
                className="ml-auto"
                onClick={save}
              >
                {mine ? 'Replace my signature' : 'Save my signature'}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
        Templates print these with <code className="font-mono">{'{{@rich.signatures}}'}</code> — the
        whole block, each signature as a real image with the name, title, role and date under it —
        or lay them out themselves with the <code className="font-mono">signatures</code> loop.
      </p>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this signature?"
        message={`${pendingDelete?.name}'s signature disappears from the report. They can sign again themselves; nobody else can do it for them.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
