import { useState } from 'react';
import { Loader2, MessageCircleQuestion, Send } from 'lucide-react';

import { api } from '../../lib/api.js';
import { Button } from '../ui/Button.jsx';

/**
 * The other half of the conversation: something the client wants to ask.
 *
 * The link has taken "we fixed it, and here is what we changed" for a while. It never took "which
 * of our three load balancers is this about?" — so that question left the page, became an email to
 * whoever's address the reader could find, and arrived nowhere near the finding it was about. The
 * Questions tab has existed the whole time for exactly this conversation, pointed the other way.
 *
 * ## A button, unlike the note beside it
 *
 * The remediation note saves on blur, deliberately: a client who types a sentence and closes the
 * tab has still told us. A question is not that. It is a message to a person, it will produce a
 * reply, and sending half of one because somebody clicked elsewhere is the kind of small
 * embarrassment that stops people using a thing. So this one waits to be sent.
 *
 * ## And the answers are here
 *
 * Asking into a void is worse than not asking. Whatever the team writes back in their Questions
 * tab appears under the question on this page, which is the whole reason the loop is worth closing
 * rather than just capturing.
 */
export default function ClientQuestion({ token, finding }) {
  const [asked, setAsked] = useState(finding.questions ?? []);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  const send = async () => {
    const question = text.trim();
    if (question.length < 3 || sending) return;
    setSending(true);
    setProblem('');
    try {
      const saved = await api.post(`/share/${token}/findings/${finding._id}/question`, {
        text: question,
      });
      setAsked((current) => [...current, saved]);
      setText('');
    } catch (error) {
      /* Said plainly. This reader has no account, no support channel and no idea what an API is. */
      setProblem(error?.message || 'That did not send. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-lg border border-line-soft bg-canvas/40 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
        <MessageCircleQuestion size={13} className="text-fg-subtle" />
        Ask about this
      </p>
      <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-fg-subtle">
        Anything you need to know before you can act on it. It goes to the people who tested this,
        and their reply appears here.
      </p>

      {asked.length ? (
        <ul className="mt-2.5 flex flex-col gap-2.5">
          {asked.map((question) => (
            <li key={question._id} className="rounded-md bg-surface/60 px-3 py-2">
              <p className="text-xs text-fg">{question.text}</p>
              {question.answer ? (
                <p className="mt-1.5 border-l-2 border-brand-500/40 pl-2 text-xs text-fg-muted">
                  {question.answer}
                </p>
              ) : (
                <p className="mt-1 text-[0.6875rem] text-fg-subtle">Waiting for a reply.</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        maxLength={600}
        aria-label={`Ask a question about ${finding.title}`}
        placeholder="Which of our load balancers does this apply to?"
        className="mt-2 w-full resize-y rounded-lg border border-line-soft bg-surface/60 px-3 py-2 text-sm text-fg outline-none transition placeholder:text-fg-subtle focus:border-brand-500/50"
      />

      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={sending ? Loader2 : Send}
          disabled={sending || text.trim().length < 3}
          onClick={send}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {problem ? <span className="text-[0.6875rem] text-crit">{problem}</span> : null}
      </div>
    </div>
  );
}
