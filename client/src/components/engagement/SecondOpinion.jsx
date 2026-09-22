import { useState } from 'react';
import { HelpCircle, Send, X } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Select, Textarea } from '../ui/Field.jsx';
import { Badge } from '../ui/Badge.jsx';

/**
 * One question about one finding.
 *
 * Reviews here are an engagement-level quorum — somebody reads the whole report and approves it.
 * That is the right shape for signing a report off and the wrong shape for the review interaction
 * that actually happens twenty times a week: *is this really a High?*, *have I got the remediation
 * right for their stack?* Asking that had nowhere to go, so it went to chat, where the answer is
 * gone by the time a client asks why the score is what it is.
 *
 * Asked **of** somebody or of nobody, and the difference is the point. Half the time you want a
 * particular person's eye — they wrote the last report for this client — and half the time you
 * want whoever is free, which is a question the whole team can see rather than one person's
 * private obligation.
 *
 * The answer is posted as an ordinary comment, so it sits in the thread the rest of the review
 * chatter is in and can be quoted months later. What this component owns is only the *state*: that
 * something is outstanding, and who it is outstanding on.
 */
export default function SecondOpinion({ auditId, finding, onChanged }) {
  const { user, canWrite } = useAuth();
  const toast = useToast();
  const people = useResource(canWrite ? '/users?active=true' : null, { initial: [] });

  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [of, setOf] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = finding?.secondOpinion;
  const outstanding = Boolean(ask?.askedAt && !ask?.answeredAt);
  const me = String(user?.id ?? user?._id ?? '');
  const mine = outstanding && String(ask.askedBy?._id ?? ask.askedBy ?? '') === me;

  if (!finding?._id) return null;

  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/audits/${auditId}/findings/${finding._id}/second-opinion`, {
        question: question.trim(),
        ...(of ? { of } : {}),
      });
      setAsking(false);
      setQuestion('');
      setOf('');
      toast.success(
        'Asked',
        of ? 'They have been told.' : 'Everybody on this engagement has been told.'
      );
      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const settle = async (body) => {
    setBusy(true);
    try {
      const result = await api.put(
        `/audits/${auditId}/findings/${finding._id}/second-opinion`,
        body
      );
      setAnswer('');
      toast.success(result.withdrawn ? 'Withdrawn' : 'Answered', 'It is on the finding.');
      await onChanged?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  if (!outstanding) {
    if (!canWrite) return null;
    return (
      <Card>
        <CardHeader
          icon={HelpCircle}
          title="Not sure about this one?"
          description="Ask somebody to look at this finding on its own — the score, the wording, whether it is really theirs to fix. It waits in their inbox until it is answered, and the answer lands in the comments."
          actions={
            asking ? null : (
              <Button variant="secondary" size="sm" icon={HelpCircle} onClick={() => setAsking(true)}>
                Ask for a second opinion
              </Button>
            )
          }
        />
        {asking ? (
          <CardBody className="flex flex-col gap-3">
            <Textarea
              label="What do you want checked?"
              hint="One sentence. Whoever answers can see the whole finding."
              rows={2}
              value={question}
              placeholder="Is 8.1 defensible when the endpoint needs a valid session?"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <Select
              label="Who?"
              hint="Left as anybody, everyone on this engagement is told and any of them can answer."
              value={of}
              onChange={(event) => setOf(event.target.value)}
            >
              <option value="">Anybody on this engagement</option>
              {(people.data ?? [])
                .filter((person) => String(person._id ?? person.id) !== me)
                .map((person) => (
                  <option key={person._id ?? person.id} value={person._id ?? person.id}>
                    {displayName(person)}
                  </option>
                ))}
            </Select>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" icon={Send} loading={busy} onClick={send}>
                Ask
              </Button>
            </div>
          </CardBody>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className="ring-1 ring-inset ring-info/30">
      <CardHeader
        icon={HelpCircle}
        title="Waiting on a second opinion"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {displayName(ask.askedBy) || 'Somebody'} asked {timeAgo(ask.askedAt)}
            </span>
            <Badge tone={ask.of ? 'info' : 'neutral'}>
              {ask.of ? 'addressed to one person' : 'anybody can answer'}
            </Badge>
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {ask.question ? (
          <p className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-xs text-fg">
            {ask.question}
          </p>
        ) : (
          <p className="text-xs text-fg-muted">No question was written — they want a general look.</p>
        )}

        {canWrite ? (
          mine ? (
            /* Your own question. You can answer it yourself — people do, five minutes later, once
               they have re-read it — but the ordinary thing is to take it back. */
            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                icon={X}
                loading={busy}
                onClick={() => settle({})}
              >
                Never mind, withdraw it
              </Button>
            </div>
          ) : (
            <>
              <Textarea
                label="Your answer"
                hint="It is posted as a comment on this finding, so it is on the record with the rest of the review."
                rows={3}
                value={answer}
                placeholder="The vector is right, but AC:L is generous — it needs a valid session, so AC:H and it lands at 6.8."
                onChange={(event) => setAnswer(event.target.value)}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy}
                  title="Clear the question without writing anything — the log still records that you looked."
                  onClick={() => settle({})}
                >
                  Looks fine to me
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Send}
                  loading={busy}
                  disabled={!answer.trim()}
                  onClick={() => settle({ answer: answer.trim() })}
                >
                  Answer
                </Button>
              </div>
            </>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
