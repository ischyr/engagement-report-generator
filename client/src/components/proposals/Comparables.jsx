import { History } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';

/**
 * What jobs like this one actually took.
 *
 * Sales types five days; the last three of these took seven. Both numbers have been on the record
 * all along — `daysSold` on the engagement, and the time entries logged against it — and nobody had
 * ever been shown them at the moment the guess is made, which is the only moment they change
 * anything.
 *
 * Read from time logged rather than from the engagement's calendar dates: a job that spanned a
 * fortnight because the client went quiet took the days it took. Engagements with no time recorded
 * are left out rather than counted as zero, which is why this often says "nothing to compare with"
 * on a young instance — and saying so is better than a median of one.
 *
 * Deliberately no client names. The numbers are the useful part, and this renders for sales
 * accounts, which are walled off from engagements everywhere else in the app.
 */
export default function Comparables({ auditType, className = '' }) {
  const { data } = useResource(
    auditType ? `/proposals/comparables?auditType=${encodeURIComponent(auditType)}` : null,
    { initial: null }
  );

  if (!auditType || !data || !data.samples) return null;

  const { actual, sold, gap, samples } = data;

  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5 ${className}`}
    >
      <p className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wider text-fg-subtle">
        <History size={12} />
        What {samples === 1 ? 'the last one' : `the last ${samples}`} took
      </p>
      <p className="text-sm text-fg">
        <span className="font-mono">{actual.median}</span> days, typically
        {actual.min !== actual.max ? (
          <span className="text-fg-muted">
            {' '}
            (between {actual.min} and {actual.max})
          </span>
        ) : null}
      </p>
      {sold.median !== null ? (
        <p className="text-[0.6875rem] text-fg-muted">
          Sold as {sold.median} ·{' '}
          {gap.median === null || gap.median === 0 ? (
            'about right'
          ) : gap.median > 0 ? (
            <span className="text-warn">
              ran over by {gap.median} on average, {gap.over} of {samples} over
            </span>
          ) : (
            <span className="text-low">came in under by {Math.abs(gap.median)} on average</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
