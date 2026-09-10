import { useEffect, useState } from 'react';
import {
  Copy,
  Hourglass,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { displayName, formatDateTime, timeAgo } from '../lib/utils.js';

import { Card, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Avatar } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Toggle } from '../components/ui/Field.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { Alert } from '../components/ui/Alert.jsx';

/**
 * The roles an account can hold, and it can hold more than one.
 *
 * `manager` is why: somebody who signs a client's contract off is usually a consultant as well,
 * and with one role each that person had to be either a consultant who cannot sign or a manager
 * on no engagements. Neither was true of anybody real.
 */
const ROLES = [
  { value: 'admin', label: 'Administrator', hint: 'Everything, including settings and accounts.' },
  { value: 'user', label: 'Consultant', hint: 'Does the work: engagements, findings, templates.' },
  {
    value: 'manager',
    label: 'Manager',
    hint: 'Signs off the paperwork a proposal generates. Usually held alongside Consultant.',
  },
  {
    value: 'readonly',
    label: 'Read only',
    // Said plainly because it wins: an account with this and Consultant still cannot write.
    hint: 'Can look, cannot change anything — whatever else is ticked.',
  },
  {
    value: 'sales',
    label: 'Sales',
    hint: 'The Sales section. On its own it means nothing else at all — no engagements or findings.',
  },
];

const ROLE_TONE = {
  admin: 'brand',
  manager: 'warning',
  user: 'info',
  readonly: 'neutral',
  sales: 'success',
};

const roleLabel = (value) => ROLES.find((r) => r.value === value)?.label ?? value;

/**
 * People who have registered and are waiting to be let in.
 *
 * Above the account list rather than mixed into it, because it is the only thing on this
 * page that is a job: the table below is a record of who works here, and this is a
 * decision nobody else can make. It disappears entirely when the queue is empty — a
 * permanent empty box teaches people to stop looking at the top of the page.
 *
 * Whether they finished pairing an authenticator is shown, not assumed. Approving an
 * account that never got that far lets somebody in with a password alone, which is
 * exactly what the enrolment step exists to prevent, so it is said out loud instead of
 * being quietly true.
 */
function ApprovalQueue({ onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useResource('/users/pending', { initial: null });
  const [busy, setBusy] = useState(null);
  const [pendingRefusal, setPendingRefusal] = useState(null);
  const [refusing, setRefusing] = useState(false);

  const waiting = data?.waiting ?? [];

  const approve = async (row) => {
    setBusy(row.id);
    try {
      await api.post(`/users/${row.id}/approval`, { approved: true });
      toast.success(`${row.fullname} can sign in`, 'They have been told.');
      reload({ quiet: true });
      onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const refuse = async () => {
    if (!pendingRefusal) return;
    setRefusing(true);
    try {
      await api.del(`/users/${pendingRefusal.id}`);
      toast.success('Registration removed');
      setPendingRefusal(null);
      reload({ quiet: true });
      onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setRefusing(false);
    }
  };

  if (loading || !waiting.length) return null;

  return (
    <>
      <Card>
        <CardHeader
          icon={Hourglass}
          title="Waiting to be let in"
          description="These accounts exist but cannot sign in until you approve them."
          actions={<Badge tone="warning">{waiting.length}</Badge>}
        />
        <div className="flex flex-col divide-y divide-line-soft px-5 py-4">
          {waiting.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar user={row} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{row.fullname}</p>
                <p className="truncate text-xs text-fg-muted">
                  {row.username} · {row.email}
                  {row.title ? ` · ${row.title}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {row.twoFactorReady ? (
                  <Badge tone="success" icon={ShieldCheck}>
                    2FA paired
                  </Badge>
                ) : (
                  <Badge tone="warning" icon={ShieldOff}>
                    no 2FA yet
                  </Badge>
                )}
                <span className="whitespace-nowrap text-xs text-fg-subtle">
                  registered {timeAgo(row.registeredAt)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  icon={UserCheck}
                  loading={busy === row.id}
                  onClick={() => approve(row)}
                >
                  Let them in
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-crit"
                  onClick={() => setPendingRefusal(row)}
                >
                  Refuse
                </Button>
              </div>
            </div>
          ))}
        </div>

        {waiting.some((row) => !row.twoFactorReady) ? (
          <Alert tone="warning" className="mx-5 mb-4" title="One of these has not paired an authenticator">
            They registered but never finished setting up two-factor. Approving them now lets
            them in with a password alone until they do — it is usually worth waiting, or
            asking them to finish.
          </Alert>
        ) : null}
      </Card>

      <ConfirmDialog
        open={Boolean(pendingRefusal)}
        onClose={() => setPendingRefusal(null)}
        onConfirm={refuse}
        loading={refusing}
        title="Refuse this registration?"
        confirmLabel="Refuse and delete"
        message={`The account for ${pendingRefusal?.username ?? 'them'} is deleted, which frees the username and email address in case somebody legitimately wanted them. There is nothing to undo — they would have to register again.`}
      />
    </>
  );
}

function UserModal({ open, onClose, user, onSaved, onInvitation }) {
  const toast = useToast();
  const isEdit = Boolean(user?.id);

  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setForm({
      username: user?.username ?? '',
      email: user?.email ?? '',
      firstname: user?.firstname ?? '',
      lastname: user?.lastname ?? '',
      title: user?.title ?? '',
      phone: user?.phone ?? '',
      roles: user?.roles?.length ? [...user.roles] : ['user'],
      enabled: user?.enabled ?? true,
      password: '',
    });
    setErrors({});
  }, [open, user]);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const save = async () => {
    const next = {};
    if (!isEdit && !form.username?.trim()) next.username = 'Required';
    if (!form.email?.trim()) next.email = 'Required';
    // An account with nothing ticked could sign in and do nothing at all.
    if (!form.roles?.length) next.roles = 'Pick at least one';
    // A new account needs no password: leaving it blank produces an invitation link instead,
    // which is the better default — the first password an account has should be one its owner
    // chose, not one an admin picked and had to convey.
    if (!isEdit && form.password && form.password.length < 8) {
      next.password = 'At least 8 characters';
    }
    if (isEdit && form.password && form.password.length < 8) next.password = 'At least 8 characters';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    try {
      if (isEdit) {
        const payload = {
          email: form.email,
          firstname: form.firstname,
          lastname: form.lastname,
          title: form.title,
          phone: form.phone,
          roles: form.roles,
          enabled: form.enabled,
        };
        if (form.password) payload.password = form.password;
        await api.put(`/users/${user.id}`, payload);
      } else {
        const created = await api.post('/users', {
          username: form.username.trim().toLowerCase(),
          email: form.email.trim().toLowerCase(),
          ...(form.password ? { password: form.password } : {}),
          firstname: form.firstname,
          lastname: form.lastname,
          title: form.title,
          phone: form.phone,
          roles: form.roles,
        });
        if (created?.invitation?.path) {
          onSaved?.();
          onClose();
          onInvitation?.({ user: created, link: created.invitation });
          return;
        }
      }
      toast.success(isEdit ? 'Account updated' : 'Account created');
      onSaved?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${user?.username}` : 'New account'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {isEdit ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!isEdit ? (
          <Input
            label="Username"
            required
            autoFocus
            wrapperClassName="sm:col-span-2"
            hint="Letters, digits, dot, dash or underscore."
            value={form.username ?? ''}
            onChange={(e) => set({ username: e.target.value })}
            error={errors.username}
          />
        ) : null}
        <Input
          label="Email"
          type="email"
          required
          wrapperClassName="sm:col-span-2"
          value={form.email ?? ''}
          onChange={(e) => set({ email: e.target.value })}
          error={errors.email}
        />
        <Input
          label="First name"
          value={form.firstname ?? ''}
          onChange={(e) => set({ firstname: e.target.value })}
        />
        <Input
          label="Last name"
          value={form.lastname ?? ''}
          onChange={(e) => set({ lastname: e.target.value })}
        />
        <Input
          label="Job title"
          placeholder="Security Consultant"
          value={form.title ?? ''}
          onChange={(e) => set({ title: e.target.value })}
        />
        <Input label="Phone" value={form.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
        {/*
          Checkboxes rather than a dropdown, because more than one can be true at once. Each
          carries its own line of what it means — these are the decisions somebody regrets most,
          and a list of bare words is how "Read only" gets ticked next to "Consultant".
        */}
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-xs font-medium text-fg-muted">
            Roles <span className="font-normal text-fg-subtle">— an account can hold several</span>
          </p>
          <div className="flex flex-col gap-2">
            {ROLES.map((role) => {
              const on = (form.roles ?? []).includes(role.value);
              return (
                <label
                  key={role.value}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition ${
                    on ? 'border-brand-500/40 bg-brand-500/8' : 'border-line-soft hover:bg-white/[0.02]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      set({
                        roles: on
                          ? (form.roles ?? []).filter((value) => value !== role.value)
                          : [...(form.roles ?? []), role.value],
                      })
                    }
                    className="mt-0.5 size-3.5 accent-brand-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{role.label}</span>
                    <span className="block text-xs leading-relaxed text-fg-muted">{role.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {errors.roles ? <p className="mt-1.5 text-xs text-crit">{errors.roles}</p> : null}
        </div>
        <Input
          label={isEdit ? 'New password' : 'Password (optional)'}
          type="password"
          required={!isEdit}
          autoComplete="new-password"
          wrapperClassName="sm:col-span-2"
          hint={
            isEdit
              ? 'Leave blank to keep the current password. Changing it signs them out everywhere.'
              : 'Leave blank and you get an invitation link to send them — they choose their own, and you never know it.'
          }
          value={form.password ?? ''}
          onChange={(e) => set({ password: e.target.value })}
          error={errors.password}
        />
        {isEdit ? (
          <div className="sm:col-span-2">
            <Toggle
              checked={form.enabled ?? true}
              onChange={(checked) => set({ enabled: checked })}
              label="Account enabled"
              hint="A disabled account cannot sign in, but its name stays on past engagements."
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const { data, error, loading, reload } = useResource('/users', { initial: [] });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingReset, setPendingReset] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [revoking, setRevoking] = useState(false);
  /*
   * Bumped whenever something below could have changed who is waiting, which remounts the
   * queue and refetches it. The card keeps its own list — it asks a different question of
   * a different route — so reloading this table alone left it stale: withdrawing approval
   * here put somebody back in the queue and the queue did not say so until a refresh.
   */
  const [queueKey, setQueueKey] = useState(0);
  const queueChanged = () => setQueueKey((n) => n + 1);
  /** The one-time link just issued, shown once and never stored anywhere readable. */
  const [link, setLink] = useState(null);
  const [busyLink, setBusyLink] = useState(null);

  /**
   * A reset link for somebody who cannot get in.
   *
   * Handed back to the admin rather than emailed — there is no SMTP here, and an account
   * recovery that silently goes nowhere is worse than none.
   */
  const issueReset = async (row) => {
    setBusyLink(row.id);
    try {
      const issued = await api.post(`/users/${row.id}/reset-link`, {});
      setLink({ user: row, link: { ...issued, purpose: 'reset' } });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyLink(null);
    }
  };
  const [resetting, setResetting] = useState(false);

  const users = Array.isArray(data) ? data : [];

  const confirmReset = async () => {
    if (!pendingReset) return;
    setResetting(true);
    try {
      await api.post(`/users/${pendingReset.id}/reset-2fa`);
      toast.success(
        'Two-factor cleared',
        `${displayName(pendingReset)} can sign in with their password, then set it up again.`
      );
      setPendingReset(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setResetting(false);
    }
  };

  const confirmRevoke = async () => {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      await api.post(`/users/${pendingRevoke.id}/approval`, { approved: false });
      toast.success('Approval withdrawn', `${displayName(pendingRevoke)} has been signed out.`);
      setPendingRevoke(null);
      reload({ quiet: true });
      queueChanged();
    } catch (err) {
      toast.fromError(err);
    } finally {
      setRevoking(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/users/${pendingDelete.id}`);
      toast.success('Account deleted');
      setPendingDelete(null);
      reload({ quiet: true });
      queueChanged();
    } catch (err) {
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Accounts on this instance. Consultants can be added to engagements as collaborators or reviewers."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New account
          </Button>
        }
      />

      {/* Only rendered for admins, and only while somebody is actually waiting. */}
      {me?.role === 'admin' ? (
        <ApprovalQueue key={queueKey} onChanged={() => reload({ quiet: true })} />
      ) : null}

      <Card>
        {loading ? (
          <SkeletonRows rows={4} columns={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : users.length === 0 ? (
          <EmptyState icon={Users} title="No accounts" description="Create the first account." />
        ) : (
          <Table>
            <THead>
              <TH>Person</TH>
              <TH>Role</TH>
              <TH>Status</TH>
              <TH>Two-factor</TH>
              <TH align="right">Last signed in</TH>
              <TH width="7rem" />
            </THead>
            <TBody>
              {users.map((row) => {
                const isMe = row.id === me?.id;
                return (
                  <TR key={row.id}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <Avatar user={row} size={30} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
                            {displayName(row)}
                            {isMe ? <Badge tone="brand">you</Badge> : null}
                          </p>
                          <p className="truncate text-xs text-fg-muted">
                            {row.username} · {row.email}
                          </p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      {/* All of them: "Consultant" alone would hide that this person can also
                          sign a contract off, which is the question the column is asked. */}
                      <div className="flex flex-wrap gap-1">
                        {(row.roles?.length ? row.roles : [row.role]).map((role) => (
                          <Badge key={role} tone={ROLE_TONE[role]}>
                            {roleLabel(role)}
                          </Badge>
                        ))}
                      </div>
                    </TD>
                    <TD>
                      {/* Three answers, not two: waiting is neither active nor disabled,
                          and calling it "Disabled" would blame an admin for a decision
                          nobody has made yet. */}
                      {!row.enabled ? (
                        <Badge tone="danger" icon={UserX}>
                          Disabled
                        </Badge>
                      ) : row.awaitingApproval ? (
                        <Badge tone="warning" icon={Hourglass}>
                          Waiting
                        </Badge>
                      ) : (
                        <span className="text-xs text-fg-muted">Active</span>
                      )}
                    </TD>
                    <TD>
                      {row.totpEnabled ? (
                        <Badge tone="success" icon={ShieldCheck}>
                          On
                        </Badge>
                      ) : (
                        <Badge tone="warning" icon={ShieldOff}>
                          Off
                        </Badge>
                      )}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                      {row.lastLoginAt ? timeAgo(row.lastLoginAt) : 'never'}
                    </TD>
                    <TD align="right">
                      <div className="flex items-center justify-end gap-1">
                        {row.totpEnabled ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={ShieldOff}
                            title="Clear two-factor — for someone who lost their authenticator"
                            onClick={() => setPendingReset(row)}
                          />
                        ) : null}
                        {/* For somebody locked out: they set their own, and it is never conveyed. */}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={KeyRound}
                          title="Issue a password reset link"
                          disabled={!row.enabled || row.awaitingApproval || busyLink === row.id}
                          onClick={() => issueReset(row)}
                        />
                        {/* Withdrawing approval ends their sessions now rather than at expiry.
                            Not offered for your own account — the server refuses it anyway. */}
                        {!row.awaitingApproval && !isMe ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={UserX}
                            title="Withdraw approval — signs them out and blocks sign-in"
                            className="hover:text-warn"
                            onClick={() => setPendingRevoke(row)}
                          />
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Pencil}
                          title="Edit account"
                          onClick={() => setEditing(row)}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title={isMe ? 'You cannot delete your own account' : 'Delete account'}
                          disabled={isMe}
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(row)}
                        />
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <UserModal
        open={creating || Boolean(editing)}
        user={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          reload({ quiet: true });
          queueChanged();
        }}
        onInvitation={setLink}
      />

      {/*
        The link, shown once.

        Only a hash of it is stored, so this dialog is the only chance to copy it — which is the
        point: a recoverable link would be a stored credential. There is no SMTP in this app, so
        it is handed to the admin to pass through whatever channel the firm already trusts.
      */}
      <Modal
        open={Boolean(link)}
        onClose={() => setLink(null)}
        size="md"
        title={link?.link?.purpose === 'reset' ? 'Password reset link' : 'Invitation link'}
        description={`Send this to ${link?.user?.username ?? 'them'}. It works once, and it is not shown again.`}
        footer={
          <Button variant="primary" onClick={() => setLink(null)}>
            Done
          </Button>
        }
      >
        {link ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-line-soft bg-canvas/60 p-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                {`${window.location.origin}${link.link.path}`}
              </code>
              <Button
                variant="secondary"
                size="sm"
                icon={Copy}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `${window.location.origin}${link.link.path}`
                    );
                    toast.success('Copied');
                  } catch {
                    toast.info('Select the link and copy it');
                  }
                }}
              >
                Copy
              </Button>
            </div>
            <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
              They choose the password themselves, so nobody else ever knows it. The link stops
              working once it is used, or at{' '}
              {link.link.expiresAt ? formatDateTime(link.link.expiresAt) : 'its expiry'} —
              invitations last a week, resets an hour. Issuing another invalidates this one.
            </p>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingReset)}
        onClose={() => setPendingReset(null)}
        onConfirm={confirmReset}
        loading={resetting}
        tone="primary"
        title="Clear two-factor for this account?"
        confirmLabel="Clear two-factor"
        message={`${displayName(pendingReset)} will be able to sign in with just their password, and will be asked to pair a new authenticator from their profile. Only do this once you are satisfied the request is genuine.`}
      />

      <ConfirmDialog
        open={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        onConfirm={confirmRevoke}
        loading={revoking}
        title="Withdraw approval for this account?"
        confirmLabel="Withdraw approval"
        message={`${displayName(pendingRevoke)} is signed out everywhere immediately and cannot sign in again until you approve them. Their password and authenticator are untouched, so letting them back in is one button and nothing to set up again.`}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete this account?"
        confirmLabel="Delete"
        message={`${displayName(pendingDelete)} will lose access immediately. Engagements they created stay, but you may want to reassign them first.`}
      />
    </div>
  );
}
