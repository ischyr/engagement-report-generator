import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from '../ui/Button.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Six-digit code entry.
 *
 * A single text input rather than six boxes: it keeps paste working (people paste
 * from a password manager), keeps mobile keyboards sane, and avoids the focus
 * juggling that split inputs need. `inputMode="numeric"` gets the number pad and
 * `autoComplete="one-time-code"` lets iOS and Android offer the code directly.
 */
export function CodeInput({ value, onChange, onComplete, disabled, autoFocus = true, error, id }) {
  const generated = useId();
  const inputId = id ?? generated;
  const completedFor = useRef(null);

  const setValue = (raw) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    onChange(digits);
  };

  // Submit as soon as the sixth digit lands — nobody wants to reach for a button
  // when the code is already complete. Guarded so it fires once per value.
  useEffect(() => {
    if (value.length === 6 && completedFor.current !== value) {
      completedFor.current = value;
      onComplete?.(value);
    }
    if (value.length < 6) completedFor.current = null;
  }, [value, onComplete]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">
        6-digit code
      </label>
      <input
        id={inputId}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          event.preventDefault();
          setValue(event.clipboardData.getData('text'));
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- this is the only field
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder="000000"
        aria-invalid={Boolean(error) || undefined}
        maxLength={6}
        className={cn(
          'w-full rounded-lg bg-canvas/60 px-3 py-2.5 text-center font-mono text-2xl tracking-[0.4em]',
          'text-fg ring-1 transition placeholder:text-fg-subtle/50',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50',
          error ? 'ring-crit/60' : 'ring-line'
        )}
      />
      {error ? <p className="text-xs text-crit">{error}</p> : null}
    </div>
  );
}

/** Copy-to-clipboard for the manual setup key. */
function CopyKey({ value }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value.replace(/\s/g, ''));
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — the key is selectable anyway */
        }
      }}
      className="group flex w-full items-center gap-2 rounded-lg bg-canvas/70 px-3 py-2 text-left ring-1 ring-line transition hover:ring-brand-500/40"
    >
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{value}</code>
      {copied ? (
        <Check size={14} className="shrink-0 text-low" />
      ) : (
        <Copy size={14} className="shrink-0 text-fg-subtle group-hover:text-fg" />
      )}
    </button>
  );
}

/**
 * Enrolment panel: scan the QR, then confirm with a code. Shared by registration
 * and by turning 2FA back on from the profile, so both look and behave the same.
 */
export function EnrolmentPanel({
  enrolment,
  onSubmit,
  submitting,
  error,
  submitLabel = 'Confirm and continue',
  onCancel,
  compact = false,
}) {
  const [code, setCode] = useState('');
  const [showManual, setShowManual] = useState(false);

  // A rejected code should be cleared, otherwise the next keystroke appends to it.
  useEffect(() => {
    if (error) setCode('');
  }, [error]);

  const submit = (event) => {
    event?.preventDefault?.();
    if (code.length === 6 && !submitting) onSubmit(code);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {!compact ? (
        <div className="flex gap-2.5 rounded-xl border border-line-soft bg-surface/50 p-3">
          <Smartphone size={16} className="mt-0.5 shrink-0 text-brand-400" />
          <p className="text-xs leading-relaxed text-fg-muted">
            Open <span className="text-fg">Google Authenticator</span> (or Authy, 1Password,
            Microsoft Authenticator) and scan this code. Any TOTP app works.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-3">
        {/* White plate: QR codes need light quiet zones to scan reliably. */}
        <div className="rounded-xl bg-white p-2.5 shadow-panel">
          <img
            src={enrolment.qr}
            alt="QR code for setting up two-factor authentication"
            width={200}
            height={200}
            className="block size-[200px]"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="text-xs font-medium text-brand-300 transition hover:underline"
        >
          {showManual ? 'Hide setup key' : "Can't scan? Enter a key instead"}
        </button>

        {showManual ? (
          <div className="w-full">
            <p className="mb-1.5 text-xs text-fg-subtle">
              Add an account manually with this key, type <span className="text-fg-muted">time-based</span>:
            </p>
            <CopyKey value={enrolment.manualKey ?? enrolment.secret} />
          </div>
        ) : null}
      </div>

      <div className="border-t border-line-soft pt-4">
        <p className="mb-2.5 text-xs leading-relaxed text-fg-muted">
          Now enter the code your app is showing, to prove it is set up.
        </p>
        <CodeInput value={code} onChange={setCode} onComplete={() => submit()} disabled={submitting} />
      </div>

      {error ? <Alert tone="error" title={error.title}>{error.hint}</Alert> : null}

      <div className="flex items-center gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={submitting} className="flex-1">
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size={compact ? 'md' : 'lg'}
          className="flex-1"
          icon={ShieldCheck}
          loading={submitting}
          disabled={code.length !== 6}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The sign-in code challenge. */
export function MfaChallenge({ onSubmit, submitting, error, onBack, username }) {
  const [code, setCode] = useState('');

  useEffect(() => {
    if (error) setCode('');
  }, [error]);

  const submit = (event) => {
    event?.preventDefault?.();
    if (code.length === 6 && !submitting) onSubmit(code);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex gap-2.5 rounded-xl border border-line-soft bg-surface/50 p-3">
        <KeyRound size={16} className="mt-0.5 shrink-0 text-brand-400" />
        <p className="text-xs leading-relaxed text-fg-muted">
          {username ? (
            <>
              Signing in as <span className="text-fg">{username}</span>. Enter the current code from
              your authenticator app.
            </>
          ) : (
            'Enter the current code from your authenticator app.'
          )}
        </p>
      </div>

      <CodeInput value={code} onChange={setCode} onComplete={() => submit()} disabled={submitting} />

      {error ? <Alert tone={error.tone ?? 'error'} title={error.title}>{error.hint}</Alert> : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={submitting}
        disabled={code.length !== 6}
      >
        Verify and sign in
      </Button>

      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-fg-muted transition hover:text-fg"
        >
          Use a different account
        </button>
      ) : null}
    </form>
  );
}

export default EnrolmentPanel;
