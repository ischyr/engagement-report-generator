import { useState } from 'react';
import { CircleHelp, MessageSquareQuote, Plus, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName, timeAgo } from '../../lib/utils.js';
import { offerUndo } from '../../lib/undo.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea, Toggle } from '../ui/Field.jsx';
import { Badge } from '../ui/Badge.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * What the client still has to answer, and what was assumed while waiting.
 *
 * Every test accumulates these — is this host in scope, is this behaviour intentional, may we test
 * the payment flow — and they live in email until the report needs a caveats paragraph, which then
 * gets written from memory three weeks later.
 *
 * The third state is the point. A question nobody answers does not stop the work: somebody assumes
 * something and carries on, and *that assumption* is what the report has to declare. Recording it
 * as an assumption rather than as an unanswered question is the difference between a caveat the
 * client can challenge and a gap nobody mentions.
 *
 * `{{#assumptions}}` prints them, so the paragraph writes itself from what actually happened.
 */
const STATUS = {
  open: { label: 'Waiting', tone: 'warning', hint: 'Nobody has answered yet.' },
  answered: { label: 'Answered', tone: 'success', hint: 'They told us.' },
  assumed: { label: 'Assumed', tone: 'neutral', hint: 'Nobody did, so we assumed this.' },
};

export default function QuestionsTab({ audit, editable }) {
  const toast = useToast();
  const { data, loading, reload } = useResource(`/audits/${audit._id}/questions`, {
    initial: { questions: [] },
  });
  const [draft, setDraft] = useState({ text: '', context: '', askedOf: '' });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const questions = data?.questions ?? [];
  const open = questions.filter((question) => question.status === 'open');

  const add = async () => {
    if (!draft.text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/audits/${audit._id}/questions`, draft);
      setDraft({ text: '', context: '', askedOf: '' });
      setAdding(false);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (question, changes) => {
    try {
      await api.put(`/audits/${audit._id}/questions/${question._id}`, changes);
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  const remove = async (question) => {
    try {
      const result = await api.del(`/audits/${audit._id}/questions/${question._id}`);
      await reload({ quiet: true });
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: () => reload({ quiet: true }),
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading) return <LoadingBlock label="Loading the questions…" />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={CircleHelp}
          title="Questions and assumptions"
          description="What the client has to answer, and what was assumed when nobody did. Anything marked to print becomes the report's caveats, written as it happened rather than remembered afterwards."
          actions={
            editable ? (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
                Note a question
              </Button>
            ) : null
          }
        />

        {open.length ? (
          <CardBody className="border-b border-line-soft">
            <p className="text-xs text-med">
              {open.length === 1
                ? 'One question is still unanswered.'
                : `${open.length} questions are still unanswered.`}{' '}
              Settle them before the report goes out — as answered if they replied, as an assumption
              if they did not.
            </p>
          </CardBody>
        ) : null}

        {adding ? (
          <CardBody className="flex flex-col gap-3 border-b border-line-soft">
            <Textarea
              label="The question"
              rows={2}
              autoFocus
              placeholder="Is the staging host in scope? It answers on the same certificate as production."
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Where it came from"
                placeholder="staging.acme.example"
                value={draft.context}
                onChange={(event) => setDraft({ ...draft, context: event.target.value })}
              />
              <Input
                label="Asked of"
                placeholder="Dana, on the kickoff call"
                value={draft.askedOf}
                onChange={(event) => setDraft({ ...draft, askedOf: event.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" loading={busy} onClick={add}>
                Note it
              </Button>
            </div>
          </CardBody>
        ) : null}

        <CardBody className="p-0">
          {questions.length ? (
            <ul className="divide-y divide-line-soft">
              {questions.map((question) => {
                const meta = STATUS[question.status] ?? STATUS.open;
                return (
                  <li key={question._id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg">
                        {question.text}
                      </p>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {editable ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Remove"
                          className="hover:text-crit"
                          onClick={() => remove(question)}
                        />
                      ) : null}
                    </div>

                    <p className="flex flex-wrap gap-x-3 text-[0.6875rem] text-fg-subtle">
                      {question.context ? <span>{question.context}</span> : null}
                      {question.askedOf ? <span>asked of {question.askedOf}</span> : null}
                      {question.askedBy ? <span>by {displayName(question.askedBy)}</span> : null}
                      <span>{timeAgo(question.createdAt)}</span>
                    </p>

                    {editable ? (
                      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                        <Select
                          value={question.status}
                          onChange={(event) => patch(question, { status: event.target.value })}
                          options={[
                            { value: 'open', label: 'Waiting on them' },
                            { value: 'answered', label: 'They answered' },
                            { value: 'assumed', label: 'We assumed' },
                          ]}
                        />
                        <Input
                          placeholder={
                            question.status === 'assumed'
                              ? 'What was assumed, in the words the report should use'
                              : 'What they said'
                          }
                          defaultValue={question.answer}
                          onBlur={(event) => {
                            if (event.target.value !== question.answer) {
                              patch(question, { answer: event.target.value });
                            }
                          }}
                        />
                      </div>
                    ) : question.answer ? (
                      <p className="rounded bg-white/[0.03] px-3 py-2 text-xs text-fg-muted">
                        {question.answer}
                      </p>
                    ) : null}

                    {editable ? (
                      <Toggle
                        checked={question.print}
                        onChange={(print) => patch(question, { print })}
                        label="Print it in the report"
                        hint={
                          question.status === 'open'
                            ? 'An unanswered question is usually something to chase rather than to publish.'
                            : meta.hint
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              icon={MessageSquareQuote}
              title="Nothing to ask yet"
              description="Note the questions as they come up — is this in scope, is this intentional, who owns this. The ones nobody answers become the report's caveats, and this is where they come from."
              actionLabel={editable ? 'Note a question' : undefined}
              actionIcon={Plus}
              onAction={editable ? () => setAdding(true) : undefined}
            />
          )}
        </CardBody>
      </Card>

      <p className={cn('text-[0.6875rem] text-fg-subtle')}>
        Templates print these with <code>{'{{#assumptions}}'}</code>, or the whole log with{' '}
        <code>{'{{#questions}}'}</code>.
      </p>
    </div>
  );
}
