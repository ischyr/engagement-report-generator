import { CalendarOff, CheckCircle2, Clock, OctagonAlert, UserX } from 'lucide-react';

import { Badge } from '../ui/Badge.jsx';
import { displayName, formatDate } from '../../lib/utils.js';

/**
 * Who can actually look at this, over the next working week.
 *
 * A plain block rather than a card, so the same markup serves the panel on the Overview and the
 * dialog in front of the review button — one wording, whichever way somebody meets it.
 */
export default function ReviewReadiness({ data, compact = false }) {
  if (!data) return null;

  if (data.noReviewers) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
        <UserX size={15} className="mt-0.5 shrink-0 text-med" />
        <span>{data.summary}</span>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The headline first: every reviewer unreachable is the case worth interrupting for. */}
      {data.stalled ? (
        <p className="flex items-start gap-2 rounded-lg border border-crit/25 bg-crit/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
          <OctagonAlert size={15} className="mt-0.5 shrink-0 text-crit" />
          <span>
            <strong className="font-semibold text-fg">{data.summary}</strong>{' '}
            {data.soonestBackOn
              ? `The soonest anybody is back is ${formatDate(data.soonestBackOn)}. `
              : ''}
            A request now waits in an inbox nobody opens — which is how a finished engagement sits
            still for a week.
          </span>
        </p>
      ) : data.summary ? (
        <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
          <CalendarOff size={15} className="mt-0.5 shrink-0 text-med" />
          <span>{data.summary}</span>
        </p>
      ) : compact ? null : (
        <p className="flex items-start gap-2 rounded-lg border border-low/25 bg-low/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-low" />
          <span>
            Every reviewer is around between {formatDate(data.from)} and {formatDate(data.to)}.
          </span>
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {data.reviewers.map((person) => {
          const blocked = person.away || person.accessExpired;
          return (
            <li
              key={person._id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-fg">
                {displayName(person) || person.username}
              </span>

              {person.accessExpired ? (
                <Badge tone="danger" icon={UserX}>
                  access has expired
                </Badge>
              ) : person.away ? (
                <Badge tone="danger" icon={CalendarOff}>
                  away all week
                  {person.backOn ? ` · back ${formatDate(person.backOn)}` : ''}
                </Badge>
              ) : person.partly ? (
                <Badge tone="warning" icon={CalendarOff}>
                  {person.availableDays} of {person.workingDays} days
                </Badge>
              ) : (
                <Badge tone="success" icon={CheckCircle2}>
                  available
                </Badge>
              )}

              {/* Access running out mid-window is the quieter trap: the request arrives, and by
                  the time they get to it the engagement has left their list. */}
              {person.accessExpiresOn ? (
                <Badge tone="warning" icon={Clock}>
                  access ends {formatDate(person.accessExpiresOn)}
                </Badge>
              ) : null}

              {/*
                Booked days are context, never a verdict. Being on another engagement does not
                stop you reading a report; being on holiday does, and conflating the two would
                make this warn about almost everybody almost always.
              */}
              {!blocked && person.bookedDays ? (
                <span className="text-[0.625rem] text-fg-subtle">
                  booked {person.bookedDays} of {person.workingDays} elsewhere
                </span>
              ) : null}

              {person.clash && !person.accessExpired ? (
                <span className="w-full text-[0.625rem] leading-relaxed text-fg-subtle">
                  {person.clash}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
