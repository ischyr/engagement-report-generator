import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleDot, Paperclip, RefreshCw, ShieldQuestion, XCircle } from 'lucide-react';

import { api } from '../../lib/api.js';
import { calculateCvss } from '../../lib/cvss.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge, SeverityBadge } from '../ui/Badge.jsx';
import { EmptyState } from '../ui/Feedback.jsx';

/**
 * The retest, which is the half of the job the app used to drop on the floor.
 *
 * A report goes out, the client fixes things and marks them through their link, a notification
 * arrives — and then there was nowhere to go and do the work. Running a retest meant opening
 * Findings, filtering by status in your head, and remembering which of the client's claims nobody
 * had actually checked.
 *
 * Nothing here is new data. Every field this reads has been on the finding for a while and no page
 * ever put them together:
 *
 *   - `remediationStatus` — where it stands: not fixed, being retested, fixed
 *   - `clientClaim`       — what the *client* asserted, deliberately kept apart from what we found
 *   - `statusHistory`     — every move, with who made it and when
 *
 * The important one is the middle. "The client says this is fixed" and "we retested it and it is"
 * are the same `fixed` value and completely different facts, and the model keeps them apart by
 * clearing the claim the moment somebody on the team sets the status themselves. So a claim that is
 * still present *is* an unverified claim — the first list below needs no cleverness to find, it is
 * simply every finding still carrying one.
 */

/** Worst first, which is the order somebody retesting wants to work in. */
const RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, None: 0 };

function rate(finding) {
  const cvss = calculateCvss(finding.cvssv3);
  const severity = finding.severityOverride || cvss.baseSeverity;
  return { severity, score: cvss.baseScore };
}

const bySeverity = (a, b) =>
  (RANK[b._rated.severity] ?? 0) - (RANK[a._rated.severity] ?? 0) ||
  (b._rated.score ?? 0) - (a._rated.score ?? 0);

/** The last thing that happened to a finding's status, for "verified by Alice on the 3rd". */
function lastMove(finding) {
  const history = finding.statusHistory ?? [];
  return history.length ? history[history.length - 1] : null;
}

const nameOf = (person) =>
  [person?.firstname, person?.lastname].filter(Boolean).join(' ') || person?.username || '';

function Row({ finding, auditId, editable, busy, onSet }) {
  const claim = finding.clientClaim?.status ? finding.clientClaim : null;
  const moved = lastMove(finding);

  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <SeverityBadge
        severity={finding._rated.severity}
        score={finding._rated.score}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <Link
          to={`/engagements/${auditId}/findings/${finding._id}`}
          className="block truncate text-sm text-fg hover:underline"
        >
          {finding.identifier ? (
            <span className="font-mono text-xs text-fg-subtle">
              {typeof finding.identifier === 'number' ? `#${finding.identifier}` : finding.identifier}{' '}
            </span>
          ) : null}
          {finding.title}
        </Link>

        {claim ? (
          /*
           * Who said it and when, in their words — `clientClaim.by` is the label on the share link
           * ("Dana at Northwind"), never an account, because nobody with an account made this claim.
           */
          <>
            <span className="mt-0.5 block text-[0.6875rem] text-fg-muted">
              {claim.by || 'The client'} said this is{' '}
              {claim.status === 'fixed' ? 'fixed' : 'still open'} on {formatDate(claim.at)} —{' '}
              nobody has checked it.
            </span>
            {/*
              And what they said they did, which is the part that decides the retest.

              Quoted rather than paraphrased, and rendered as text: it arrived over a share link
              from somebody with no account, so it is never HTML here and never HTML in a document.
              Clamped to three lines because this is a list of rows, with the whole of it on the
              finding itself.
            */}
            {claim.note ? (
              <span className="mt-1 block border-l-2 border-line pl-2 text-[0.6875rem] italic leading-relaxed text-fg-muted line-clamp-3">
                {claim.note}
              </span>
            ) : null}
            {claim.media?.length ? (
              <span className="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
                <Paperclip size={11} />
                {claim.media.length} {claim.media.length === 1 ? 'screenshot' : 'screenshots'} they
                attached, in the evidence bin
              </span>
            ) : null}
          </>
        ) : moved ? (
          <span className="mt-0.5 block text-[0.6875rem] text-fg-subtle">
            Last moved {timeAgo(moved.at)}
            {nameOf(moved.by) ? ` by ${nameOf(moved.by)}` : ''}
          </span>
        ) : (
          <span className="mt-0.5 block text-[0.6875rem] text-fg-subtle">
            Never moved since it was written.
          </span>
        )}
      </span>

      {editable ? (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {finding.remediationStatus !== 'fixed' || claim ? (
            <Button
              variant="secondary"
              size="sm"
              icon={CheckCircle2}
              loading={busy === `${finding._id}:fixed`}
              onClick={() => onSet(finding, 'fixed')}
              title="You have retested this and it is fixed"
            >
              Verified fixed
            </Button>
          ) : null}
          {finding.remediationStatus !== 'open' || claim ? (
            <Button
              variant="ghost"
              size="sm"
              icon={XCircle}
              loading={busy === `${finding._id}:open`}
              onClick={() => onSet(finding, 'open')}
              title="You have retested this and it is not fixed"
            >
              Not fixed
            </Button>
          ) : null}
          {finding.remediationStatus !== 'retesting' ? (
            <Button
              variant="ghost"
              size="sm"
              icon={RefreshCw}
              loading={busy === `${finding._id}:retesting`}
              onClick={() => onSet(finding, 'retesting')}
              title="You are checking this now"
            >
              Retesting
            </Button>
          ) : null}
        </span>
      ) : (
        <Badge tone={finding.remediationStatus === 'fixed' ? 'success' : 'warning'}>
          {finding.remediationStatus === 'fixed'
            ? 'Fixed'
            : finding.remediationStatus === 'retesting'
              ? 'Retesting'
              : 'Not fixed'}
        </Badge>
      )}
    </li>
  );
}

function Group({ icon: Icon, title, description, findings, ...rest }) {
  if (!findings.length) return null;
  return (
    <Card>
      <CardHeader
        icon={Icon}
        title={`${title} (${findings.length})`}
        description={description}
      />
      <CardBody className="p-0">
        <ul className="divide-y divide-line-soft">
          {findings.map((finding) => (
            <Row key={finding._id} finding={finding} {...rest} />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export default function RetestTab({ audit, editable, onReload }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');

  const groups = useMemo(() => {
    const rated = (audit.findings ?? []).map((finding) => ({ ...finding, _rated: rate(finding) }));
    const claimed = rated.filter((finding) => finding.clientClaim?.status);
    const rest = rated.filter((finding) => !finding.clientClaim?.status);
    return {
      claimed: claimed.sort(bySeverity),
      retesting: rest.filter((f) => f.remediationStatus === 'retesting').sort(bySeverity),
      fixed: rest.filter((f) => f.remediationStatus === 'fixed').sort(bySeverity),
      open: rest.filter((f) => f.remediationStatus === 'open').sort(bySeverity),
    };
  }, [audit.findings]);

  const setStatus = async (finding, remediationStatus) => {
    setBusy(`${finding._id}:${remediationStatus}`);
    try {
      /*
       * The ordinary finding update, deliberately — not a retest-shaped endpoint of its own.
       * It is what appends to `statusHistory` and clears the client's claim, and a second route
       * that did the same thing slightly differently is how the two would drift.
       */
      await api.put(`/audits/${audit._id}/findings/${finding._id}`, { remediationStatus });
      await onReload?.({ quiet: true });
      toast.success(
        remediationStatus === 'fixed'
          ? 'Recorded as verified fixed'
          : remediationStatus === 'retesting'
            ? 'Marked as being retested'
            : 'Recorded as not fixed',
        'It is your call now, not the client’s claim.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const shared = { auditId: audit._id, editable, busy, onSet: setStatus };
  const total = (audit.findings ?? []).length;

  return (
    <div className="flex flex-col gap-4">
      {groups.claimed.length ? (
        <p className="rounded-lg border border-brand-500/25 bg-brand-500/[0.06] px-4 py-3 text-xs leading-relaxed text-fg-muted">
          <strong className="font-semibold text-fg">
            {groups.claimed.length} finding{groups.claimed.length === 1 ? '' : 's'} the client has
            marked, and nobody has checked.
          </strong>{' '}
          A claim is not a verification: until somebody here moves the status, the report says what
          the client said rather than what was found. Acting on one below makes it yours and clears
          the claim.
        </p>
      ) : null}

      <Group
        icon={ShieldQuestion}
        title="Waiting on you"
        description="The client has marked these through their link. Retest each one and record what you found."
        findings={groups.claimed}
        {...shared}
      />
      <Group
        icon={RefreshCw}
        title="Being retested"
        description="Somebody here is checking these now."
        findings={groups.retesting}
        {...shared}
      />
      <Group
        icon={CircleDot}
        title="Still open"
        description="Not fixed, and nobody has claimed otherwise."
        findings={groups.open}
        {...shared}
      />
      <Group
        icon={CheckCircle2}
        title="Verified fixed"
        description="Checked by somebody here, not merely reported as fixed."
        findings={groups.fixed}
        {...shared}
      />

      {!total ? (
        <Card>
          <EmptyState
            icon={RefreshCw}
            title="Nothing to retest"
            description="This engagement has no findings yet."
          />
        </Card>
      ) : null}
    </div>
  );
}
