import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bug, KeyRound, NotebookPen, Radar, Server } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { formatDateTime } from '../../lib/utils.js';
import { calculateCvss } from '../../lib/cvss.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge, SeverityBadge } from '../ui/Badge.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

const STATUSES = [
  { value: 'pending', label: 'Not finished' },
  { value: 'tested', label: 'Tested' },
  { value: 'excluded', label: 'Excluded' },
];

/** The label under which a matched record is listed, so nothing appears without a reason. */
function MatchedIn({ where }) {
  if (!where?.length) return null;
  return (
    <span className="text-[0.625rem] text-fg-subtle" title="Where this host was named">
      named in {where.join(' and ')}
    </span>
  );
}

function Section({ icon: Icon, title, count, children }) {
  if (!count) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
        <Icon size={12} />
        {title} · {count}
      </p>
      {children}
    </div>
  );
}

/**
 * One asset, with everything the engagement knows about it.
 *
 * Nothing here is a stored link. It is all matched on the addresses the host already has, so it
 * works on engagements that already exist without anybody re-tagging anything — and each row says
 * which field named the host, so a match can be judged rather than trusted.
 */
export default function HostWorkspace({ auditId, hostKey, editable, onClose, onSaved }) {
  const toast = useToast();
  const { data, loading, setData } = useResource(
    hostKey ? `/audits/${auditId}/hosts/${encodeURIComponent(hostKey)}` : null,
    { initial: null }
  );

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Reset the editable fields whenever a different host is opened, so the previous host's
  // working notes cannot be saved onto this one.
  useEffect(() => {
    if (!data) {
      setForm(null);
      return;
    }
    setForm({ status: data.status, statusNote: data.statusNote, notes: data.notes });
  }, [data]);

  const dirty =
    form &&
    data &&
    (form.status !== data.status ||
      form.statusNote !== data.statusNote ||
      form.notes !== data.notes);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put(
        `/audits/${auditId}/hosts/${encodeURIComponent(hostKey)}`,
        form
      );
      setData(updated);
      onSaved?.();
      toast.success('Saved', `${updated.label} updated.`);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(hostKey)}
      onClose={onClose}
      title={data?.label ?? 'Asset'}
      description={
        data
          ? [data.hostname && data.ip ? data.ip : null, data.os, data.groups.join(', ')]
              .filter(Boolean)
              .join(' · ') || 'In scope'
          : ''
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Close
          </Button>
          {editable ? (
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
              Save
            </Button>
          ) : null}
        </>
      }
    >
      {loading && !data ? (
        <LoadingBlock label="Reading the asset…" />
      ) : !data || !form ? null : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Where this asset got to"
              value={form.status}
              options={STATUSES}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, status: event.target.value })}
            />
            <Input
              label="What to tell the client"
              hint="Why it was excluded, or anything the report should say about it."
              placeholder="Client asked us not to touch it"
              value={form.statusNote}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, statusNote: event.target.value })}
            />
          </div>

          {/*
            Two note fields on purpose, and the labels say which is which: one is a sentence for
            the client and reaches the report, the other is what you tried and never leaves here.
          */}
          <Textarea
            label="Your working notes"
            rows={5}
            hint="What you tried, which credentials worked, what to come back to. Never goes in a report."
            placeholder="Web on 8443 is the old admin console — default creds rejected but no lockout.&#10;Come back to the SMB share once the domain account is sorted."
            className="font-mono text-xs"
            value={form.notes}
            disabled={!editable}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />

          <Section icon={Server} title="Services" count={data.services.length}>
            <div className="flex flex-wrap gap-1.5">
              {data.services.map((service, index) => (
                <span
                  key={`${service.port}-${service.protocol}-${index}`}
                  className="rounded-md bg-canvas/60 px-2 py-1 font-mono text-[0.625rem] text-fg-muted ring-1 ring-line"
                >
                  {service.port}
                  {service.protocol ? `/${service.protocol}` : ''}
                  {service.name ? ` ${service.name}` : ''}
                  {service.product ? ` · ${service.product}` : ''}
                </span>
              ))}
            </div>
          </Section>

          <Section icon={Bug} title="Findings on this asset" count={data.findings.length}>
            <ul className="flex flex-col gap-1">
              {data.findings.map((finding) => {
                const scored = calculateCvss(finding.cvssv3);
                return (
                  <li key={finding._id}>
                    <Link
                      to={`/engagements/${auditId}/findings/${finding._id}`}
                      onClick={onClose}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
                    >
                      <SeverityBadge
                        severity={finding.severityOverride || scored.baseSeverity}
                        score={scored.baseScore}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-fg">
                        {finding.id ? `${finding.id} — ` : ''}
                        {finding.title}
                      </span>
                      {finding.remediationStatus === 'fixed' ? (
                        <Badge tone="success">fixed</Badge>
                      ) : null}
                      <MatchedIn where={finding.matchedIn} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section icon={Radar} title="What we did to it" count={data.detections.length}>
            <ul className="flex flex-col gap-1">
              {data.detections.map((event) => (
                <li
                  key={event._id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                    {event.action}
                  </span>
                  <span className="text-[0.625rem] text-fg-subtle">
                    {formatDateTime(event.occurredAt)}
                  </span>
                  <Badge tone={event.outcome === 'not-detected' ? 'danger' : 'neutral'}>
                    {event.outcome === 'not-detected' ? 'not detected' : event.outcome}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={KeyRound} title="Credentials that mention it" count={data.credentials.length}>
            <ul className="flex flex-col gap-1">
              {data.credentials.map((credential) => (
                <li
                  key={credential._id}
                  className="flex items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-xs text-fg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">{credential.label}</span>
                  {credential.username ? (
                    <span className="font-mono text-[0.625rem] text-fg-subtle">
                      {credential.username}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={NotebookPen} title="Notes that mention it" count={data.relatedNotes.length}>
            <ul className="flex flex-col gap-1">
              {data.relatedNotes.map((note) => (
                <li
                  key={note._id}
                  className="truncate rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-xs text-fg-muted"
                >
                  {note.title}
                </li>
              ))}
            </ul>
          </Section>

          {!data.findings.length &&
          !data.detections.length &&
          !data.credentials.length &&
          !data.relatedNotes.length ? (
            <p className="rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-2.5 text-xs leading-relaxed text-fg-subtle">
              Nothing in this engagement names this asset yet. Findings, notes, logged actions and
              credentials are matched on its hostname and address, so they appear here as soon as
              one of them mentions it.
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
