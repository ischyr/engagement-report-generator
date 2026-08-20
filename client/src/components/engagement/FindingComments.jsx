import { useState } from 'react';
import { Check, MessageSquare, Send, Trash2, Undo2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, timeAgo } from '../../lib/utils.js';
import { announceMentions } from '../../lib/mentions.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';
import MentionTextarea from '../ui/MentionTextarea.jsx';

/**
 * Renders a comment body with `@handles` picked out.
 *
 * Split rather than replaced into HTML: comment bodies are user text, and putting
 * them through dangerouslySetInnerHTML for the sake of some colour would be a
 * self-inflicted XSS.
 */
function CommentBody({ body, me }) {
  const parts = String(body ?? '').split(/(@[a-z0-9._-]{3,40})/gi);
  return (
    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
      {parts.map((part, index) =>
        part.startsWith('@') ? (
          <span
            key={index}
            className={cn(
              'rounded px-0.5 font-medium',
              part.slice(1).toLowerCase() === me
                ? 'bg-brand-500/20 text-brand-300'
                : 'text-brand-300'
            )}
          >
            {part}
          </span>
        ) : (
          part
        )
      )}
    </p>
  );
}

/**
 * Review conversation on a finding.
 *
 * Internal only — the server strips comments from report data, so reviewers can be
 * blunt without worrying about what a client might see. Resolving keeps the thread
 * as a record rather than deleting it, which matters when someone asks later why a
 * finding was worded a particular way.
 */
export default function FindingComments({ auditId, finding, onChanged }) {
  const { user, isAdmin, canWrite } = useAuth();
  const toast = useToast();

  // Only fetched to complete @handles; the server is what actually resolves them.
  const people = useResource(canWrite ? '/users?active=true' : null, { initial: [] });

  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

  const comments = finding.comments ?? [];
  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);
  const visible = showResolved ? comments : open;

  // A finding must be saved before it has an id to hang comments off.
  if (!finding._id) {
    return (
      <Card>
        <CardHeader
          title="Comments"
          icon={MessageSquare}
          description="Save the finding first, then you and your reviewers can discuss it here."
        />
      </Card>
    );
  }

  const post = async (event) => {
    event.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      const saved = await api.post(`/audits/${auditId}/findings/${finding._id}/comments`, { body });
      setBody('');

      // Say who was actually notified. A misspelled handle silently reaches nobody,
      // which is worth telling the author about while they can still fix it.
      announceMentions(toast, saved);

      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setPosting(false);
    }
  };

  const setResolved = async (comment, next) => {
    setBusyId(comment._id);
    try {
      await api.put(`/audits/${auditId}/findings/${finding._id}/comments/${comment._id}`, {
        resolved: next,
      });
      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (comment) => {
    setBusyId(comment._id);
    try {
      await api.del(`/audits/${auditId}/findings/${finding._id}/comments/${comment._id}`);
      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusyId(null);
    }
  };

  const mine = (comment) =>
    isAdmin || (comment.author?._id ?? comment.author) === (user?.id ?? user?._id);

  return (
    <Card>
      <CardHeader
        title="Comments"
        icon={MessageSquare}
        description="Internal review notes — never included in the generated report."
        actions={
          <div className="flex items-center gap-2">
            {open.length ? <Badge tone="warning">{open.length} open</Badge> : null}
            {resolved.length ? (
              <button
                type="button"
                onClick={() => setShowResolved((v) => !v)}
                className="text-[0.6875rem] text-fg-muted transition hover:text-fg"
              >
                {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
              </button>
            ) : null}
          </div>
        }
      />

      <CardBody className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <p className="text-xs text-fg-subtle">
            {comments.length ? 'Nothing open — all comments are resolved.' : 'No comments yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {visible.map((comment) => (
              <li
                key={comment._id}
                className={cn(
                  'flex gap-2.5 rounded-lg border px-3 py-2.5',
                  comment.resolved
                    ? 'border-line-soft bg-white/[0.02] opacity-70'
                    : 'border-line-soft bg-canvas/40'
                )}
              >
                <Avatar user={comment.author} size={26} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-fg">{displayName(comment.author)}</span>
                    <span className="text-fg-subtle">{timeAgo(comment.createdAt)}</span>
                    {comment.field ? (
                      <Badge tone="neutral">on {comment.field}</Badge>
                    ) : null}
                    {comment.resolved ? (
                      <Badge tone="success" icon={Check}>
                        Resolved
                      </Badge>
                    ) : null}
                  </p>
                  <CommentBody body={comment.body} me={user?.username} />
                </div>
                {canWrite ? (
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={comment.resolved ? Undo2 : Check}
                      title={comment.resolved ? 'Reopen' : 'Mark resolved'}
                      loading={busyId === comment._id}
                      onClick={() => setResolved(comment, !comment.resolved)}
                    />
                    {mine(comment) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Trash2}
                        title="Delete"
                        className="hover:text-crit"
                        onClick={() => remove(comment)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canWrite ? (
          <form onSubmit={post} className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <MentionTextarea
              rows={2}
              value={body}
              users={people.data ?? []}
              placeholder="Leave a note for whoever reviews this… type @ to mention someone"
              onChange={setBody}
              // Enter sends, Shift+Enter makes a new line — the convention
              // everywhere else people write short messages. MentionTextarea
              // intercepts Enter first while its suggestion list is open.
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) post(event);
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.625rem] text-fg-subtle">
                Enter to send · Shift+Enter for a new line · @ to mention
              </span>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                icon={Send}
                loading={posting}
                disabled={!body.trim()}
              >
                Comment
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
