import { useState } from 'react';
import { CheckCircle2, Loader2, LockKeyhole, MessageSquare, Send } from 'lucide-react';

import { api } from '../../lib/api.js';
import { Button } from '../ui/Button.jsx';
import { Card, CardBody } from '../ui/Card.jsx';

/**
 * The things a client wants to say that are not about one finding.
 *
 * `ClientQuestion` covers "which of our three load balancers is number four about?" — a question
 * with a finding attached. It does not cover the rest of what a client actually says: we have a
 * maintenance window on the 12th, that host is being decommissioned, who do we talk to about the
 * retest. Every one of those used to leave the page, become an email to whatever address the
 * reader could find, and arrive nowhere near the engagement it was about.
 *
 * ## And the one that only matters once the report is closed
 *
 * Signing a report off stops every write on this link, and the refusal said *"tell your contact
 * and they will reopen it"* — sending the reader out of the app to find a human at the exact
 * moment they have discovered they need something. Three routes said that sentence and none of
 * them offered a way to do it.
 *
 * So a closed report shows one button instead of a box. It does not reopen anything: that is a
 * decision with a signature behind it and it stays with the team. It asks, where the team already
 * looks, and says plainly that it has asked — because the failure mode here is a client who
 * presses a button, sees nothing change, and concludes the page is broken.
 */
export default function ClientMessage({ token, closed, allowUpdates }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState('');
  const [problem, setProblem] = useState('');

  /*
   * A read-only link on an open report has nothing to offer here. Reopening is deliberately not
   * behind `allowUpdates` — asking a person for something is not changing the report — so a
   * closed one still draws, whatever the link allows.
   */
  if (!closed && !allowUpdates) return null;

  const send = async () => {
    const message = text.trim();
    if (sending) return;
    if (!closed && message.length < 3) return;
    setSending(true);
    setProblem('');
    try {
      if (closed) {
        const result = await api.post(`/share/${token}/reopen`, { reason: message });
        setDone(
          result?.alreadyAsked
            ? 'You have already asked — your contact has it.'
            : 'Asked. Your contact will be in touch.'
        );
      } else {
        await api.post(`/share/${token}/question`, { text: message });
        setDone('Sent. Your contact will see it with the engagement.');
      }
      setText('');
    } catch (error) {
      /* The client has no account and no support channel: the message has to be the whole story. */
      setProblem(error?.message || 'That did not send. Please try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="mt-6">
      <CardBody className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          {closed ? <LockKeyhole size={15} /> : <MessageSquare size={15} />}
          {closed ? 'This report has been signed off' : 'Something else to tell us?'}
        </p>
        <p className="text-xs text-fg-muted">
          {closed
            ? 'Nothing on this page can be changed now. If you need it opened again — a finding you have since fixed, something that turned out to be wrong — ask here and your contact will take a look.'
            : 'Anything that is not about one particular finding: a maintenance window, a host that is going away, who to talk to about the retest.'}
        </p>

        {done ? (
          <p className="flex items-center gap-2 text-xs text-low">
            <CheckCircle2 size={14} />
            {done}
          </p>
        ) : (
          <>
            <textarea
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={closed ? 'Why, if you would like to say (optional)' : 'What would you like to tell us?'}
              maxLength={600}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand-400"
            />
            {problem ? <p className="text-xs text-crit">{problem}</p> : null}
            <div className="flex justify-end">
              <Button
                size="sm"
                icon={sending ? Loader2 : Send}
                onClick={send}
                disabled={sending || (!closed && text.trim().length < 3)}
              >
                {closed ? 'Ask for it to be reopened' : 'Send'}
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
