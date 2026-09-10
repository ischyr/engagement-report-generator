import { useMemo, useState } from 'react';
import { Check, Copy, KeySquare, Terminal, Trash2, TriangleAlert } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, formatDate, timeAgo } from '../../lib/utils.js';

import { Badge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Checkbox, Field, Input, Select } from '../ui/Field.jsx';
import { ConfirmDialog, Modal } from '../ui/Modal.jsx';

/**
 * The API tokens this account holds, and the one moment its secret exists.
 *
 * Beside the session list because they are the same kind of thing from a person's point of view:
 * credentials that act as you, which you should be able to see all of and end any of. The
 * differences are what this card has to make legible — a token has scopes, is tied to particular
 * engagements, lives for months rather than minutes, and is held by a script that will not notice
 * it has expired.
 *
 * The secret appears exactly once, in a dialog, and the dialog says so before it can be dismissed.
 * There is no route that could show it again — the server keeps a SHA-256 and six characters — so
 * the interface has to be honest about that at the only moment it matters.
 */
export default function ApiTokensCard() {
  const toast = useToast();
  const { data, loading, reload } = useResource('/auth/tokens', { initial: null });
  const [busy, setBusy] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [draft, setDraft] = useState(null);
  /** The secret, from the response that created it. Held in state and nowhere else. */
  const [minted, setMinted] = useState(null);
  const [copied, setCopied] = useState(false);

  const tokens = data?.tokens ?? [];
  const scopes = data?.scopes ?? [];
  const engagements = data?.engagements ?? [];
  const live = tokens.filter((token) => token.state === 'live');

  const EMPTY = useMemo(
    () => ({ label: '', scopes: [], engagements: [], days: String(data?.defaultDays ?? 90) }),
    [data?.defaultDays]
  );

  /** A scope a read-only account cannot be given, said in the interface rather than only refused. */
  const forbidden = (scope) => data?.canWrite === false && scope.endsWith(':write');

  const create = async () => {
    setBusy('create');
    try {
      const answer = await api.post('/auth/tokens', {
        label: draft.label.trim(),
        scopes: draft.scopes,
        engagements: draft.engagements,
        days: Number(draft.days),
      });
      setDraft(null);
      setCopied(false);
      setMinted(answer);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy(removing.id);
    try {
      await api.del(`/auth/tokens/${removing.id}`);
      setRemoving(null);
      toast.success('That token will not work again');
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    setBusy('all');
    try {
      const answer = await api.post('/auth/tokens/revoke-all', {});
      setRevokingAll(false);
      toast.success(
        answer.revoked === 1 ? 'One token revoked' : `${answer.revoked} tokens revoked`
      );
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      /* A refused clipboard is not worth an error: the value is on screen and selectable. */
      toast.info('Select the token and copy it');
    }
  };

  const toggle = (list, value) =>
    list.includes(value) ? list.filter((one) => one !== value) : [...list, value];

  return (
    <>
      <Card>
        <CardHeader
          icon={KeySquare}
          title="API tokens"
          description="For a script, a pipeline or a scheduled job. A token reaches the versioned API at /api/v1 and nothing else, only the engagements you name, and only the things you tick."
          actions={
            data?.canHold === false ? null : (
              <div className="flex items-center gap-2">
                {live.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setRevokingAll(true)}>
                    Revoke all
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Terminal}
                  onClick={() => setDraft(EMPTY)}
                >
                  New token
                </Button>
              </div>
            )
          }
        />
        <CardBody className="flex flex-col gap-1.5">
          {loading && !data ? (
            <p className="text-xs text-fg-subtle">Loading…</p>
          ) : data?.canHold === false ? (
            /* A sales account has a profile page too, and nothing here it could use. */
            <p className="text-xs text-fg-subtle">
              This account has access to the Sales section, and the API serves engagements — so
              there is nothing here a token of yours could reach.
            </p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              You have none. A token is how something that is not a browser talks to this
              instance — filing findings from a scanner, or reading an engagement in a build.
            </p>
          ) : (
            tokens.map((token) => (
              <div
                key={token.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5',
                  token.state === 'live'
                    ? 'border-line-soft bg-canvas/40'
                    : 'border-line-soft/60 bg-canvas/20 opacity-70'
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-fg">
                    {token.label}
                    {token.state === 'live' ? (
                      <Badge tone="success">live</Badge>
                    ) : token.state === 'expired' ? (
                      <Badge tone="warning">expired</Badge>
                    ) : (
                      <Badge tone="neutral">revoked</Badge>
                    )}
                    <code className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[0.625rem] text-fg-muted">
                      {token.preview}…
                    </code>
                  </p>
                  <p className="mt-0.5 truncate text-[0.625rem] text-fg-subtle">
                    {[
                      token.scopes.join(', ') || 'no scopes',
                      token.engagements.length
                        ? `${token.engagements.length} engagement${token.engagements.length === 1 ? '' : 's'}`
                        : 'every engagement you are on',
                      token.lastUsedAt ? `last used ${timeAgo(token.lastUsedAt)}` : 'never used',
                      token.state === 'live'
                        ? `expires ${formatDate(token.expiresAt)}`
                        : `expired ${formatDate(token.expiresAt)}`,
                    ].join(' · ')}
                  </p>
                </div>
                {token.state === 'live' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    loading={busy === token.id}
                    className="hover:text-crit"
                    onClick={() => setRemoving(token)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))
          )}

          <p
            className="mt-1 text-[0.625rem] leading-relaxed text-fg-subtle"
            hidden={data?.canHold === false}
          >
            Changing your password ends every browser session but <strong>not</strong> your tokens —
            so a routine change does not break a running pipeline. If you think one has leaked,
            revoke it here. A token can never reach more than you can: take yourself off an
            engagement and its tokens lose it too, and engagements marked restricted are not
            reachable with a token at all.
          </p>
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title="A new API token"
        description="Name it after the thing that will hold it, so this list means something in six months."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'create'}
              disabled={!draft?.label.trim() || draft?.scopes.length === 0}
              onClick={create}
            >
              Make the token
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-4">
            <Field label="What will hold it" required>
              <Input
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder="Nightly scanner on build-02"
                autoFocus
              />
            </Field>

            <Field
              label="What it may do"
              required
              hint="No scope implies another. A token that files findings cannot read them unless you tick both."
            >
              {/* `Checkbox` renders its own <label>, so the description goes in its `label`
                  prop rather than around it — a label inside a label toggles twice. */}
              <div className="flex flex-col gap-1.5">
                {scopes.map((scope) => (
                  <div
                    key={scope.name}
                    className={cn(
                      'rounded-lg border border-line-soft px-3 py-2',
                      forbidden(scope.name) && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      checked={draft.scopes.includes(scope.name)}
                      disabled={forbidden(scope.name)}
                      onChange={() =>
                        setDraft({ ...draft, scopes: toggle(draft.scopes, scope.name) })
                      }
                      label={
                        <span className="min-w-0">
                          <span className="block text-xs text-fg">{scope.label}</span>
                          <span className="block text-[0.625rem] text-fg-subtle">
                            {scope.description}
                          </span>
                          <code className="mt-0.5 block text-[0.625rem] text-fg-muted">
                            {scope.name}
                          </code>
                        </span>
                      }
                    />
                  </div>
                ))}
              </div>
              {data?.canWrite === false ? (
                <p className="mt-1.5 text-[0.625rem] text-med">
                  Your account is read-only, so a token of yours cannot be allowed to write.
                </p>
              ) : null}
            </Field>

            <Field
              label="Which engagements"
              hint="Leave every box clear and it reaches all of yours, including ones you join later. Naming them is the narrower choice."
            >
              {engagements.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  You are not on any engagement a token could reach yet.
                </p>
              ) : (
                <div className="max-h-52 overflow-y-auto rounded-lg border border-line-soft">
                  {engagements.map((engagement) => (
                    <div
                      key={engagement.id}
                      className="border-b border-line-soft/60 px-3 py-2 last:border-0"
                    >
                      <Checkbox
                        checked={draft.engagements.includes(engagement.id)}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            engagements: toggle(draft.engagements, engagement.id),
                          })
                        }
                        label={
                          <span className="min-w-0 text-xs text-fg">
                            {engagement.name}
                            {engagement.reference ? (
                              <span className="text-fg-subtle"> · {engagement.reference}</span>
                            ) : null}
                          </span>
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              {draft.engagements.length === 0 ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-[0.625rem] text-med">
                  <TriangleAlert size={12} className="mt-px shrink-0" />
                  This token will reach every engagement you are on.
                </p>
              ) : null}
            </Field>

            <Field label="How long it lives" hint="A credential with no end is one nobody removes.">
              <Select
                value={draft.days}
                onChange={(event) => setDraft({ ...draft, days: event.target.value })}
                className="max-w-52"
              >
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value={String(data?.maxDays ?? 365)}>
                  {data?.maxDays ?? 365} days — the longest allowed
                </option>
              </Select>
            </Field>
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------------------------------------------ */}
      <Modal
        open={Boolean(minted)}
        onClose={() => setMinted(null)}
        title="Copy it now"
        description="This is the only time this token is shown. Nothing here can show it again — the server keeps a hash of it and the first few characters, and that is all."
        size="lg"
        footer={
          <Button variant="primary" onClick={() => setMinted(null)}>
            {copied ? 'Done' : 'I have copied it'}
          </Button>
        }
      >
        {minted ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-canvas/60 p-3">
              <code className="min-w-0 flex-1 break-all text-xs leading-relaxed text-fg">
                {minted.token}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                icon={copied ? Check : Copy}
                title="Copy"
                onClick={copy}
                className={copied ? 'text-low' : undefined}
              />
            </div>

            <div>
              <p className="text-[0.6875rem] text-fg-muted">
                Send it as a bearer header. Nothing else on this instance accepts it, and it accepts
                nothing else.
              </p>
              <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line-soft bg-canvas/60 p-3 text-[0.625rem] leading-relaxed text-fg-muted">
                {`curl -H "Authorization: Bearer ${minted.token}" \\\n  ${window.location.origin}/api/v1/whoami`}
              </pre>
            </div>

            <p className="text-[0.625rem] leading-relaxed text-fg-subtle">
              Put it somewhere a person does not have to read — a secret store, or your runner's
              environment. It begins with <code>engy_</code> so that a scanner or a pre-commit hook
              can recognise it if it ever ends up in a repository.
            </p>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={revoke}
        loading={busy === removing?.id}
        title="Revoke this token?"
        message={
          removing
            ? `“${removing.label}” stops working immediately, and whatever holds it will start failing. It cannot be un-revoked — make a new one instead.`
            : ''
        }
        confirmLabel="Revoke it"
        tone="danger"
      />

      <ConfirmDialog
        open={revokingAll}
        onClose={() => setRevokingAll(false)}
        onConfirm={revokeAll}
        loading={busy === 'all'}
        title="Revoke every token?"
        message={`All ${live.length} live tokens stop working immediately. Your browser sessions are not affected. Do this if you think one has leaked and you are not sure which.`}
        confirmLabel="Revoke them all"
        tone="danger"
      />
    </>
  );
}
