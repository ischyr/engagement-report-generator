import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AtSign,
  CheckCheck,
  ClipboardCheck,
  Inbox as InboxIcon,
  MessageSquare,
  RefreshCw,
  ScrollText,
} from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { useNotifications } from '../context/NotificationsContext.jsx';
import { cn, displayName, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Tabs, Avatar } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * Everything waiting on you, in one place.
 *
 * None of this is new data — it was spread across a review request in the
 * engagements list, an unresolved comment three clicks inside a finding, a mention
 * in a bell that scrolls away, and a check nobody ticked. Four habits, one page.
 */
export default function InboxPage() {
  const { data, error, loading, reload } = useResource('/inbox', { initial: null });
  const { markRead } = useNotifications();
  const [filter, setFilter] = useState('all');

  const counts =
    data?.counts ?? { reviews: 0, mentions: 0, comments: 0, checks: 0, assigned: 0, total: 0 };

  // What is *listed* is not always what is counted: recently read mentions stay on
  // the page as history but are not waiting on anybody. Keeping the two apart is
  // what stops a tab from showing a list and "nothing of that kind" at once.
  const shown = {
    reviews: data?.reviews?.length ?? 0,
    mentions: data?.mentions?.length ?? 0,
    comments: data?.comments?.length ?? 0,
    checks: data?.checks?.length ?? 0,
    assigned: data?.assigned?.length ?? 0,
  };
  const nothingListed =
    shown.reviews + shown.mentions + shown.comments + shown.checks + shown.assigned === 0;

  const tabs = useMemo(
    () => [
      { value: 'all', label: 'Everything', count: counts.total || undefined },
      { value: 'reviews', label: 'To review', count: counts.reviews || undefined },
      { value: 'mentions', label: 'Mentions', count: counts.mentions || undefined },
      { value: 'comments', label: 'Comments', count: counts.comments || undefined },
      // Before the checks you asked for: work handed to you outranks work you are waiting on.
      { value: 'assigned', label: 'Yours to do', count: counts.assigned || undefined },
      { value: 'checks', label: 'Checks', count: counts.checks || undefined },
    ],
    [counts]
  );

  const show = (section) => filter === 'all' || filter === section;

  if (loading && !data) return <LoadingBlock label="Gathering what needs you…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inbox"
        description={
          counts.total === 0
            ? 'Nothing is waiting on you.'
            : `${counts.total} thing${counts.total === 1 ? '' : 's'} waiting on you.`
        }
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            icon={RefreshCw}
            aria-label="Refresh"
            onClick={() => reload({ quiet: true })}
          />
        }
      />

      <Tabs options={tabs} value={filter} onChange={setFilter} />

      {nothingListed ? (
        <Card>
          <EmptyState
            icon={CheckCheck}
            title="You are clear"
            description="Reviews assigned to you, mentions, unresolved comments on your findings, checks somebody gave you, and checks you asked for all show up here."
          />
        </Card>
      ) : null}

      {/* Reviews first: somebody is blocked on them. */}
      {show('reviews') && data.reviews.length ? (
        <Card>
          <CardHeader
            icon={ScrollText}
            title="Waiting for your review"
            description="You are a reviewer on these and have not approved yet."
          />
          <CardBody className="flex flex-col gap-1.5">
            {data.reviews.map((review) => (
              <Link
                key={review.auditId}
                to={`/engagements/${review.auditId}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5 transition hover:border-brand-500/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{review.name}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {[review.reference, review.company].filter(Boolean).join(' · ') ||
                      'No client set'}
                  </p>
                </div>
                <Badge tone={review.approvals >= review.minReviewers ? 'success' : 'warning'}>
                  {review.approvals}/{review.minReviewers} approved
                </Badge>
                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                  {timeAgo(review.updatedAt)}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {show('mentions') && data.mentions.length ? (
        <Card>
          <CardHeader
            icon={AtSign}
            title="Mentions"
            description={
              counts.mentions
                ? 'Unread first — opening one marks it read. Ones you have read stay for a fortnight.'
                : 'Nothing unread. These are the ones you have already read.'
            }
          />
          <CardBody className="flex flex-col gap-1.5">
            {data.mentions.map((mention) => (
              <Link
                key={mention._id}
                to={mention.href || `/engagements/${mention.audit}`}
                onClick={() => !mention.read && markRead(mention._id)}
                className={cn(
                  'flex items-start gap-3 rounded-lg border border-line-soft px-3 py-2.5 transition hover:border-brand-500/40',
                  mention.read ? 'bg-canvas/40' : 'bg-brand-500/[0.07]'
                )}
              >
                <Avatar user={mention.actor} size={24} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-xs leading-snug', mention.read ? 'text-fg-muted' : 'text-fg')}>
                    {mention.message}
                  </p>
                  <p className="mt-0.5 truncate text-[0.625rem] text-fg-subtle">
                    {[mention.auditName, timeAgo(mention.createdAt)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {mention.read ? null : (
                  <span aria-label="Unread" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-400" />
                )}
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {show('comments') && data.comments.length ? (
        <Card>
          <CardHeader
            icon={MessageSquare}
            title="Unresolved comments on your findings"
            description="Somebody asked something about a finding you wrote."
          />
          <CardBody className="flex flex-col gap-1.5">
            {data.comments.map((comment) => (
              <Link
                key={comment.commentId}
                to={`/engagements/${comment.auditId}/findings/${comment.findingId}`}
                className="flex items-start gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5 transition hover:border-brand-500/40"
              >
                <Avatar user={comment.author} size={24} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem]">
                    <span className="font-medium text-fg">{displayName(comment.author)}</span>
                    <span className="text-fg-subtle">on</span>
                    <span className="truncate font-medium text-fg-muted">
                      {comment.findingTitle}
                    </span>
                    {comment.field ? <Badge tone="neutral">{comment.field}</Badge> : null}
                  </p>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-fg-muted">
                    {comment.body}
                  </p>
                  <p className="mt-0.5 truncate text-[0.625rem] text-fg-subtle">
                    {comment.auditName} · {timeAgo(comment.createdAt)}
                  </p>
                </div>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {show('assigned') && data.assigned?.length ? (
        <Card>
          <CardHeader
            icon={ClipboardCheck}
            title="Checks that are yours"
            description="Somebody split the checklist and gave you these. They are not ticked yet."
          />
          <CardBody className="flex flex-col gap-1.5">
            {data.assigned.map((check) => (
              <Link
                key={check.checkId}
                to={`/engagements/${check.auditId}?tab=checks`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">{check.title}</span>
                  <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                    {[check.category, check.auditName].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                  {timeAgo(check.createdAt)}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {show('checks') && data.checks.length ? (
        <Card>
          <CardHeader
            icon={ClipboardCheck}
            title="Checks you asked for, still unverified"
            description="You added these to a checklist and nobody has ticked them."
          />
          <CardBody className="flex flex-col gap-1.5">
            {data.checks.map((check) => (
              <Link
                key={check.checkId}
                to={`/engagements/${check.auditId}?tab=checks`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">{check.title}</span>
                  <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                    {[check.category, check.auditName].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                  {timeAgo(check.createdAt)}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/* A filter that hides everything should say so, not look broken. */}
      {!nothingListed && filter !== 'all' && shown[filter] === 0 ? (
        <Card>
          <EmptyState
            icon={InboxIcon}
            title="Nothing of that kind"
            description="Switch back to Everything to see the rest."
          />
        </Card>
      ) : null}
    </div>
  );
}
