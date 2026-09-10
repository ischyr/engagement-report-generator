import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, ClipboardList, OctagonAlert } from 'lucide-react';

import { api } from '../lib/api.js';
import { useBranding } from '../context/AuthContext.jsx';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input, Textarea } from '../components/ui/Field.jsx';
import { LoadingBlock } from '../components/ui/Feedback.jsx';

const BLANK = {
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  engagementName: '',
  kind: '',
  windowStart: '',
  windowEnd: '',
  assets: '',
  constraints: '',
  testingWindowNote: '',
  escalationName: '',
  escalationPhone: '',
  extra: '',
};

/**
 * The questionnaire a client fills in before an engagement starts.
 *
 * Public, behind a token, and the only page in the app somebody without an account ever sees
 * besides the sign-in screen. It knows the client's name and nothing else — enough for whoever
 * is filling it in to be sure the form is theirs, and nothing about what this instance holds.
 */
export default function IntakePage() {
  const { token } = useParams();
  const { appName } = useBranding();

  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/intake/public/${encodeURIComponent(token)}`);
        if (cancelled) return;
        setState({ loading: false, data, error: '' });
        if (data.answers) setForm({ ...BLANK, ...data.answers });
      } catch (error) {
        if (!cancelled) {
          setState({ loading: false, data: null, error: error?.message || 'This link is not valid.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post(`/intake/public/${encodeURIComponent(token)}`, form);
      setDone(true);
    } catch (error) {
      setState((current) => ({ ...current, error: error?.message || 'That could not be saved.' }));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  if (state.loading) return <LoadingBlock label="Opening the questionnaire…" />;

  const closed = state.error || !state.data?.open;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div>
        <p className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">{appName}</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">Before we start</h1>
        {state.data?.company ? (
          <p className="mt-1 text-sm text-fg-muted">
            A few questions about the work for <strong className="text-fg">{state.data.company}</strong>
            {state.data.label ? ` — ${state.data.label}` : ''}.
          </p>
        ) : null}
      </div>

      {closed ? (
        <Card>
          <CardBody className="flex items-start gap-3">
            <OctagonAlert size={18} className="mt-0.5 shrink-0 text-med" />
            <p className="text-sm leading-relaxed text-fg-muted">
              {state.error || state.data?.reason || 'This questionnaire is closed.'}
            </p>
          </CardBody>
        </Card>
      ) : done ? (
        <Card>
          <CardBody className="flex items-start gap-3">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-low" />
            <p className="text-sm leading-relaxed text-fg-muted">
              <strong className="text-fg">Thank you — that has reached us.</strong> You can come
              back to this link and change your answers until we set the work up. If something
              important changes after that, tell your contact directly.
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              icon={ClipboardList}
              title="Who you are"
              description="So we know who to come back to with questions."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Your name"
                value={form.contactName}
                onChange={(event) => set({ contactName: event.target.value })}
              />
              <Input
                label="Email"
                type="email"
                value={form.contactEmail}
                onChange={(event) => set({ contactEmail: event.target.value })}
              />
              <Input
                label="Phone"
                value={form.contactPhone}
                onChange={(event) => set({ contactPhone: event.target.value })}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What you want tested" />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Input
                label="What should we call this work"
                placeholder="Annual external test"
                value={form.engagementName}
                onChange={(event) => set({ engagementName: event.target.value })}
              />
              <Input
                label="What kind of test"
                placeholder="External infrastructure, web application, internal…"
                value={form.kind}
                onChange={(event) => set({ kind: event.target.value })}
              />
              <Input
                label="Earliest we can start"
                type="date"
                value={form.windowStart}
                onChange={(event) => set({ windowStart: event.target.value })}
              />
              <Input
                label="Latest we should finish"
                type="date"
                value={form.windowEnd}
                onChange={(event) => set({ windowEnd: event.target.value })}
              />
              <Textarea
                label="What is in scope"
                rows={6}
                wrapperClassName="sm:col-span-2"
                className="font-mono text-xs"
                hint="One per line — hostnames, addresses, URLs or ranges. Anything not listed here we will not touch."
                placeholder={'www.example.com\napi.example.com\n203.0.113.0/24'}
                value={form.assets}
                onChange={(event) => set({ assets: event.target.value })}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What we must not do"
              description="The two most important answers on this form. If it is not written down here, we may do it."
            />
            <CardBody className="grid gap-4">
              <Textarea
                label="Anything off limits"
                rows={4}
                placeholder="No denial-of-service. Do not test the payment sandbox. Do not attempt password resets on live accounts."
                value={form.constraints}
                onChange={(event) => set({ constraints: event.target.value })}
              />
              <Input
                label="Times we should avoid"
                placeholder="Nothing between 09:00 and 11:00 on weekdays — that is our busiest window."
                value={form.testingWindowNote}
                onChange={(event) => set({ testingWindowNote: event.target.value })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Who we ring if something breaks"
                  value={form.escalationName}
                  onChange={(event) => set({ escalationName: event.target.value })}
                />
                <Input
                  label="Their number, including out of hours"
                  value={form.escalationPhone}
                  onChange={(event) => set({ escalationPhone: event.target.value })}
                />
              </div>
              <Textarea
                label="Anything else we should know"
                rows={3}
                value={form.extra}
                onChange={(event) => set({ extra: event.target.value })}
              />
            </CardBody>
          </Card>

          {state.error ? <p className="text-xs text-crit">{state.error}</p> : null}

          <div className="flex items-center justify-end gap-3">
            <p className="mr-auto text-[0.6875rem] leading-relaxed text-fg-subtle">
              You can come back and change these until the work is set up.
            </p>
            <Button variant="primary" loading={saving} onClick={submit}>
              Send it
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
