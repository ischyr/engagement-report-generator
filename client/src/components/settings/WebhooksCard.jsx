import { useState } from 'react';
import { CheckCircle2, OctagonAlert, Send, TriangleAlert } from 'lucide-react';

import { api } from '../../lib/api.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Checkbox, Input, Select, Toggle } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * Telling a chat channel what happened, as it happens.
 *
 * The same shape as the mail server, the assistant and the PDF converter: off until it is filled
 * in, a preset per service, and a test that reports the service's own words rather than a shrug.
 *
 * ## Why the URL is write-only
 *
 * Because for Teams and for Discord it is not a password *for* something, it is the entire
 * authorisation: anybody holding that URL can post into the channel as this app, for as long as
 * nobody revokes it. So it goes to the server to be stored in the vault and never comes back — the
 * form shows whether one is set and which host it points at, which is all anybody needs to know
 * that the right channel is wired up. Replacing it means pasting a new one; there is no reading the
 * old one out, by anybody, including whoever pasted it.
 */

/** What each service's own screens call the thing you are looking for. */
const WHERE = {
  teams:
    'In Teams: the channel’s ⋯ menu → Connectors → Incoming Webhook, or Workflows → “Post to a channel when a webhook request is received”.',
  discord:
    'In Discord: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL. A webhook belongs to one channel.',
  json: 'Any URL that accepts a POST of JSON. Signed with a shared secret so the receiver can prove the request came from here.',
};

export default function WebhooksCard({ value, onChange }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const enabled = Boolean(value?.enabled);
  const provider = value?.provider ?? 'teams';
  const providers = value?.providers ?? [];
  const groups = value?.groups ?? [];
  const events = value?.events ?? {};

  const set = (patch) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      /*
       * The unsaved form, so a URL can be proved before it is committed — and `url` omitted rather
       * than sent empty when nobody has retyped it, which is what lets somebody press this on an
       * instance they did not configure and cannot read the credential of.
       */
      const answer = await api.post('/settings/webhooks/test', {
        provider,
        ...(value?.url ? { url: value.url } : {}),
        ...(value?.signingSecret ? { signingSecret: value.signingSecret } : {}),
        timeoutSeconds: Number(value?.timeoutSeconds) || 10,
      });
      setResult(answer);
    } catch (error) {
      setResult({ ok: false, message: error.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Send}
        title="Posting to a chat channel"
        description="Sends what the activity log records — a finding written, a severity moved, a report delivered — to a Teams or Discord channel as it happens. Nobody has to press anything."
      />
      <CardBody className="flex flex-col gap-4">
        <Toggle
          checked={enabled}
          onChange={(next) => set({ enabled: next })}
          label="Post events to a channel"
          hint="Off is the app as it was: the activity log still records everything, it simply stays in the app."
        />

        {enabled ? (
          <>
            <Select
              label="Where to"
              value={provider}
              onChange={(event) => set({ provider: event.target.value })}
              options={providers.map((entry) => ({ value: entry.id, label: entry.name }))}
              hint={WHERE[provider]}
            />

            <Input
              label="Webhook URL"
              type="password"
              autoComplete="off"
              value={value?.url ?? ''}
              onChange={(event) => set({ url: event.target.value })}
              placeholder={
                value?.hasUrl
                  ? `Stored — posting to ${value.urlHost || 'a saved URL'}`
                  : 'Paste the URL the service gave you'
              }
              hint={
                value?.urlFromEnvironment
                  ? 'Coming from WEBHOOK_URL in the environment, which wins over anything saved here.'
                  : value?.hasUrl
                    ? 'Stored and not shown again — it is the whole authorisation to post to that channel. Paste a new one to replace it, or clear the box and save to forget it.'
                    : 'Stored in the vault and never shown again.'
              }
              spellCheck={false}
            />

            {provider === 'json' ? (
              <Input
                label="Signing secret"
                type="password"
                autoComplete="off"
                value={value?.signingSecret ?? ''}
                onChange={(event) => set({ signingSecret: event.target.value })}
                placeholder={value?.hasSigningSecret ? 'Stored' : 'Optional'}
                hint="Sent as an X-Engy-Signature header: HMAC-SHA256 over the timestamp and the body, so a receiver can tell a real request from a guessed URL."
                spellCheck={false}
              />
            ) : null}

            {value?.vaultAvailable === false ? (
              <Alert tone="warning" icon={TriangleAlert} title="There is no vault key">
                Set <span className="font-mono">VAULT_KEY</span> before saving a URL — without it
                there is nowhere to keep one that is not plain text in the database.
              </Alert>
            ) : null}

            <div>
              <p className="text-xs font-medium text-fg">What to post</p>
              <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-fg-muted">
                Groups rather than every kind of event. The activity log holds a row for every save;
                a channel told about all of them is a channel somebody mutes on the first afternoon.
                A finding being edited is only posted when its <em>severity</em> moves.
              </p>
              <div className="mt-2.5 flex flex-col gap-2">
                {groups.map((group) => (
                  <div key={group.id}>
                    <Checkbox
                      checked={Boolean(events[group.id])}
                      onChange={(next) => set({ events: { ...events, [group.id]: next } })}
                      label={group.name}
                    />
                    <p className="ml-6 text-[0.6875rem] leading-relaxed text-fg-subtle">
                      {group.hint}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <Input
              label="Timeout"
              type="number"
              min={1}
              max={60}
              value={value?.timeoutSeconds ?? 10}
              onChange={(event) => set({ timeoutSeconds: Number(event.target.value) })}
              hint="Seconds. A slow channel is never allowed to slow down a save — the post happens after the work, and failing costs nothing but a line in the log."
            />

            {/* Wrapping, and the sentence is the flexible half — see the note in `Button`. */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                loading={testing}
                onClick={test}
                disabled={!value?.url && !value?.hasUrl}
              >
                Post a test message
              </Button>
              <span className="min-w-0 flex-1 text-[0.6875rem] leading-relaxed text-fg-subtle">
                A real message in the real format — the only proof that works is something appearing
                in the channel.
              </span>
            </div>

            {result ? (
              result.ok ? (
                <Alert tone="success" icon={CheckCircle2} title="Posted">
                  {result.message}
                  {result.warning ? ` ${result.warning}` : ''}
                </Alert>
              ) : (
                <Alert tone="warning" icon={OctagonAlert} title="It was not accepted">
                  {result.message}
                  {result.warning ? ` ${result.warning}` : ''}
                </Alert>
              )
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
