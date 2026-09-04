import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Circle, ShieldAlert } from 'lucide-react';

import { api } from '../lib/api.js';
import { cn, formatDate } from '../lib/utils.js';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * What a client sees when they open their link.
 *
 * Outside the app shell on purpose: no sidebar, no navigation, nothing that suggests there is more
 * of this to explore. The person reading it has no account, did not ask for a tool, and wants two
 * things — what is still outstanding, and a way to say they have dealt with something.
 *
 * Everything it shows was chosen on the server (`share.service.js`), which is where the list of
 * what a client may see is kept. This page renders what it is given and asks for nothing else, so
 * a field added to a finding next year does not appear here by accident.
 *
 * The write is one button per finding. It is optimistic, because a client marking six things fixed
 * should not wait six times — and it puts the row back if the server disagrees, which happens when
 * somebody on the team has started retesting it.
 */
const SEVERITY_TONE = {
  Critical: 'text-crit',
  High: 'text-high',
  Medium: 'text-med',
  Low: 'text-low',
  None: 'text-info',
};

export default function SharedFindingsPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showFixed, setShowFixed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/share/${token}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'That link is not valid any more.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setFixed = async (finding, fixed) => {
    setBusy(finding._id);
    /* Optimistic: six findings marked in a row should not be six waits. */
    setData((current) => ({
      ...current,
      findings: current.findings.map((row) =>
        row._id === finding._id ? { ...row, status: fixed ? 'fixed' : 'open' } : row
      ),
    }));
    try {
      const fresh = await api.post(`/share/${token}/findings/${finding._id}`, { fixed });
      setData((current) => ({ ...current, ...fresh }));
    } catch (err) {
      /* Put it back, and say why — the usual reason is that somebody is already retesting it. */
      setData((current) => ({
        ...current,
        findings: current.findings.map((row) => (row._id === finding._id ? finding : row)),
      }));
      setError(err.message || 'That could not be saved.');
    } finally {
      setBusy('');
    }
  };

  const visible = useMemo(
    () => (data?.findings ?? []).filter((finding) => showFixed || finding.status !== 'fixed'),
    [data, showFixed]
  );

  if (error && !data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Alert tone="warning" icon={ShieldAlert} title="This link is not valid any more">
          It may have expired, or been withdrawn. Ask whoever sent it for a new one.
        </Alert>
      </div>
    );
  }
  if (!data) return <LoadingBlock label="Opening…" />;

  const { engagement, counts } = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-brand-300">{data.firm}</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">{engagement.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {[engagement.client, engagement.type].filter(Boolean).join(' · ')}
          {engagement.from && engagement.to
            ? ` · tested ${formatDate(engagement.from)} to ${formatDate(engagement.to)}`
            : ''}
        </p>
      </header>

      {error ? (
        <Alert tone="warning" className="mb-4" title="That change was not saved">
          {error}
        </Alert>
      ) : null}

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <span className="text-sm text-fg">
            <span className="text-2xl font-semibold">{counts.open}</span>{' '}
            <span className="text-xs text-fg-muted">still open</span>
          </span>
          <span className="text-sm text-fg-muted">
            {counts.fixed} of {counts.total} marked fixed
          </span>
          {counts.fixed ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setShowFixed((current) => !current)}
            >
              {showFixed ? 'Hide the fixed ones' : 'Show the fixed ones'}
            </Button>
          ) : null}
        </CardBody>
      </Card>

      {visible.length ? (
        <div className="flex flex-col gap-3">
          {visible.map((finding) => (
            <Card key={finding._id} className={cn(finding.status === 'fixed' && 'opacity-60')}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {finding.identifier ? (
                      <span className="font-mono text-xs text-fg-subtle">{finding.identifier}</span>
                    ) : null}
                    {finding.title}
                  </span>
                }
                description={
                  <span className={cn('text-xs font-medium', SEVERITY_TONE[finding.severity])}>
                    {finding.severity}
                    {finding.score ? ` · CVSS ${finding.score}` : ''}
                  </span>
                }
                actions={
                  data.allowUpdates ? (
                    <Button
                      variant={finding.status === 'fixed' ? 'ghost' : 'secondary'}
                      size="sm"
                      icon={finding.status === 'fixed' ? CheckCircle2 : Circle}
                      loading={busy === finding._id}
                      onClick={() => setFixed(finding, finding.status !== 'fixed')}
                    >
                      {finding.status === 'fixed' ? 'Marked fixed' : 'Mark as fixed'}
                    </Button>
                  ) : (
                    <Badge tone={finding.status === 'fixed' ? 'success' : 'warning'}>
                      {finding.status === 'fixed' ? 'Fixed' : 'Open'}
                    </Badge>
                  )
                }
              />
              <CardBody className="flex flex-col gap-4">
                {finding.description ? (
                  <div>
                    <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-fg-subtle">
                      What we found
                    </p>
                    {/*
                      Sanitised and stripped of images on the server before it was sent — see
                      `share.service.js`, which is also where the list of what a client may see
                      is kept.
                    */}
                    <div
                      className="engy-prose text-sm text-fg-muted"
                      dangerouslySetInnerHTML={{ __html: finding.description }}
                    />
                  </div>
                ) : null}
                {finding.remediation ? (
                  <div>
                    <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-fg-subtle">
                      What to do
                    </p>
                    <div
                      className="engy-prose text-sm text-fg"
                      dangerouslySetInnerHTML={{ __html: finding.remediation }}
                    />
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardBody className="py-10 text-center">
            <CheckCircle2 size={28} className="mx-auto mb-3 text-low" />
            <p className="text-sm text-fg">Everything here has been marked fixed.</p>
            <p className="mt-1 text-xs text-fg-muted">
              Your contact will confirm each one at the retest.
            </p>
          </CardBody>
        </Card>
      )}

      <p className="mt-8 text-center text-[0.6875rem] text-fg-subtle">
        This link is private to you and stops working on {formatDate(data.expiresAt)}.
        {data.allowUpdates
          ? ' Marking something fixed tells the testing team; it is confirmed at the retest.'
          : ' It is read-only.'}
      </p>
    </div>
  );
}
