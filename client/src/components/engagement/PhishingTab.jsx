import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eraser,
  FileUp,
  MailCheck,
  MousePointerClick,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, formatDateTime } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { SearchInput, Stat, Tabs } from '../ui/Misc.jsx';

/**
 * The outcome ladder, worst first.
 *
 * A status palette, not a set of categorical series: these are states one person can be in, they
 * are ordered, and each ships with its word rather than relying on the colour. "Reported" is the
 * only good outcome on the list and gets the good colour.
 */
const OUTCOME_META = {
  phished: { label: 'Phished', tone: 'danger', bar: 'bg-crit' },
  clicked: { label: 'Clicked', tone: 'warning', bar: 'bg-med' },
  opened: { label: 'Opened', tone: 'neutral', bar: 'bg-fg-subtle' },
  reported: { label: 'Reported it', tone: 'success', bar: 'bg-low' },
  'no-response': { label: 'No response', tone: 'neutral', bar: 'bg-line' },
};

const ORDER = ['phished', 'clicked', 'opened', 'reported', 'no-response'];

const VIEWS = [
  { value: 'all', label: 'Everyone' },
  { value: 'phished', label: 'Phished' },
  { value: 'reported', label: 'Reported it' },
  { value: 'no-response', label: 'No response' },
];

/** One line per person, the way a list is pasted out of a spreadsheet. */
function parseBulk(text) {
  const rows = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line
      .split(/[,;\t]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const email = parts.find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part));
    if (!email) continue;

    // Whatever else is on the line, in the order people write it: name then department.
    const rest = parts.filter((part) => part !== email);
    rows.push({ email: email.toLowerCase(), name: rest[0] ?? '', department: rest[1] ?? '' });
  }
  return rows;
}

export default function PhishingTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/phishing`, {
    initial: null,
  });

  const fileRef = useRef(null);
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState('');
  const [pasteJson, setPasteJson] = useState(null);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [clearing, setClearing] = useState(false);

  const targets = data?.targets ?? [];
  const summary = data?.summary;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return targets
      .filter((target) => {
        if (view === 'phished') return target.phished;
        if (view === 'reported') return target.reported;
        if (view === 'no-response') return target.outcome === 'no-response';
        return true;
      })
      .filter((target) =>
        needle
          ? [target.email, target.name, target.department, target.title, target.wave]
              .filter(Boolean)
              .some((field) => field.toLowerCase().includes(needle))
          : true
      );
  }, [targets, view, query]);

  const parsed = useMemo(() => parseBulk(bulk), [bulk]);

  const addTargets = async () => {
    setSaving(true);
    try {
      const result = await api.post(`/audits/${audit._id}/phishing`, { targets: parsed });
      setAdding(false);
      setBulk('');
      await reload({ quiet: true });
      toast.success(
        `${result.added} added`,
        result.updated ? `${result.updated} were already on the list and were updated.` : undefined
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const importFile = async (file) => {
    if (!file) return;
    setSaving(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await api.post(`/audits/${audit._id}/phishing/import`, body);
      setReport(result);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const importPasted = async () => {
    setSaving(true);
    try {
      const result = await api.post(`/audits/${audit._id}/phishing/import`, { json: pasteJson });
      setPasteJson(null);
      setReport(result);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/audits/${audit._id}/phishing/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const clearAll = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/phishing`);
      setClearing(false);
      await reload({ quiet: true });
      toast.success(`${result.removed} removed`, 'The sending list is empty.');
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading the sending list…" />;

  return (
    <div className="flex flex-col gap-4">
      {summary?.total ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="On the list"
              value={summary.total}
              sub={
                summary.sent
                  ? `${summary.sent} sent${summary.sent < summary.total ? ` of ${summary.total}` : ''}`
                  : 'nothing recorded as sent yet'
              }
              icon={Users}
            />
            <Stat
              label="Clicked"
              value={`${summary.clickedPercent}%`}
              sub={`${summary.clicked} of ${summary.reached} reached`}
              tone={summary.clickedPercent >= 20 ? 'med' : undefined}
              icon={MousePointerClick}
            />
            <Stat
              label="Phished"
              value={`${summary.phishedPercent}%`}
              sub={`${summary.phished} did what the mail asked`}
              tone={summary.phished ? 'crit' : undefined}
              icon={AlertTriangle}
            />
            <Stat
              label="Reported it"
              value={`${summary.reportedPercent}%`}
              sub={`${summary.reported} told their security team`}
              tone={summary.reported ? 'low' : undefined}
              icon={ShieldCheck}
            />
          </div>

          {/*
            The one comparison a debrief turns on, and one nothing else in the app makes: did
            anybody raise the alarm before the first person handed over a password?
          */}
          {summary.reportedBeforeFirstPhish !== null ? (
            <p
              className={cn(
                'flex items-start gap-2 rounded-lg border px-4 py-3 text-xs leading-relaxed text-fg-muted',
                summary.reportedBeforeFirstPhish
                  ? 'border-low/25 bg-low/[0.06]'
                  : 'border-crit/25 bg-crit/[0.06]'
              )}
            >
              {summary.reportedBeforeFirstPhish ? (
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-low" />
              ) : (
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-crit" />
              )}
              <span>
                <strong className="font-semibold text-fg">
                  {summary.reportedBeforeFirstPhish
                    ? 'Somebody reported it before anybody fell for it.'
                    : 'The first person was phished before anybody reported it.'}
                </strong>{' '}
                {/*
                  All three are *firsts*, so they can be compared with each other. Mixing a median
                  in among them produced the nonsense of a first click arriving after the first set
                  of credentials.
                */}
                {(() => {
                  const parts = [
                    summary.firstClickMinutes !== null
                      ? `first click at ${summary.firstClickMinutes} min`
                      : null,
                    summary.firstPhishMinutes !== null
                      ? `first credentials at ${summary.firstPhishMinutes} min`
                      : null,
                    summary.firstReportMinutes !== null
                      ? `first report at ${summary.firstReportMinutes} min`
                      : 'nothing was reported',
                  ].filter(Boolean);
                  const sentence = parts.join(', ');
                  // It follows a full stop, so it starts a sentence.
                  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
                })()}
                .
                {summary.medianClick
                  ? ` The typical click came after ${summary.medianClick}.`
                  : ''}
              </span>
            </p>
          ) : null}

          {/* Parts of a whole, so one stacked bar — and its legend, because colour alone is not
              an answer. */}
          <Card>
            <CardBody className="flex flex-col gap-3">
              <span className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-canvas">
                {ORDER.map((outcome) => {
                  const count = targets.filter((target) => target.outcome === outcome).length;
                  if (!count) return null;
                  return (
                    <span
                      key={outcome}
                      className={cn('h-full rounded-full', OUTCOME_META[outcome].bar)}
                      style={{ width: `${(count / summary.total) * 100}%` }}
                      title={`${OUTCOME_META[outcome].label}: ${count}`}
                    />
                  );
                })}
              </span>
              <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {ORDER.map((outcome) => {
                  const count = targets.filter((target) => target.outcome === outcome).length;
                  return (
                    <li
                      key={outcome}
                      className="flex items-center gap-1.5 text-[0.6875rem] text-fg-muted"
                    >
                      <span
                        className={cn('size-2 rounded-full', OUTCOME_META[outcome].bar)}
                        aria-hidden
                      />
                      {OUTCOME_META[outcome].label}
                      <span className="font-mono tabular-nums text-fg">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>

          {/* Which part of the business, which is what a client can actually act on. */}
          {summary.departments?.length > 1 ? (
            <Card>
              <CardHeader
                title="By department"
                description="Where the risk sits. Usually the right table for a report — naming individuals to their employer is not permitted on every engagement."
              />
              <CardBody className="flex flex-col gap-1.5">
                {summary.departments.map((group) => (
                  <div
                    key={group.department}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {group.department}
                    </span>
                    <span className="text-[0.625rem] text-fg-subtle">
                      {group.total} {group.total === 1 ? 'person' : 'people'}
                    </span>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/6">
                      <span
                        className="block h-full rounded-full bg-crit"
                        style={{ width: `${group.phishedPercent}%` }}
                      />
                    </span>
                    <Badge tone={group.phishedPercent ? 'danger' : 'success'}>
                      {group.phishedPercent}% phished
                    </Badge>
                    {group.reported ? (
                      <Badge tone="success">{group.reportedPercent}% reported</Badge>
                    ) : null}
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      <Card>
        <CardHeader
          icon={MailCheck}
          title="Sending list"
          description="Who the campaign goes to, and what each person did. Import the results from whatever sent it — the file is read as loosely as possible, and it says what it understood."
          actions={
            editable ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(event) => importFile(event.target.files?.[0])}
                />
                {targets.length ? (
                  <Button variant="ghost" size="sm" icon={Eraser} onClick={() => setClearing(true)}>
                    Clear
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={FileUp}
                  loading={saving}
                  onClick={() => fileRef.current?.click()}
                >
                  Import results
                </Button>
                <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
                  Add people
                </Button>
              </div>
            ) : null
          }
        />

        {targets.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody on the list yet"
            description="Paste the addresses the campaign is going to, or import a results file from the tool that sent it — an address the list has never seen is added rather than dropped."
            actionLabel={editable ? 'Add people' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => setAdding(true) : undefined}
          />
        ) : (
          <>
            <CardBody className="flex flex-wrap items-center gap-3">
              <Tabs options={VIEWS} value={view} onChange={setView} size="sm" />
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Name, address, department…"
                className="min-w-48 flex-1"
              />
            </CardBody>

            {shown.length === 0 ? (
              <EmptyState icon={Users} title="Nobody matches" description="Try another filter." />
            ) : (
              <CardBody className="flex flex-col gap-1">
                {shown.map((target) => {
                  const meta = OUTCOME_META[target.outcome] ?? OUTCOME_META['no-response'];
                  return (
                    <div
                      key={target._id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-fg">
                          {target.name || target.email}
                        </span>
                        <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                          {[
                            target.name ? target.email : '',
                            target.department,
                            target.title,
                            target.wave ? `wave: ${target.wave}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>

                      {!target.sent ? <Badge tone="neutral">not sent</Badge> : null}
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {/* Both can be true: people click, think, then report it. */}
                      {target.reported && target.phished ? (
                        <Badge tone="success">and reported it</Badge>
                      ) : null}
                      {target.clickedAt ? (
                        <span className="text-[0.625rem] text-fg-subtle">
                          {formatDateTime(target.clickedAt)}
                        </span>
                      ) : null}

                      {editable ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Take them off the list"
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(target)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </CardBody>
            )}
          </>
        )}
      </Card>

      {/* ------------------------------------------------------------- add people */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add people to the list"
        description="One per line. An address, and optionally a name and a department after it."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={parsed.length === 0}
              onClick={addTargets}
            >
              Add {parsed.length || ''} {parsed.length === 1 ? 'person' : 'people'}
            </Button>
          </>
        }
      >
        <Textarea
          rows={10}
          autoFocus
          className="font-mono text-xs"
          placeholder={
            'dana.whitfield@acme.example, Dana Whitfield, Finance\nm.ellery@acme.example, Marcus Ellery, IT\np.raman@acme.example'
          }
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
        />
        {bulk.trim() ? (
          <p className="mt-2 text-xs text-fg-muted">
            {parsed.length
              ? `${parsed.length} address${parsed.length === 1 ? '' : 'es'} recognised. Lines without one are ignored.`
              : 'No email addresses found in that. Every line needs one.'}
          </p>
        ) : null}
        <p className="mt-3 text-[0.6875rem] leading-relaxed text-fg-subtle">
          Somebody already on the list is updated rather than duplicated, so re-pasting a list with
          three new people on it adds three people.
        </p>
      </Modal>

      {/* ------------------------------------------------- what the import understood */}
      <Modal
        open={Boolean(report)}
        onClose={() => setReport(null)}
        title="Results imported"
        description="What the file said, and what could not be used."
        size="md"
        footer={
          <Button variant="primary" onClick={() => setReport(null)}>
            Done
          </Button>
        }
      >
        {report ? (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1.5 text-xs text-fg-muted">
              <li>
                <strong className="text-fg">{report.rows}</strong> rows read
              </li>
              <li>
                <strong className="text-fg">{report.updated}</strong> matched people already on the
                list
              </li>
              <li>
                <strong className="text-fg">{report.added}</strong> added, because the list had not
                seen them
              </li>
              {report.skipped ? (
                <li>
                  <strong className="text-med">{report.skipped}</strong> could not be used
                </li>
              ) : null}
            </ul>
            {report.problems?.length ? (
              <div className="rounded-lg border border-med/25 bg-med/[0.06] px-3.5 py-2.5">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-med">
                  The first few problems
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {report.problems.map((problem) => (
                    <li key={problem} className="text-[0.6875rem] text-fg-muted">
                      {problem}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button
              type="button"
              className="self-start text-[0.6875rem] text-brand-300 transition hover:text-brand-200"
              onClick={() => {
                setReport(null);
                setPasteJson('');
              }}
            >
              Paste JSON instead of uploading a file
            </button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={pasteJson !== null}
        onClose={() => setPasteJson(null)}
        title="Paste the results JSON"
        description="An array of rows, or an object with a targets, results or recipients array."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasteJson(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!pasteJson?.trim()}
              onClick={importPasted}
            >
              Import it
            </Button>
          </>
        }
      >
        <Textarea
          rows={12}
          autoFocus
          className="font-mono text-xs"
          placeholder={'[\n  { "email": "dana@acme.example", "sent": true, "phished": "yes" }\n]'}
          value={pasteJson ?? ''}
          onChange={(event) => setPasteJson(event.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Take them off the list?"
        message={`${pendingDelete?.name || pendingDelete?.email} and whatever was recorded about them are removed.`}
        confirmLabel="Remove"
      />

      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={clearAll}
        title="Clear the whole sending list?"
        message={`All ${targets.length} recipients and their results are deleted. Worth doing if the campaign was scoped against the wrong list — not otherwise.`}
        confirmLabel="Clear it"
      />
    </div>
  );
}
