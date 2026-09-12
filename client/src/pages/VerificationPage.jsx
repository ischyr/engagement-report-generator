import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  CircleDot,
  Lock,
  MessageSquareReply,
  Paperclip,
  ShieldQuestion,
  XCircle,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { formatDate, timeAgo } from '../lib/utils.js';

import { Card, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge, SeverityBadge } from '../components/ui/Badge.jsx';
import { Textarea } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * What the client has said, across every engagement, that nobody has answered yet.
 *
 * The Inbox is everything waiting on *you*. This is its mirror: everything a client is waiting on
 * *us* for — and until now it existed only inside whichever engagement it arrived in. A client who
 * marks six findings fixed on a Friday and asks two questions about a seventh has, from the team's
 * side, done nothing visible at all: the claims sit in six Retest tabs and the questions in a
 * Questions tab, each behind three clicks, each findable only by somebody who already suspected.
 *
 * Two lists, because there are exactly two things that arrive this way and they are different work:
 *
 *   - **A claim** is a retest. Somebody has to go and check, and the engagement's own Retest tab is
 *     where the checking happens — but the queue of them is not per engagement, it is per person,
 *     and it is what this page is for.
 *   - **A question** is a reply. It can be answered from here, because it genuinely is one field.
 *
 * Both actions go through the routes that already own them: a verification is a
 * `PUT /audits/:id/findings/:findingId`, which is what clears the claim and writes the status
 * history, and an answer is a `PUT /audits/:id/questions/:questionId`. Nothing here is a second way
 * to make either change.
 *
 * Ordered oldest first — the opposite of every other list in this app, and on purpose. This is a
 * queue, and the row at the top is the one somebody is about to be asked about.
 */

const nameOf = (row) => [row.name, row.company].filter(Boolean).join(' · ');

/** How long it has been sitting there, said plainly when it is a while. */
function Waiting({ at }) {
  if (!at) return null;
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
  return (
    <span className={days >= 7 ? 'text-med' : 'text-fg-subtle'}>
      {days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : timeAgo(at)}
    </span>
  );
}

/**
 * The engagement a row belongs to, and whether anything can be done about it from here.
 *
 * An approved engagement is locked for everybody but an admin — so rather than offer buttons that
 * will come back with a refusal, the row says what the situation is. The claim is still worth
 * seeing: a report that went out with a client's claim unverified is exactly what this page is for.
 */
function Where({ row }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-fg-subtle">
      <Link to={`/engagements/${row.auditId}`} className="hover:text-fg hover:underline">
        {nameOf(row)}
      </Link>
      {row.reference ? <span className="font-mono">{row.reference}</span> : null}
      {row.state === 'APPROVED' ? (
        <Badge tone="neutral" icon={Lock} title="Approved and locked — an admin can reopen it">
          Approved
        </Badge>
      ) : null}
    </span>
  );
}

function ClaimRow({ row, canAct, busy, onSet }) {
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <SeverityBadge severity={row.severity} score={row.score} className="mt-0.5 shrink-0" />

      <span className="min-w-0 flex-1">
        <Link
          to={`/engagements/${row.auditId}/findings/${row.findingId}`}
          className="block truncate text-sm text-fg hover:underline"
        >
          {row.identifier ? (
            <span className="font-mono text-xs text-fg-subtle">
              {typeof row.identifier === 'number' ? `#${row.identifier}` : row.identifier}{' '}
            </span>
          ) : null}
          {row.title}
        </Link>

        <span className="mt-0.5 block text-[0.6875rem] text-fg-muted">
          {row.by || 'The client'} said this is {row.kind === 'fixed' ? 'fixed' : 'still open'} on{' '}
          {formatDate(row.at)} — <Waiting at={row.at} />
        </span>

        {/*
          Their words, quoted and rendered as text. It arrived over a share link from somebody with
          no account, so it is never HTML here — the same rule the Retest tab states, for the same
          reason, on the same field.
        */}
        {row.note ? (
          <span className="mt-1 block border-l-2 border-line pl-2 text-[0.6875rem] italic leading-relaxed text-fg-muted line-clamp-3">
            {row.note}
          </span>
        ) : null}

        {row.attachments ? (
          <span className="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
            <Paperclip size={11} />
            {row.attachments} {row.attachments === 1 ? 'screenshot' : 'screenshots'} they attached
          </span>
        ) : null}

        <Where row={row} />
      </span>

      {canAct ? (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            icon={CheckCircle2}
            loading={busy === `${row.findingId}:fixed`}
            onClick={() => onSet(row, 'fixed')}
            title="You have retested this and it is fixed"
          >
            Verified fixed
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={XCircle}
            loading={busy === `${row.findingId}:open`}
            onClick={() => onSet(row, 'open')}
            title="You have retested this and it is not fixed"
          >
            Not fixed
          </Button>
        </span>
      ) : (
        <span className="shrink-0 text-[0.6875rem] text-fg-subtle">
          {row.state === 'APPROVED' ? 'Reopen the report to retest' : 'Read-only'}
        </span>
      )}
    </li>
  );
}

function QuestionRow({ row, canAct, busy, onAnswer }) {
  const [answer, setAnswer] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-brand-300" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-fg">{row.text}</span>
          <span className="mt-0.5 block text-[0.6875rem] text-fg-muted">
            {row.from} asked — <Waiting at={row.at} />
            {row.findingTitle ? (
              <>
                {' · about '}
                <Link
                  to={`/engagements/${row.auditId}/findings/${row.findingId}`}
                  className="hover:text-fg hover:underline"
                >
                  {row.findingTitle}
                </Link>
              </>
            ) : null}
          </span>
          <Where row={row} />
        </span>

        {canAct ? (
          <Button
            variant={open ? 'ghost' : 'secondary'}
            size="sm"
            icon={MessageSquareReply}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Cancel' : 'Answer'}
          </Button>
        ) : (
          <span className="shrink-0 text-[0.6875rem] text-fg-subtle">
            {row.state === 'APPROVED' ? 'Reopen the report to answer' : 'Read-only'}
          </span>
        )}
      </div>

      {open && canAct ? (
        <div className="flex flex-col gap-2 pl-7">
          <Textarea
            rows={3}
            autoFocus
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="The answer they will see on their link."
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!answer.trim()}
              loading={busy === row.questionId}
              onClick={() => onAnswer(row, answer.trim())}
            >
              Send the answer
            </Button>
            <span className="text-[0.6875rem] text-fg-subtle">
              It is recorded on the engagement's Questions tab and shown on their link.
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function VerificationPage() {
  const { user, canWrite } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useResource('/verification', { initial: null });
  const [show, setShow] = useUrlState('show', 'all');
  const [busy, setBusy] = useState('');

  const claims = data?.claims ?? [];
  const questions = data?.questions ?? [];
  const totals = data?.totals ?? { claims: 0, questions: 0, toVerify: 0, mine: 0, oldestDays: null };

  const mineOnly = show === 'mine';
  const shownClaims = useMemo(
    () =>
      show === 'questions' ? [] : claims.filter((row) => (mineOnly ? row.mine : true)),
    [claims, show, mineOnly]
  );
  const shownQuestions = useMemo(
    () => (show === 'claims' ? [] : questions.filter((row) => (mineOnly ? row.mine : true))),
    [questions, show, mineOnly]
  );

  /**
   * Whether this row can be acted on from here at all.
   *
   * An approved engagement is locked to everybody but an admin, and a read-only account writes
   * nothing anywhere. Both are decided by the server; asked here so the page offers a button only
   * when pressing it would work.
   */
  const canAct = (row) =>
    Boolean(canWrite) && (row.state !== 'APPROVED' || user?.role === 'admin');

  /** The row leaves the queue the moment its cause is gone — no refetch to watch it disappear. */
  const drop = (match) =>
    setData((current) =>
      current
        ? {
            ...current,
            claims: current.claims.filter((row) => !match.claim || !match.claim(row)),
            questions: current.questions.filter((row) => !match.question || !match.question(row)),
          }
        : current
    );

  const setStatus = async (row, remediationStatus) => {
    setBusy(`${row.findingId}:${remediationStatus}`);
    try {
      /*
       * The same route the Retest tab uses. It is what appends to `statusHistory` and clears the
       * client's claim — which is also what takes this row out of the queue, since a claim that is
       * gone is a claim that has been checked.
       */
      await api.put(`/audits/${row.auditId}/findings/${row.findingId}`, { remediationStatus });
      toast.success(
        remediationStatus === 'fixed' ? 'Verified as fixed' : 'Marked as not fixed',
        `${row.title} — ${nameOf(row)}`
      );
      drop({ claim: (entry) => entry.findingId === row.findingId });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  const answer = async (row, text) => {
    setBusy(row.questionId);
    try {
      await api.put(`/audits/${row.auditId}/questions/${row.questionId}`, {
        status: 'answered',
        answer: text,
      });
      toast.success('Answered', `${row.from} will see it on their link.`);
      drop({ question: (entry) => entry.questionId === row.questionId });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  const tabs = [
    { value: 'all', label: 'Everything', count: totals.claims + totals.questions || undefined },
    { value: 'claims', label: 'To verify', count: totals.claims || undefined },
    { value: 'questions', label: 'Questions', count: totals.questions || undefined },
    { value: 'mine', label: 'Mine', count: totals.mine || undefined },
  ];

  const nothing = shownClaims.length === 0 && shownQuestions.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Verification"
        description="What clients have told us through their links, and nobody has dealt with yet."
      />

      {loading && !data ? (
        <LoadingBlock label="Reading every engagement…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Tabs options={tabs} value={show} onChange={setShow} size="sm" />
            {totals.oldestDays != null && totals.oldestDays >= 1 ? (
              <span className="text-xs text-fg-subtle sm:ml-auto">
                The oldest has been waiting {totals.oldestDays}{' '}
                {totals.oldestDays === 1 ? 'day' : 'days'}.
              </span>
            ) : null}
          </div>

          {nothing ? (
            <EmptyState
              icon={CheckCircle2}
              title={
                mineOnly ? 'Nothing here is yours' : 'Nothing is waiting on a reply or a retest'
              }
              description={
                mineOnly
                  ? 'Claims and questions on engagements you are on will appear here.'
                  : 'When a client marks a finding fixed or asks something through their link, it lands here until somebody deals with it.'
              }
            />
          ) : null}

          {shownClaims.length ? (
            <Card>
              <CardHeader
                title="Claims waiting to be verified"
                description="They say it is done. Nobody on the team has checked yet — retesting one clears the claim."
                icon={CircleDot}
              />
              <ul className="divide-y divide-line-soft">
                {shownClaims.map((row) => (
                  <ClaimRow
                    key={`${row.auditId}:${row.findingId}`}
                    row={row}
                    canAct={canAct(row)}
                    busy={busy}
                    onSet={setStatus}
                  />
                ))}
              </ul>
            </Card>
          ) : null}

          {shownQuestions.length ? (
            <Card>
              <CardHeader
                title="Questions waiting for an answer"
                description="Asked through a share link, by somebody with no account and no other way to reach us."
                icon={ShieldQuestion}
              />
              <ul className="divide-y divide-line-soft">
                {shownQuestions.map((row) => (
                  <QuestionRow
                    key={row.questionId}
                    row={row}
                    canAct={canAct(row)}
                    busy={busy}
                    onAnswer={answer}
                  />
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
