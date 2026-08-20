import { useState } from 'react';
import { BadgeCheck, CalendarOff, PenLine, ShieldCheck, TriangleAlert, Undo2, UserX } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, formatDate, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';

const idOf = (value) => String(value?._id ?? value?.id ?? value ?? '');

/**
 * Sign-off, which until now had an endpoint and no way to reach it.
 *
 * The server decided who may approve; this only explains the decision before it is
 * made, so nobody presses a button to be told no. Same rules, stated in advance:
 * reviewers only, never the author, and not while the report is still being written.
 */
export default function SignOffCard({ audit, onReload }) {
  const { user } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  /*
   * Whether the people this is waiting on are actually available.
   *
   * Fetched here because this is the card somebody opens to ask why a report has not been signed
   * off, and "she has been on holiday since Tuesday" is the answer more often than anything about
   * the report. Not fetched once approved: who was on leave stops mattering the moment it is.
   */
  const { data: readiness } = useResource(
    audit.state === 'APPROVED' ? null : `/audits/${audit._id}/review-readiness`,
    { initial: null }
  );
  const availability = (id) =>
    (readiness?.reviewers ?? []).find((row) => idOf(row) === idOf(id)) ?? null;

  const me = idOf(user);
  const reviewers = audit.reviewers ?? [];
  const approvals = audit.approvals ?? [];
  const current = audit.contentFingerprint ?? '';

  // The server's rule, restated: with nothing to compare, a signature is of unknown
  // vintage rather than stale, so it is left alone.
  const isStale = (approval) =>
    Boolean(current) && Boolean(approval.fingerprint) && approval.fingerprint !== current;

  const mine = approvals.find((approval) => idOf(approval.user) === me);
  const fresh = approvals.filter((approval) => !isStale(approval));
  const stale = approvals.length - fresh.length;

  const amReviewer = reviewers.some((reviewer) => idOf(reviewer) === me);
  const amCreator = idOf(audit.creator) === me;

  const blockedBecause = !amReviewer
    ? 'Only a reviewer on this engagement can sign it off.'
    : amCreator
      ? 'You created this engagement, so it needs somebody else to sign it off.'
      : audit.state === 'EDIT'
        ? 'Sign-off opens once this moves to review.'
        : user?.role === 'readonly'
          ? 'Your account is read-only.'
          : '';

  const toggle = async () => {
    setSaving(true);
    try {
      const result = await api.post(`/audits/${audit._id}/approve`, {});
      toast.success(
        result.approved ? 'Signed off' : 'Sign-off withdrawn',
        result.approved
          ? 'Recorded against the report as it stands. Editing it will show your signature as out of date.'
          : 'Your name is off this report.'
      );
      await onReload?.();
    } catch (err) {
      toast.fromError(err, 'Could not record that');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={ShieldCheck}
        title="Sign-off"
        description={
          reviewers.length
            ? `${fresh.length} of ${reviewers.length} reviewer${
                reviewers.length === 1 ? '' : 's'
              } have signed off on the report as it stands.`
            : 'Nobody is a reviewer on this engagement yet, so nobody can sign it off.'
        }
        actions={
          stale ? (
            <Badge tone="warning">
              {stale} out of date
            </Badge>
          ) : fresh.length ? (
            <Badge tone="success">{fresh.length} signed</Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        {/*
          Said once, at the top, when it is the reason nothing is happening. `worthSaying` is the
          server's judgement rather than this card's, so the banner here and the dialog in front
          of the review button agree about what counts as worth an interruption.
        */}
        {readiness?.worthSaying ? (
          <p
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted',
              readiness.stalled
                ? 'border-crit/25 bg-crit/[0.06]'
                : 'border-med/25 bg-med/[0.06]'
            )}
          >
            <CalendarOff
              size={15}
              className={cn('mt-0.5 shrink-0', readiness.stalled ? 'text-crit' : 'text-med')}
            />
            <span>{readiness.summary}</span>
          </p>
        ) : null}

        {reviewers.length ? (
          <ul className="flex flex-col gap-0.5">
            {reviewers.map((reviewer) => {
              const approval = approvals.find((entry) => idOf(entry.user) === idOf(reviewer));
              const outOfDate = approval ? isStale(approval) : false;
              return (
                <li
                  key={idOf(reviewer)}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 odd:bg-white/[0.02]"
                >
                  <Avatar user={reviewer} size={22} />
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">
                    {displayName(reviewer)}
                    {idOf(reviewer) === idOf(audit.creator) ? (
                      <span className="ml-1.5 text-[0.625rem] text-fg-subtle">
                        · author, cannot sign off
                      </span>
                    ) : null}
                  </span>
                  {approval ? (
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 text-[0.625rem]',
                        outOfDate ? 'text-med' : 'text-low'
                      )}
                      title={
                        outOfDate
                          ? 'Signed before the report changed, so it no longer counts'
                          : 'Signed off on the report as it stands'
                      }
                    >
                      {outOfDate ? <TriangleAlert size={11} /> : <BadgeCheck size={11} />}
                      {outOfDate ? 'out of date' : 'signed'}
                      {approval.at ? <span className="text-fg-subtle">{timeAgo(approval.at)}</span> : null}
                    </span>
                  ) : (
                    /*
                      "Waiting" on its own invites the wrong conclusion — that somebody is
                      ignoring it. Where the schedule knows better, it says so instead.
                    */
                    (() => {
                      const free = availability(reviewer);
                      if (free?.accessExpired) {
                        return (
                          <span
                            className="flex shrink-0 items-center gap-1.5 text-[0.625rem] text-crit"
                            title="Their access to this engagement has run out, so they were not notified"
                          >
                            <UserX size={11} />
                            no longer has access
                          </span>
                        );
                      }
                      if (free?.away) {
                        return (
                          <span
                            className="flex shrink-0 items-center gap-1.5 text-[0.625rem] text-med"
                            title={free.clash ?? 'Away for the whole of the coming week'}
                          >
                            <CalendarOff size={11} />
                            away
                            {free.backOn ? ` · back ${formatDate(free.backOn)}` : ''}
                          </span>
                        );
                      }
                      if (free?.partly) {
                        return (
                          <span
                            className="flex shrink-0 items-center gap-1.5 text-[0.625rem] text-fg-muted"
                            title={free.clash ?? ''}
                          >
                            <CalendarOff size={11} />
                            waiting · {free.availableDays} of {free.workingDays} days
                          </span>
                        );
                      }
                      return <span className="shrink-0 text-[0.625rem] text-fg-subtle">waiting</span>;
                    })()
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Approvals from people since taken off the reviewer list still exist and
            still count, so they must be visible somewhere. */}
        {approvals.some(
          (approval) => !reviewers.some((reviewer) => idOf(reviewer) === idOf(approval.user))
        ) ? (
          <p className="text-[0.625rem] text-fg-subtle">
            {approvals
              .filter((a) => !reviewers.some((r) => idOf(r) === idOf(a.user)))
              .map((a) => displayName(a.user))
              .join(', ')}{' '}
            signed off and are no longer listed as reviewers.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
          {mine ? (
            <Button
              variant="ghost"
              size="sm"
              icon={Undo2}
              loading={saving}
              onClick={toggle}
              title="Take your name off this report"
            >
              Withdraw my sign-off
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={PenLine}
              loading={saving}
              disabled={Boolean(blockedBecause)}
              onClick={toggle}
              title={blockedBecause || 'Record that you have reviewed this report'}
            >
              Sign off
            </Button>
          )}
          <p className="min-w-0 flex-1 text-[0.625rem] leading-snug text-fg-subtle">
            {blockedBecause ||
              (mine && isStale(mine)
                ? 'The report changed after you signed it. Read it again and sign off to renew it.'
                : 'A signature covers the report as it reads now — editing it afterwards shows the signature as out of date.')}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
