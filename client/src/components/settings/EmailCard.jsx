import { useEffect, useState } from 'react';
import { KeyRound, Mail, Send, ShieldAlert } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Toggle } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Where the instance's mail server is configured.
 *
 * Its own component rather than another two hundred lines of `SettingsPage`, because it is the one
 * card here that does something as well as storing something: it fetches the provider presets and
 * it sends a test message.
 *
 * Two decisions worth knowing about.
 *
 * **The password is write-only.** It never comes back from the server — the form is told only
 * whether one is stored — so the field starts empty and stays out of the payload until somebody
 * types in it. An empty box therefore means "leave it alone", and forgetting a stored password is a
 * button of its own rather than a blank field nobody noticed.
 *
 * **The test sends what is on screen, not what is saved.** The question a person has at this point
 * is whether the details they just typed are right, and making them save a broken configuration in
 * order to discover that it is broken is the wrong way round.
 */
export default function EmailCard({ value, meta, onChange }) {
  const toast = useToast();
  const [providers, setProviders] = useState([]);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api
      .get('/settings/email/providers')
      .then((data) => setProviders(data.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const set = (patch) => onChange({ ...value, ...patch });

  /** Choosing a provider fills in the three fields nobody should have to remember. */
  const pickProvider = (key) => {
    const preset = providers.find((entry) => entry.key === key);
    if (!preset) return set({ provider: key });
    set({
      provider: key,
      ...(key === 'custom' ? {} : { host: preset.host, port: preset.port, security: preset.security }),
    });
  };

  const note = providers.find((entry) => entry.key === value.provider)?.note ?? '';

  const sendTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      /* `password` is only in the payload if it was typed; the server falls back to the stored one. */
      const response = await api.post('/settings/email/test', {
        to: testTo.trim() || undefined,
        email: value,
      });
      setResult(response);
      if (response.sent) toast.success('Test email sent', `To ${response.to}`);
      else toast.error('The test did not send', response.reason);
    } catch (error) {
      toast.fromError(error);
      setResult({ sent: false, reason: error.message, transcript: [] });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Email"
        icon={Mail}
        description="How this instance sends mail: notifications to the team, and reports to clients. Until it is filled in, notifications only ever appear in the inbox."
      />
      <CardBody className="flex flex-col gap-4">
        <Toggle
          checked={Boolean(value.enabled)}
          onChange={(enabled) => set({ enabled })}
          label="Send email from this instance"
          hint="Nothing is sent while this is off, and nothing else here has any effect."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Provider"
            value={value.provider ?? 'custom'}
            onChange={(event) => pickProvider(event.target.value)}
            options={providers.map((entry) => ({ value: entry.key, label: entry.label }))}
            wrapperClassName="sm:col-span-2"
          />
          <Input
            label="Server"
            placeholder="smtp.example.com"
            value={value.host ?? ''}
            onChange={(event) => set({ host: event.target.value })}
          />
          <Input
            label="Port"
            type="number"
            min={1}
            max={65535}
            value={value.port ?? 587}
            onChange={(event) => set({ port: Number(event.target.value) || 587 })}
          />
        </div>

        {note ? <p className="-mt-1 text-xs text-fg-muted">{note}</p> : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Security"
            value={value.security ?? 'starttls'}
            onChange={(event) => set({ security: event.target.value })}
            options={[
              { value: 'starttls', label: 'STARTTLS (usually 587)' },
              { value: 'tls', label: 'Direct TLS (usually 465)' },
              { value: 'none', label: 'None — a relay you trust' },
            ]}
          />
          <Input
            label="Username"
            autoComplete="off"
            placeholder="you@example.com"
            value={value.username ?? ''}
            onChange={(event) => set({ username: event.target.value })}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            /*
             * Never shows a stored password, and says so rather than sitting there looking empty
             * and unset. `password` is absent from the form until this field is typed in.
             */
            placeholder={
              meta?.passwordFromEnvironment
                ? 'Set by SMTP_PASSWORD'
                : meta?.hasPassword
                  ? 'Stored — type to replace'
                  : 'App password'
            }
            disabled={meta?.passwordFromEnvironment}
            value={value.password ?? ''}
            onChange={(event) => set({ password: event.target.value })}
            hint={
              meta?.hasPassword && !meta?.passwordFromEnvironment ? (
                <button
                  type="button"
                  className="text-fg-muted underline decoration-dotted hover:text-fg"
                  onClick={() => set({ password: '' })}
                >
                  Forget the stored password
                </button>
              ) : undefined
            }
          />
          <Input
            label="Reply-To"
            placeholder="Optional"
            value={value.replyTo ?? ''}
            onChange={(event) => set({ replyTo: event.target.value })}
            hint="Where a reply goes, if not to the From address."
          />
        </div>

        {!meta?.vaultAvailable && !meta?.passwordFromEnvironment ? (
          <Alert tone="warning" icon={KeyRound} title="The password cannot be stored yet">
            A password typed here is encrypted with <code>VAULT_KEY</code>, the same key the
            credential vault uses, and that is not set. Set it in <code>.env</code> and restart — or
            put the password in <code>SMTP_PASSWORD</code> instead and leave this field alone.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="From name"
            placeholder="Engy Report"
            value={value.fromName ?? ''}
            onChange={(event) => set({ fromName: event.target.value })}
          />
          <Input
            label="From address"
            placeholder="reports@example.com"
            value={value.fromAddress ?? ''}
            onChange={(event) => set({ fromAddress: event.target.value })}
            hint="Most providers insist this matches the account above."
          />
        </div>

        <Toggle
          checked={value.notifications !== false}
          onChange={(notifications) => set({ notifications })}
          label="Send notifications by email too"
          hint="Mentions, review requests and reminders, to whoever has not turned them off on their own profile. Reports are sent from the engagement either way."
        />

        {value.security === 'none' ? (
          <Toggle
            checked={Boolean(value.allowPlaintextAuth)}
            onChange={(allowPlaintextAuth) => set({ allowPlaintextAuth })}
            label="Allow the password to cross an unencrypted connection"
            hint="Only for a relay on your own machine. Without this, an unencrypted connection is refused rather than used with a password on it."
          />
        ) : null}

        <Toggle
          checked={Boolean(value.allowInvalidCertificates)}
          onChange={(allowInvalidCertificates) => set({ allowInvalidCertificates })}
          label="Accept a certificate this machine does not trust"
          hint="For an internal relay with a certificate from your own CA. Leave off for Gmail, Microsoft and anything else on the public internet."
        />

        {/* The test, which is the only thing on this card that proves anything. */}
        <div className="flex flex-col gap-3 rounded-card border border-line-soft bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label="Send a test to"
              placeholder="Your own address"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              wrapperClassName="min-w-56 flex-1"
              hint="Blank sends it to the address on your own account."
            />
            <Button
              variant="secondary"
              icon={Send}
              loading={testing}
              onClick={sendTest}
              disabled={!value.host || !value.fromAddress}
            >
              Send a test
            </Button>
          </div>

          {result ? (
            result.sent ? (
              <Alert tone="success" title={`Sent to ${result.to}`}>
                {result.secure ? 'Over an encrypted connection. ' : 'Over an unencrypted connection. '}
                {result.response}
              </Alert>
            ) : (
              <Alert tone="error" icon={ShieldAlert} title="It did not send">
                <p>{result.reason}</p>
                {result.transcript?.length ? (
                  /*
                   * The conversation, verbatim minus the credentials. A refusal from a mail server
                   * is one line that says exactly what is wrong, and hiding it behind "could not
                   * send" is how an afternoon disappears.
                   */
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-[0.6875rem] leading-relaxed text-fg-muted">
                    {result.transcript.join('\n')}
                  </pre>
                ) : null}
              </Alert>
            )
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
