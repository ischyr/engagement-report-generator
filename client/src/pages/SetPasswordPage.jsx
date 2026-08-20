import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, KeyRound, ShieldAlert } from 'lucide-react';

import { api } from '../lib/api.js';
import { useBranding } from '../context/AuthContext.jsx';

import { Card, CardBody } from '../components/ui/Card.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Field.jsx';
import { LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * Choosing your own password, from a one-time link.
 *
 * The same page for an invitation and for a reset — they differ by a sentence, because they are
 * the same act: the person who will use the account is the only one who ever types the password.
 *
 * Public, and reached without a session. It signs nobody in when it finishes: a link that handed
 * back a session would *be* the credential, and forwarded once in a chat it would be the account.
 * Setting the password and then typing it is the step that proves who is at the keyboard.
 */
export default function SetPasswordPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { appName } = useBranding();

  const [state, setState] = useState({ loading: true, link: null, error: '' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/auth/set-password/${encodeURIComponent(token)}`)
      .then((link) => !cancelled && setState({ loading: false, link, error: '' }))
      .catch((error) =>
        !cancelled &&
        setState({
          loading: false,
          link: null,
          error: error?.message ?? 'That link is not valid any more.',
        })
      );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 8 && confirm === password && !saving;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await api.post(`/auth/set-password/${encodeURIComponent(token)}`, { password });
      setDone(true);
    } catch (error) {
      setState((current) => ({ ...current, error: error?.message ?? 'That did not work.' }));
    } finally {
      setSaving(false);
    }
  };

  if (state.loading) return <LoadingBlock label="Checking the link…" />;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Card>
        <CardBody className="flex flex-col gap-5">
          {done ? (
            <>
              <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                <CheckCircle2 size={18} className="shrink-0 text-low" />
                Password set
              </p>
              <p className="text-xs leading-relaxed text-fg-muted">
                Sign in with it now. Everything else that was signed in as{' '}
                <span className="font-mono text-fg">{state.link?.username}</span> has been signed
                out — a reset that leaves the other party logged in is not a reset.
              </p>
              <Button variant="primary" onClick={() => navigate('/login')}>
                Go to sign in
              </Button>
            </>
          ) : state.error && !state.link ? (
            <>
              <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                <ShieldAlert size={18} className="shrink-0 text-med" />
                That link is not valid
              </p>
              <p className="text-xs leading-relaxed text-fg-muted">
                It may have been used already, or it may have expired — an invitation lasts a week
                and a reset an hour. Ask whoever sent it for another.
              </p>
              <Button as={Link} to="/login" variant="secondary">
                Back to sign in
              </Button>
            </>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <KeyRound size={16} className="shrink-0 text-brand-300" />
                  {state.link?.purpose === 'invite'
                    ? `Welcome to ${appName}`
                    : 'Choose a new password'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                  {state.link?.purpose === 'invite'
                    ? 'Your account is ready — choose a password and it is yours. Nobody else has ever known one for it.'
                    : 'Choose a new one. Everything currently signed in as this account will be signed out.'}{' '}
                  You are setting the password for{' '}
                  <span className="font-mono text-fg">{state.link?.username}</span>.
                </p>
              </div>

              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                autoFocus
                required
                value={password}
                error={tooShort ? 'At least 8 characters' : undefined}
                hint={!tooShort ? 'At least 8 characters.' : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Input
                label="Type it again"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                error={mismatch ? 'These do not match' : undefined}
                onChange={(event) => setConfirm(event.target.value)}
              />

              {state.error ? <p className="text-xs text-crit">{state.error}</p> : null}

              <Button type="submit" variant="primary" loading={saving} disabled={!ready}>
                Set the password
              </Button>

              <p className="text-[0.625rem] leading-relaxed text-fg-subtle">
                {state.link?.purpose === 'invite'
                  ? 'You will be asked to pair an authenticator app the first time you sign in.'
                  : 'Two-factor is untouched — a link that cleared it as well would be a single-channel way into the account.'}
              </p>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
