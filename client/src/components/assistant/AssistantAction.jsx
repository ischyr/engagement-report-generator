import { useState } from 'react';
import { ShieldCheck, Sparkles } from 'lucide-react';

import { useAssistant } from '../../hooks/useAssistant.js';
import { Button } from '../ui/Button.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * One assistant button, and the dialog that shows what came back.
 *
 * Every one of the four jobs is this component with a different `request` and `preview`, which is
 * the point: there is one place where a suggestion is shown, one place where it is accepted, and
 * therefore one place that can promise the two things this feature has to promise.
 *
 * **Nothing is drawn unless the instance has an assistant.** Not disabled — absent. See
 * `useAssistant`.
 *
 * **Nothing is applied without a click.** The answer arrives in a dialog, the person reads it, and
 * only then does it touch the form — and even then it lands in the editor unsaved, where the
 * ordinary save, the ordinary conflict check and the ordinary undo all still apply. There is no
 * path through this component that writes to an engagement.
 *
 * The footnote under every answer says which model wrote it, how long it took, and how many secrets
 * were taken out of what was sent. That last number is the one that matters: it is the only honest
 * way to tell somebody what left the building, and it is shown whether it is fourteen or zero.
 */
export default function AssistantAction({
  job,
  label,
  title,
  icon = Sparkles,
  size = 'sm',
  variant = 'ghost',
  className,
  disabled,
  request,
  preview,
  applyLabel = 'Use this',
  onApply,
  /**
   * Whether *this particular* answer can be applied.
   *
   * The library job asks a question whose most useful answer is often "none of these", and an
   * answer of "none of these" has nothing to apply. Decided per answer rather than per button,
   * because the button does not know what it is going to get.
   */
  applicable = () => true,
  dialogTitle,
  dialogDescription,
}) {
  const { available, model } = useAssistant(job);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!available) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await request());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setResult(null);
    setError(null);
  };

  const apply = () => {
    onApply?.(result);
    close();
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={icon}
        className={className}
        loading={busy}
        disabled={disabled || busy}
        title={title ?? label}
        onClick={run}
      >
        {label}
      </Button>

      <Modal
        open={Boolean(result || error)}
        onClose={close}
        title={dialogTitle ?? label}
        description={dialogDescription}
        size="lg"
        footer={
          result && onApply && applicable(result) ? (
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Discard
              </Button>
              <Button variant="primary" size="sm" onClick={apply}>
                {applyLabel}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={close}>
                Close
              </Button>
            </div>
          )
        }
      >
        {error ? (
          <Alert tone="warning" title="The assistant could not answer">
            <p>{error.message}</p>
            {/*
              The provider's own words, when there are any. A spent balance, a model name with a
              typo in it and a safety refusal are three completely different afternoons, and
              flattening them into one sentence of ours is how somebody spends one of them on the
              wrong problem.
            */}
            {error.details?.detail ? (
              <p className="mt-2 break-words font-mono text-[0.6875rem] text-fg-subtle">
                {error.details.detail}
              </p>
            ) : null}
          </Alert>
        ) : null}

        {result ? (
          <>
            {/*
              An answer that ran out of room is still shown — half a draft is often worth reading —
              but it is labelled, because a paragraph that stops mid-sentence looks like a model
              being odd rather than a ceiling being hit.
            */}
            {result.cut ? (
              <Alert tone="warning" className="mb-3" title="This was cut off at the token ceiling">
                What is below is as far as it got. It is safe to use and finish by hand.
              </Alert>
            ) : null}
            <div className="text-sm text-fg">{preview?.(result)}</div>

            <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-soft pt-3 text-[0.6875rem] text-fg-subtle">
              <span>
                Drafted by {result.model || model || 'the assistant'}
                {result.ms ? ` in ${(result.ms / 1000).toFixed(1)}s` : ''}.
              </span>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck size={11} />
                {result.redacted
                  ? `${result.redacted} secret${result.redacted === 1 ? '' : 's'} removed before sending`
                  : 'nothing matched the secret patterns before sending'}
                {result.truncated ? ', and the output was trimmed' : ''}.
              </span>
              <span>Nothing has been saved. Read it before you use it.</span>
            </p>
          </>
        ) : null}
      </Modal>
    </>
  );
}
