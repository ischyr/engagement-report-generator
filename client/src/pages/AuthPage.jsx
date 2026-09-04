import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Hourglass, ShieldCheck } from 'lucide-react';

import { useAuth, useBranding } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { EnrolmentPanel, MfaChallenge } from '../components/auth/TwoFactor.jsx';
import { ApiError } from '../lib/api.js';

const HIGHLIGHTS = [
  'Bring your own .docx template — the report keeps your branding exactly.',
  'Findings, CVSS 3.1 scoring and a reusable vulnerability library.',
  'Rich text, screenshots and tables come through as real Word formatting.',
  'Every account is protected by an authenticator app.',
];

function AuthLayout({ children, title, subtitle }) {
  const { appName, tagline, logo } = useBranding();

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Pitch panel — hidden on small screens where the form is what matters. */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-line-soft bg-surface/40 p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(40rem 24rem at 20% 10%, rgb(109 128 245 / .16), transparent 60%), radial-gradient(32rem 20rem at 90% 90%, rgb(82 168 255 / .1), transparent 60%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          {logo ? (
            <img src={logo} alt="" className="size-9 rounded-xl object-contain" />
          ) : (
            <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 font-bold text-white">
              {appName.trim().charAt(0).toUpperCase() || 'E'}
            </span>
          )}
          <div>
            <p className="text-sm font-semibold text-fg">{appName}</p>
            <p className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">{tagline}</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-2xl font-semibold leading-snug tracking-tight text-fg text-balance">
            Write the findings once. Generate the report in your own format.
          </h2>
          <ul className="mt-6 flex flex-col gap-3">
            {HIGHLIGHTS.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-fg-muted">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand-400" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[0.6875rem] text-fg-subtle">
          Your data stays in your own MongoDB. Nothing leaves this machine.
        </p>
      </div>

      <div className="flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 font-bold text-white">
              E
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p> : null}
          <div className="mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The end of the road for somebody who has done everything asked of them.
 *
 * Its own screen rather than a banner over the password form, because there is nothing
 * left for them to type: a form still on the page is an invitation to try again, and
 * trying again will not work until somebody else acts. It says what happens next and who
 * makes it happen, and nothing about it reads like a rejection — they were not rejected,
 * they are queued.
 */
function AwaitingApproval({ username, justEnrolled, onBack }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface/60 p-4">
        <Hourglass size={18} className="mt-0.5 shrink-0 text-brand-400" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">
            {justEnrolled ? 'Your account is set up' : 'Your account is not open yet'}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">
            An administrator needs to approve{' '}
            <span className="font-medium text-fg">{username}</span> before you can sign in.
            They have been notified.
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-2 text-sm leading-relaxed text-fg-muted">
        <li className="flex gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-ok" />
          Two-factor authentication is already paired — keep the authenticator app you set
          up, you will need it to sign in.
        </li>
        <li className="flex gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
          Nothing else is needed from you. Sign in again once you have been let in.
        </li>
      </ul>

      <Button variant="secondary" size="lg" className="w-full" onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  );
}

/**
 * Turns whatever the API (or the network) produced into something worth reading.
 * The distinction that matters: wrong credentials is the user's problem to fix,
 * an unreachable server is not — and they need different next steps.
 */
function describeLoginError(error) {
  if (!(error instanceof ApiError)) {
    return { title: 'Could not sign in', hint: 'Something unexpected went wrong. Please try again.' };
  }
  if (error.isUnreachable) {
    return {
      tone: 'warning',
      title: 'Cannot reach the server',
      hint: 'The API is not responding. Start it with `npm run dev` and try again.',
      credentials: false,
    };
  }
  if (error.status === 401) {
    return {
      title: 'Incorrect username or password',
      hint: 'Check for typos and whether Caps Lock is on. You can sign in with either your username or your email address.',
      credentials: true,
    };
  }
  if (error.status === 403) {
    return { title: error.message, hint: 'Ask an administrator to re-enable your account.' };
  }
  if (error.status === 429) {
    return {
      tone: 'warning',
      title: 'Too many attempts',
      hint: 'For safety, sign-in is paused for a few minutes. Try again shortly.',
    };
  }
  return { title: error.message, hint: error.detailText || undefined };
}

export function LoginPage() {
  const { login, verifyMfa, completeEnrolment, status, refreshStatus } = useAuth();
  // Named here rather than read off `useBranding()` inside the layout: the bootstrap
  // title below needs it, and referring to it without this threw on a fresh instance —
  // the one place the branch is ever taken.
  const { appName } = useBranding();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [form, setForm] = useState({ username: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState(null);
  /**
   * 'password' → 'mfa' (code needed), 'enrol' (registration never finished) or
   * 'waiting' (everything is done and an administrator has not approved it yet).
   */
  const [step, setStep] = useState('password');
  const [challenge, setChallenge] = useState(null);
  const [waitingFor, setWaitingFor] = useState('');

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const finish = (user) => {
    toast.success(`Welcome back, ${user.firstname || user.username}`);
    navigate(searchParams.get('next') ?? '/', { replace: true });
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setProblem(null);
    try {
      const result = await login(form.username.trim(), form.password);
      if (result.status === 'mfa') {
        setChallenge({ mfaToken: result.mfaToken });
        setStep('mfa');
        return;
      }
      if (result.status === 'enrol') {
        setChallenge({
          enrolmentToken: result.enrolmentToken,
          enrolment: result.enrolment,
        });
        setStep('enrol');
        return;
      }
      if (result.status === 'awaiting-approval') {
        setWaitingFor(result.username);
        setStep('waiting');
        return;
      }
      finish(result.user);
    } catch (err) {
      setProblem(describeLoginError(err));
      // Clear the password but keep the username — retyping both is a chore.
      setForm((current) => ({ ...current, password: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async (code) => {
    setSubmitting(true);
    setProblem(null);
    try {
      const result =
        step === 'enrol'
          ? await completeEnrolment(challenge.enrolmentToken, code)
          : await verifyMfa(challenge.mfaToken, code);
      if (result.status === 'awaiting-approval') {
        setWaitingFor(result.username ?? form.username.trim());
        setStep('waiting');
        return;
      }
      finish(result.user);
    } catch (err) {
      const described = describeLoginError(err);
      setProblem(described);
      // An expired or rejected challenge means starting over from the password.
      if (err?.status === 401 && /again|not valid/i.test(err.message ?? '')) {
        setStep('password');
        setChallenge(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setStep('password');
    setChallenge(null);
    setProblem(null);
    setWaitingFor('');
    setForm((current) => ({ ...current, password: '' }));
  };

  if (step === 'waiting') {
    return (
      <AuthLayout title="Waiting for approval" subtitle="Everything on your side is done.">
        <AwaitingApproval
          username={waitingFor || form.username.trim()}
          justEnrolled={false}
          onBack={restart}
        />
      </AuthLayout>
    );
  }

  if (step === 'mfa') {
    return (
      <AuthLayout
        title="Two-factor authentication"
        subtitle="Your account is protected by an authenticator app."
      >
        <MfaChallenge
          username={form.username.trim()}
          onSubmit={submitCode}
          submitting={submitting}
          error={problem}
          onBack={restart}
        />
      </AuthLayout>
    );
  }

  if (step === 'enrol') {
    return (
      <AuthLayout
        title="Finish setting up two-factor"
        subtitle="Your account was created but never finished enrolment. Scan the code to complete it."
      >
        <EnrolmentPanel
          enrolment={challenge.enrolment}
          onSubmit={submitCode}
          submitting={submitting}
          error={problem}
          submitLabel="Finish and sign in"
          onCancel={restart}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={status.needsBootstrap ? `Set up ${appName}` : 'Sign in'}
      subtitle={
        status.needsBootstrap
          ? 'No accounts exist yet. Create the first one — it becomes the administrator.'
          : 'Use your username or email address.'
      }
    >
      {status.needsBootstrap ? (
        <Button variant="primary" size="lg" className="w-full" onClick={() => navigate('/register')}>
          Create the first account
        </Button>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {problem ? (
            <Alert tone={problem.tone ?? 'error'} title={problem.title}>
              {problem.hint}
            </Alert>
          ) : null}

          <Input
            label="Username or email"
            autoComplete="username"
            autoFocus
            required
            aria-invalid={problem?.credentials || undefined}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className={problem?.credentials ? 'ring-crit/50' : undefined}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={problem?.credentials || undefined}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className={problem?.credentials ? 'ring-crit/50' : undefined}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="mt-1 w-full"
            loading={submitting}
            iconRight={ArrowRight}
          >
            Sign in
          </Button>

          {status.registrationOpen ? (
            <p className="mt-1 text-center text-xs text-fg-muted">
              No account yet?{' '}
              <Link to="/register" className="font-medium text-brand-300 hover:underline">
                Register
              </Link>
            </p>
          ) : null}
        </form>
      )}
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register, completeEnrolment, status } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  /**
   * 'details' → 'enrol' → either signed in or 'waiting'. An account is not usable until
   * enrolment completes, and on an instance that already has people, not until an
   * administrator approves it either.
   */
  const [step, setStep] = useState('details');
  const [challenge, setChallenge] = useState(null);
  const [enrolError, setEnrolError] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const [form, setForm] = useState({
    username: '',
    email: '',
    firstname: '',
    lastname: '',
    password: '',
    confirm: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);

  const onSubmit = async (event) => {
    event.preventDefault();
    const next = {};
    if (form.password.length < 8) next.password = 'Use at least 8 characters';
    if (form.password !== form.confirm) next.confirm = 'Passwords do not match';
    setErrors(next);
    setProblem(null);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    try {
      const { confirm, ...payload } = form;
      const result = await register({
        ...payload,
        username: payload.username.trim().toLowerCase(),
        email: payload.email.trim().toLowerCase(),
      });
      // No session yet: the account exists but must be paired with an app first.
      setChallenge(result);
      setStep('enrol');
    } catch (err) {
      // Field-level details go under their inputs; anything else needs a banner,
      // otherwise "cannot reach the server" ends up labelled as a bad username.
      const mapped = {};
      if (err instanceof ApiError && Array.isArray(err.details)) {
        for (const detail of err.details) if (detail.field) mapped[detail.field] = detail.message;
      }
      setErrors(mapped);
      if (!Object.keys(mapped).length) setProblem(describeLoginError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmEnrolment = async (code) => {
    setVerifying(true);
    setEnrolError(null);
    try {
      const result = await completeEnrolment(challenge.enrolmentToken, code);
      if (result.status === 'awaiting-approval') {
        // No toast: the screen it lands on is the message, and a cheerful pop-up over
        // "you cannot come in yet" reads as though something was finished that was not.
        setStep('waiting');
        return;
      }
      toast.success(
        'Account ready',
        result.user.role === 'admin'
          ? 'You are the administrator of this instance.'
          : 'Two-factor authentication is on.'
      );
      navigate('/', { replace: true });
    } catch (err) {
      setEnrolError(describeLoginError(err));
    } finally {
      setVerifying(false);
    }
  };

  if (step === 'waiting') {
    return (
      <AuthLayout title="Almost there" subtitle="Your account has been created.">
        <AwaitingApproval
          username={form.username.trim().toLowerCase()}
          justEnrolled
          onBack={() => navigate('/login', { replace: true })}
        />
      </AuthLayout>
    );
  }

  if (step === 'enrol') {
    return (
      <AuthLayout
        title="Set up two-factor authentication"
        subtitle="Required for every account. Pair an authenticator app now — you will need it each time you sign in."
      >
        <EnrolmentPanel
          enrolment={challenge.enrolment}
          onSubmit={confirmEnrolment}
          submitting={verifying}
          error={enrolError}
          /* Says what the button does. It does not sign you in when approval is pending,
             and a label that claims otherwise is the surprise this whole screen avoids. */
          submitLabel={challenge.approvalRequired ? 'Finish setting up' : 'Finish and sign in'}
        />
        <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
          Save the setup key somewhere safe if you might reinstall your phone. If you lose access,
          an administrator can clear two-factor for your account.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={status.needsBootstrap ? 'Create the administrator account' : 'Create your account'}
      subtitle={
        status.needsBootstrap
          ? 'The first account on a fresh instance always gets the admin role.'
          : status.approvalRequired
            ? 'An administrator approves new accounts, so there will be a short wait before you can sign in.'
            : undefined
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {problem ? (
          <Alert tone={problem.tone ?? 'error'} title={problem.title}>
            {problem.hint}
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="First name"
            autoComplete="given-name"
            value={form.firstname}
            onChange={(e) => setForm({ ...form, firstname: e.target.value })}
          />
          <Input
            label="Last name"
            autoComplete="family-name"
            value={form.lastname}
            onChange={(e) => setForm({ ...form, lastname: e.target.value })}
          />
        </div>
        <Input
          label="Username"
          required
          autoFocus
          autoComplete="username"
          hint="Letters, digits, dot, dash or underscore."
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          error={errors.username}
        />
        <Input
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          error={errors.email}
        />
        <Input
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={errors.password}
        />
        <Input
          label="Confirm password"
          type="password"
          required
          autoComplete="new-password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          error={errors.confirm}
        />

        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={submitting}>
          Create account
        </Button>

        <p className="mt-1 text-center text-xs text-fg-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-300 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;
