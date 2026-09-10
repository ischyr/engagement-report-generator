import { useEffect, useState } from 'react';
import { KeyRound, Plug, ShieldAlert, Sparkles } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { forgetAssistant } from '../../hooks/useAssistant.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea, Toggle } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Where the optional assistant is configured, in the same shape as the mail server above it.
 *
 * The similarity is the argument. An endpoint, a model and a key; off until filled in; the key
 * write-only and held under the vault with an environment variable that overrides it; and a test
 * button that tries what is on the form rather than what is saved, and prints the provider's own
 * refusal when there is one. Somebody who has set up mail on this instance already knows how to set
 * this up, and somebody who has set up neither only has to learn the pattern once.
 *
 * Two things here have no counterpart on the mail card, and both are about what leaves the machine.
 *
 * **The four jobs switch on and off individually.** A team that wants a hand with the executive
 * summary and would rather nothing touched a finding is a configuration rather than a fork.
 *
 * **Restricted engagements are refused separately**, and by default. Marking work restricted
 * already means it is handled more carefully than the rest, and it would be a strange instance that
 * did that and then posted its findings to a third party because a general setting happened to be
 * on. An instance pointed at a model on its own hardware can reasonably turn it on; one pointed at
 * somebody else's API should think about it first, which is what a separate switch is for.
 */
const JOBS = [
  {
    key: 'summary',
    label: 'Draft the executive summary',
    hint: 'From the findings, their severities and the scope — on the Sections tab, beside the executive summary.',
  },
  {
    key: 'rewrite',
    label: 'Rewrite a passage in the house style',
    hint: 'The description, the impact or the remediation of one finding. Never the proof of concept, which is never sent.',
  },
  {
    key: 'enumeration',
    label: 'Summarise a tool run in one line',
    hint: 'Turns the pasted output of an enumeration step into the one-line summary the report prints above it.',
  },
  {
    key: 'library',
    label: 'Suggest a library match',
    hint: 'Shortlists your own library here, then asks which entry is the same weakness.',
  },
];

export default function AssistantCard({ value, meta, onChange }) {
  const toast = useToast();
  const [providers, setProviders] = useState([]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api
      .get('/settings/assistant/providers')
      .then((data) => setProviders(data.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const set = (patch) => onChange({ ...value, ...patch });
  const setJob = (key, on) => set({ jobs: { ...(value.jobs ?? {}), [key]: on } });

  /** Choosing a provider fills in the three fields nobody should have to remember. */
  const pickProvider = (key) => {
    const preset = providers.find((entry) => entry.key === key);
    if (!preset) return set({ provider: key });
    return set({
      provider: key,
      wire: preset.wire,
      ...(key === 'custom' ? {} : { endpoint: preset.endpoint, model: preset.model }),
    });
  };

  const preset = providers.find((entry) => entry.key === value.provider);
  const note = preset?.note ?? '';

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      /* `key` is only in the payload if it was typed; the server falls back to the stored one. */
      const response = await api.post('/settings/assistant/test', { assistant: value });
      setResult(response);
      if (response.ok) toast.success('The assistant answered', response.model);
      else toast.error('The assistant did not answer', response.reason);
    } catch (error) {
      toast.fromError(error);
      setResult({ ok: false, reason: error.message, detail: error.details?.detail ?? '' });
    } finally {
      setTesting(false);
      /* So the buttons on the engagement pages appear or disappear without a reload. */
      forgetAssistant();
    }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Assistant"
        icon={Sparkles}
        description="An optional model that drafts an executive summary, rewrites a passage in your house style, summarises a tool run in one line, and suggests a library match. Off until you fill it in, and every button it adds is absent rather than greyed out until then."
      />
      <CardBody className="flex flex-col gap-4">
        <Toggle
          checked={Boolean(value.enabled)}
          onChange={(enabled) => set({ enabled })}
          label="Use an assistant on this instance"
          hint="Nothing is sent anywhere while this is off, and nothing else here has any effect."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Provider"
            value={value.provider ?? 'anthropic'}
            onChange={(event) => pickProvider(event.target.value)}
            options={providers.map((entry) => ({ value: entry.key, label: entry.label }))}
            wrapperClassName="sm:col-span-2"
          />
          <Select
            label="Wire shape"
            value={value.wire ?? 'anthropic'}
            onChange={(event) => set({ wire: event.target.value })}
            options={[
              { value: 'anthropic', label: 'Messages API' },
              { value: 'openai', label: 'Chat completions' },
            ]}
            hint="Which protocol answers at that URL."
          />
          <Input
            label="Model"
            placeholder="claude-opus-5"
            value={value.model ?? ''}
            onChange={(event) => set({ model: event.target.value })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Endpoint"
            placeholder="Leave empty for the provider's own"
            value={value.endpoint ?? ''}
            onChange={(event) => set({ endpoint: event.target.value })}
            wrapperClassName="sm:col-span-2"
            hint="A base URL. This is what makes a model on your own hardware possible."
          />
          <Input
            label="API key"
            type="password"
            autoComplete="new-password"
            /*
             * Never shows a stored key, and says so rather than sitting there looking empty and
             * unset. `key` is absent from the form until this field is typed in.
             */
            placeholder={
              meta?.keyFromEnvironment
                ? 'Set by ASSISTANT_API_KEY'
                : meta?.hasKey
                  ? 'Stored — type to replace'
                  : 'Not needed for a local model'
            }
            disabled={meta?.keyFromEnvironment}
            value={value.key ?? ''}
            onChange={(event) => set({ key: event.target.value })}
            hint={
              meta?.hasKey && !meta?.keyFromEnvironment ? (
                <button
                  type="button"
                  className="text-fg-muted underline decoration-dotted hover:text-fg"
                  onClick={() => set({ key: '' })}
                >
                  Forget the stored key
                </button>
              ) : undefined
            }
          />
          <Input
            label="Timeout"
            type="number"
            min={5}
            max={300}
            value={value.timeoutSeconds ?? 60}
            onChange={(event) => set({ timeoutSeconds: Number(event.target.value) || 60 })}
            hint="Seconds. A model on a laptop is slower than an API."
          />
        </div>

        {note ? <p className="-mt-1 text-xs text-fg-muted">{note}</p> : null}

        {!meta?.vaultAvailable && !meta?.keyFromEnvironment ? (
          <Alert tone="warning" icon={KeyRound} title="The key cannot be stored yet">
            A key typed here is encrypted with <code>VAULT_KEY</code>, the same key the credential
            vault uses, and that is not set. Set it in <code>.env</code> and restart — or put the key
            in <code>ASSISTANT_API_KEY</code> instead and leave this field alone. A model running on
            this machine usually needs no key at all.
          </Alert>
        ) : null}

        <Textarea
          label="House style"
          rows={3}
          maxLength={2000}
          placeholder="Third person throughout. Never “malicious actor”. Remediation is numbered steps, most important first."
          value={value.houseStyle ?? ''}
          onChange={(event) => set({ houseStyle: event.target.value })}
          hint="Put in front of every prompt. Your conventions win over anything the model would otherwise do."
        />

        <div className="flex flex-col gap-3 rounded-card border border-line-soft bg-white/[0.02] p-3">
          <p className="text-xs font-medium text-fg">What it may be asked</p>
          {JOBS.map((job) => (
            <Toggle
              key={job.key}
              checked={value.jobs?.[job.key] !== false}
              onChange={(on) => setJob(job.key, on)}
              label={job.label}
              hint={job.hint}
            />
          ))}
        </div>

        <Toggle
          checked={Boolean(value.allowRestricted)}
          onChange={(allowRestricted) => set({ allowRestricted })}
          label="Allow restricted engagements to be sent as well"
          hint="Off, and deliberately separate. A restricted engagement is refused outright while this is off, whatever else is switched on. Reasonable to turn on when the endpoint above is a model on your own hardware."
        />

        {/* The test, which is the only thing on this card that proves anything. */}
        <div className="flex flex-col gap-3 rounded-card border border-line-soft bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-fg-muted">
              Asks the endpoint one trivial question, with what is on this form rather than what is
              saved. Nothing is written either way.
            </p>
            <Button
              variant="secondary"
              icon={Plug}
              loading={testing}
              onClick={test}
              disabled={!value.model}
            >
              Test it
            </Button>
          </div>

          {result ? (
            result.ok ? (
              <Alert tone="success" title={`${result.model} answered in ${(result.ms / 1000).toFixed(1)}s`}>
                <p className="italic">“{result.answer}”</p>
              </Alert>
            ) : (
              <Alert tone="error" icon={ShieldAlert} title="It did not answer">
                <p>{result.reason}</p>
                {result.detail ? (
                  /*
                   * The provider's own words, verbatim. A spent balance, a model name with a typo
                   * in it and a safety refusal are three different afternoons, and hiding them
                   * behind "could not connect" is how somebody spends one on the wrong problem.
                   */
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[0.6875rem] leading-relaxed text-fg-muted">
                    {result.detail}
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
