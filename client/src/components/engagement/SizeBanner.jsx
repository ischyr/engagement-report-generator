import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';

import { api } from '../../lib/api.js';
import { Alert } from '../ui/Alert.jsx';

/**
 * How close this engagement is to the wall, said before it is hit.
 *
 * An engagement is one MongoDB record and MongoDB refuses a record over 16 MB. That limit is the
 * most consequential number in the platform and it has never been visible anywhere: the first
 * anybody learns of it is a save refusing, mid-paragraph, with the work still on screen.
 *
 * Silent below 60%, because a readout nobody needs is a readout nobody reads — and the point of
 * putting it on the engagement rather than on an administration page is that it appears exactly
 * when it is the operator's problem. The thresholds are deliberately early: at 85% the work that
 * has to move is weeks old and moving it means editing somebody's write-ups; at 60% it is still
 * "trim the pasted scan output on those four steps".
 *
 * It names the biggest part rather than only the number, because "you are at 71%" invites a shrug
 * and "the enumeration steps are 8 MB of it" says what to do.
 */
export default function SizeBanner({ auditId }) {
  const [size, setSize] = useState(null);

  useEffect(() => {
    if (!auditId) return undefined;
    let live = true;
    /*
     * Failure is silence. This is a warning about a limit, not a feature anybody asked for — a
     * banner saying "could not measure the engagement" would be noise about the wrong thing.
     */
    api
      .get(`/audits/${auditId}/size`)
      .then((result) => {
        if (live) setSize(result);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [auditId]);

  if (!size || size.level === 'fine') return null;

  const megabytes = (size.bytes / 1024 / 1024).toFixed(1);
  const biggest = size.parts?.[0];
  const critical = size.level === 'critical';

  return (
    <Alert
      tone={critical ? 'error' : 'warning'}
      icon={Database}
      title={
        critical
          ? `This engagement is ${size.percent}% of the size one can be`
          : `This engagement is getting large — ${size.percent}% of the limit`
      }
    >
      <p>
        {megabytes} MB of the 16 MB a single engagement can hold
        {biggest ? (
          <>
            , and {biggest.label.toLowerCase()} are {biggest.percent}% of that
          </>
        ) : null}
        .{' '}
        {critical
          ? 'Past the limit a save is refused outright, with whatever you were writing still unsaved.'
          : 'Worth trimming before it becomes urgent.'}
      </p>
      <p className="mt-1.5">
        Pasted tool output is almost always the reason. Set a step to print only its first lines
        rather than all of them, or move a long paste into the step&rsquo;s output field, which is
        stored separately and does not count against this.
      </p>
      {size.parts?.length > 1 ? (
        <p className="mt-1.5 text-fg-subtle">
          {size.parts
            .slice(0, 4)
            .map((part) => `${part.label} ${(part.bytes / 1024 / 1024).toFixed(1)} MB`)
            .join(' · ')}
        </p>
      ) : null}
    </Alert>
  );
}
