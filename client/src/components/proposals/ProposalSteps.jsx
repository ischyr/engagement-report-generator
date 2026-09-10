import { Check } from 'lucide-react';

import { cn } from '../../lib/utils.js';

/**
 * Where a proposal has got to, and whose turn it is.
 *
 * The status badge says where it *is*; this says what that means and who is holding it, which is
 * the question everybody actually has. Two audiences drive one record and each can only make some
 * of the moves, so "waiting for approval" without naming who is waiting on whom is the thing that
 * gets asked over chat instead of read off the page.
 *
 * Six steps rather than eight statuses: `declined` is not a step on the way anywhere, and
 * `evaluating`/`evaluated` are one step seen from either end of it.
 */
const STEPS = [
  {
    key: 'details',
    label: 'Details',
    who: 'Sales',
    /** What has to happen for this step to be finished, in the second person. */
    todo: 'Write up what the client asked for, attach the pre-engagement document, then send it for evaluation.',
    statuses: ['draft'],
  },
  {
    key: 'evaluation',
    label: 'Evaluation',
    who: 'Delivery',
    todo: 'Say how long the work would really take, and whether we can do it.',
    statuses: ['evaluating'],
  },
  {
    key: 'paperwork',
    label: 'Paperwork',
    who: 'Sales',
    todo: 'Generate the NDA, the permission to attack and the offer, then send them for checking.',
    statuses: ['evaluated'],
  },
  {
    key: 'validation',
    label: 'Validation',
    // Narrower than the other delivery steps on purpose: deciding a contract may leave the
    // building is an authority rather than a skill.
    who: 'Manager',
    todo: 'A manager reads each generated document and either signs it off or sends it back with a reason.',
    statuses: ['documents-review'],
  },
  {
    key: 'offer',
    label: 'Offer',
    who: 'Sales',
    todo: 'The offer is with the client. Mark it accepted when they say yes.',
    statuses: ['sent'],
  },
  {
    key: 'engagement',
    label: 'Engagement',
    who: 'Delivery',
    todo: 'Accepted. Create the engagement, correcting the effort first if it needs it.',
    statuses: ['accepted'],
  },
];

/** Statuses in the order they happen, so "before" and "after" are answerable. */
const ORDER = ['draft', 'evaluating', 'evaluated', 'documents-review', 'sent', 'accepted', 'converted'];

export default function ProposalSteps({ status }) {
  /*
   * `declined` is deliberately not a step. It can happen from anywhere and leads nowhere, so
   * showing it as progress would be a lie about the shape of the flow — it gets its own line.
   */
  if (status === 'declined') {
    return (
      <div className="rounded-xl border border-line-soft bg-surface/60 px-4 py-3">
        <p className="text-sm text-fg">This one was declined.</p>
        <p className="mt-0.5 text-xs text-fg-muted">
          It can be put back to a draft if it comes round again.
        </p>
      </div>
    );
  }

  const at = ORDER.indexOf(status);
  const currentStep = STEPS.findIndex((step) => step.statuses.includes(status));
  const done = status === 'converted';

  return (
    <div className="rounded-xl border border-line-soft bg-surface/60 p-4">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {STEPS.map((step, index) => {
          // A step is behind us if its status sits earlier in the order than where we are.
          const stepAt = ORDER.indexOf(step.statuses[0]);
          const complete = done || stepAt < at;
          const current = index === currentStep;

          return (
            <li key={step.key} className="flex items-center gap-1">
              <div
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5',
                  current ? 'bg-brand-500/12 ring-1 ring-brand-500/30' : null
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold',
                    complete
                      ? 'bg-ok/15 text-ok'
                      : current
                        ? 'bg-brand-500 text-white'
                        : 'bg-white/5 text-fg-subtle'
                  )}
                >
                  {complete ? <Check size={11} /> : index + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-xs font-medium leading-tight',
                      current ? 'text-brand-200' : complete ? 'text-fg-muted' : 'text-fg-subtle'
                    )}
                  >
                    {step.label}
                  </span>
                  {/* Whose turn it is, which is the whole point of the strip. */}
                  <span className="block text-[0.625rem] leading-tight text-fg-subtle">
                    {step.who}
                  </span>
                </span>
              </div>
              {index < STEPS.length - 1 ? (
                <span aria-hidden className="h-px w-3 bg-line-soft sm:w-5" />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* What to do next, said in words rather than left to be inferred from the badge. */}
      {done ? (
        <p className="mt-3 border-t border-line-soft pt-3 text-xs leading-relaxed text-fg-muted">
          Finished — this became an engagement.
        </p>
      ) : currentStep >= 0 ? (
        <p className="mt-3 border-t border-line-soft pt-3 text-xs leading-relaxed text-fg-muted">
          <span className="font-medium text-fg">{STEPS[currentStep].who}:</span>{' '}
          {STEPS[currentStep].todo}
        </p>
      ) : null}
    </div>
  );
}
