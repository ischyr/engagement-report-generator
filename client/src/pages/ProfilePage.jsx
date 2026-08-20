import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, KeyRound, Pencil, Save, ShieldCheck, ShieldOff, UserCog } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { displayName, formatDateTime } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Avatar } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { CodeInput, EnrolmentPanel } from '../components/auth/TwoFactor.jsx';
import SessionsCard from '../components/auth/SessionsCard.jsx';
import SkillsEditor from '../components/team/SkillsEditor.jsx';

/** Enable / disable the authenticator for your own account. */
function TwoFactorCard() {
  const { user, startTwoFactorSetup, enableTwoFactor, disableTwoFactor } = useAuth();
  const toast = useToast();

  const [mode, setMode] = useState('idle');
  const [enrolment, setEnrolment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [disableForm, setDisableForm] = useState({ password: '', code: '' });

  const on = Boolean(user?.totpEnabled);

  const beginSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await startTwoFactorSetup());
      setMode('enrolling');
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (code) => {
    setBusy(true);
    setError(null);
    try {
      await enableTwoFactor(code);
      setMode('idle');
      setEnrolment(null);
      toast.success('Two-factor authentication is on');
    } catch (err) {
      setError({ title: err.message, hint: 'Codes change every 30 seconds — try the current one.' });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disableTwoFactor(disableForm.password, disableForm.code);
      setMode('idle');
      setDisableForm({ password: '', code: '' });
      toast.warning(
        'Two-factor authentication is off',
        'Your account is now protected by its password alone.'
      );
    } catch (err) {
      setError({ title: err.message });
      setDisableForm((current) => ({ ...current, code: '' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        icon={on ? ShieldCheck : ShieldOff}
        description={
          on
            ? 'A code from your authenticator app is required every time you sign in.'
            : 'Your account is protected by its password only.'
        }
        actions={
          <Badge tone={on ? 'success' : 'warning'}>{on ? 'Enabled' : 'Disabled'}</Badge>
        }
      />

      {mode === 'enrolling' && enrolment ? (
        <CardBody>
          <EnrolmentPanel
            enrolment={enrolment}
            onSubmit={confirm}
            submitting={busy}
            error={error}
            submitLabel="Turn on two-factor"
            onCancel={() => {
              setMode('idle');
              setEnrolment(null);
              setError(null);
            }}
            compact
          />
        </CardBody>
      ) : mode === 'disabling' ? (
        <CardBody>
          <form onSubmit={turnOff} className="flex flex-col gap-4">
            <Alert tone="warning" title="This lowers the protection on your account">
              You will be able to sign in with just your password afterwards.
            </Alert>
            <Input
              label="Your password"
              type="password"
              autoComplete="current-password"
              required
              value={disableForm.password}
              onChange={(e) => setDisableForm({ ...disableForm, password: e.target.value })}
            />
            <CodeInput
              value={disableForm.code}
              onChange={(code) => setDisableForm({ ...disableForm, code })}
              disabled={busy}
              autoFocus={false}
            />
            {error ? <Alert tone="error" title={error.title} /> : null}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  setMode('idle');
                  setError(null);
                  setDisableForm({ password: '', code: '' });
                }}
                disabled={busy}
              >
                Keep it on
              </Button>
              <Button
                type="submit"
                variant="danger"
                className="flex-1"
                loading={busy}
                disabled={!disableForm.password || disableForm.code.length !== 6}
              >
                Turn off
              </Button>
            </div>
          </form>
        </CardBody>
      ) : (
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-relaxed text-fg-muted">
            {on
              ? 'If you replace your phone, turn this off and set it up again on the new device. Lost your phone entirely? An administrator can clear it for you.'
              : 'Add a second step to sign-in using Google Authenticator or any other TOTP app.'}
          </p>
          {on ? (
            <Button variant="danger" size="sm" icon={ShieldOff} onClick={() => setMode('disabling')}>
              Turn off
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={ShieldCheck}
              loading={busy}
              onClick={beginSetup}
            >
              Set up two-factor
            </Button>
          )}
        </CardBody>
      )}
    </Card>
  );
}

export default function ProfilePage() {
  const [editingSkills, setEditingSkills] = useState(false);
  const { user, updateProfile, changePassword, isSales } = useAuth();
  const toast = useToast();

  const [profile, setProfile] = useState({ firstname: '', lastname: '', email: '', phone: '', title: '' });
  const [savingProfile, setSavingProfile] = useState(false);

  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState({});

  useEffect(() => {
    if (!user) return;
    setProfile({
      firstname: user.firstname ?? '',
      lastname: user.lastname ?? '',
      email: user.email ?? '',
      phone: user.phone ?? '',
      title: user.title ?? '',
    });
  }, [user]);

  const saveProfile = async (event) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await updateProfile(profile);
      toast.success('Profile updated');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    const next = {};
    if (!passwords.currentPassword) next.currentPassword = 'Required';
    if (passwords.newPassword.length < 8) next.newPassword = 'At least 8 characters';
    if (passwords.newPassword !== passwords.confirm) next.confirm = 'Passwords do not match';
    setPasswordErrors(next);
    if (Object.keys(next).length) return;

    setSavingPassword(true);
    try {
      await changePassword(passwords.currentPassword, passwords.newPassword);
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      toast.success('Password changed', 'Other sessions have been signed out.');
    } catch (error) {
      setPasswordErrors({ currentPassword: error.message });
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Your profile" description="Your details appear on the reports you author." />

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Avatar user={user} size={52} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-semibold text-fg">
              {displayName(user)}
              <Badge tone={user?.role === 'admin' ? 'brand' : 'info'}>{user?.role}</Badge>
            </p>
            <p className="mt-0.5 truncate text-xs text-fg-muted">
              {user?.username} · {user?.email}
            </p>
            {user?.lastLoginAt ? (
              <p className="mt-1 text-[0.6875rem] text-fg-subtle">
                Last signed in {formatDateTime(user.lastLoginAt)}
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <TwoFactorCard />

      {/*
        Your own skills, edited with the same form the Skills page uses — one form, so the
        two cannot drift apart.

        Not shown to a sales account. It is the one card here that is about the work
        rather than the account: "what you would be given work for" is a question nobody
        asks of them, the Skills page it links to is behind the wall, and the directory it
        writes into leaves them out. A card whose two buttons both lead nowhere is worse
        than no card.
      */}
      {isSales ? null : (
        <>
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">Skills and experience</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  What you would be given work for, what you hold, and when it lapses. Everyone
                  signed in can read it on the Skills page.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button as={Link} to="/skills" variant="ghost" icon={GraduationCap}>
                  The whole team
                </Button>
                <Button variant="secondary" icon={Pencil} onClick={() => setEditingSkills(true)}>
                  Edit yours
                </Button>
              </div>
            </CardBody>
          </Card>

          <SkillsEditor
            open={editingSkills}
            userId={user?.id}
            name="you"
            onClose={() => setEditingSkills(false)}
          />
        </>
      )}

      <SessionsCard />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card as="form" onSubmit={saveProfile}>
          <CardHeader
            title="Details"
            icon={UserCog}
            description="Templates can print your name, job title, email and phone as the report author."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Input
              label="First name"
              value={profile.firstname}
              onChange={(e) => setProfile({ ...profile, firstname: e.target.value })}
            />
            <Input
              label="Last name"
              value={profile.lastname}
              onChange={(e) => setProfile({ ...profile, lastname: e.target.value })}
            />
            <Input
              label="Email"
              type="email"
              wrapperClassName="sm:col-span-2"
              value={profile.email}
              onChange={(e) => setProfile({ ...profile, email: e.target.value })}
            />
            <Input
              label="Job title"
              placeholder="Lead Penetration Tester"
              value={profile.title}
              onChange={(e) => setProfile({ ...profile, title: e.target.value })}
            />
            <Input
              label="Phone"
              value={profile.phone}
              onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
            />
          </CardBody>
          <CardBody className="flex justify-end border-t border-line-soft">
            <Button type="submit" variant="primary" icon={Save} loading={savingProfile}>
              Save details
            </Button>
          </CardBody>
        </Card>

        <Card as="form" onSubmit={savePassword}>
          <CardHeader
            title="Password"
            icon={KeyRound}
            description="Changing your password signs out every other session."
          />
          <CardBody className="flex flex-col gap-4">
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={passwords.currentPassword}
              onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
              error={passwordErrors.currentPassword}
            />
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 8 characters."
              value={passwords.newPassword}
              onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
              error={passwordErrors.newPassword}
            />
            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={passwords.confirm}
              onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
              error={passwordErrors.confirm}
            />
          </CardBody>
          <CardBody className="flex justify-end border-t border-line-soft">
            <Button type="submit" variant="primary" icon={KeyRound} loading={savingPassword}>
              Change password
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
