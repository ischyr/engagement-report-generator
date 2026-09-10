import { useMemo } from 'react';
import { Award, CalendarClock } from 'lucide-react';

import { cn, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { expiryState, monthsAway } from './skills-meta.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Everything the team holds, grouped by who issued it, and when it runs out.
 *
 * A certification nobody notices lapsing is the failure this page exists to prevent, and a
 * flat list sorted by name is exactly the shape that hides it. Grouped by issuer because
 * renewals are arranged with an issuer, one at a time — and with a twelve-month strip on top,
 * because "three things lapse in March" is a staffing decision and no list of dates says it.
 */
export default function CertificationWall({ people, onPick }) {
  const { rows, byIssuer, calendar, worst } = useMemo(() => {
    const flat = people.flatMap((person) =>
      (person.certifications ?? []).map((entry) => ({
        person,
        entry,
        state: expiryState(entry.expiresAt),
      }))
    );

    const groups = new Map();
    for (const row of flat) {
      const key = (row.entry.issuer || 'Unattributed').trim().toLowerCase();
      const group =
        groups.get(key) ??
        { name: (row.entry.issuer || 'Unattributed').trim(), items: [], attention: 0 };
      group.items.push(row);
      if (row.state.key === 'expired' || row.state.key === 'expiring') group.attention += 1;
      groups.set(key, group);
    }

    /*
     * The next twelve months, one column each.
     *
     * Counted forwards from this month rather than as a calendar year: a wall chart that
     * stops on 31 December is useless in November, which is when renewals are planned.
     */
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, offset) => {
      const at = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      return {
        key: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`,
        label: MONTHS[at.getMonth()],
        year: at.getFullYear(),
        items: [],
      };
    });
    const index = new Map(months.map((month) => [month.key, month]));
    for (const row of flat) {
      if (!row.entry.expiresAt) continue;
      const month = index.get(row.entry.expiresAt.slice(0, 7));
      if (month) month.items.push(row);
    }
    const peak = Math.max(1, ...months.map((month) => month.items.length));

    return {
      rows: flat,
      byIssuer: [...groups.values()].sort(
        (a, b) => b.attention - a.attention || b.items.length - a.items.length || a.name.localeCompare(b.name)
      ),
      calendar: { months, peak },
      worst: flat.filter((row) => row.state.key === 'expired' || row.state.key === 'expiring').length,
    };
  }, [people]);

  if (!rows.length) {
    return (
      <Card>
        <EmptyState
          icon={Award}
          title="No certifications recorded"
          description="Add what you hold and when it lapses, and the wall below turns into a renewal plan instead of a surprise."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={CalendarClock}
          title="The next twelve months"
          description="What lapses, and when. Counted from this month rather than from January, because that is when renewals get planned."
          actions={
            worst ? <Badge tone="warning">{worst} need attention</Badge> : <Badge tone="success">all in date</Badge>
          }
        />
        <CardBody>
          <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
            {calendar.months.map((month) => {
              const height = month.items.length ? 12 + (month.items.length / calendar.peak) * 52 : 4;
              const urgent = month.items.some((row) => row.state.key !== 'valid');
              return (
                <span key={month.key} className="flex min-w-10 flex-1 flex-col items-center gap-1.5">
                  {/* The count is written above the bar, so the bar is a comparison and never
                      the value itself. */}
                  <span className="font-mono text-[0.625rem] tabular-nums text-fg-muted">
                    {month.items.length || ''}
                  </span>
                  <span
                    title={
                      month.items.length
                        ? month.items
                            .map((row) => `${row.entry.name} — ${row.person.fullname}`)
                            .join('\n')
                        : 'Nothing lapses this month'
                    }
                    className={cn(
                      'w-full rounded-t-md',
                      month.items.length
                        ? urgent
                          ? 'bg-med/70'
                          : 'bg-brand-400/60'
                        : 'bg-white/8'
                    )}
                    style={{ height }}
                  />
                  <span className="text-[0.5625rem] uppercase tracking-wide text-fg-subtle">
                    {month.label}
                  </span>
                </span>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {byIssuer.map((group) => (
          <Card key={group.name}>
            <CardHeader
              icon={Award}
              title={group.name}
              description={`${group.items.length} held by ${
                new Set(group.items.map((row) => row.person.id)).size
              } ${new Set(group.items.map((row) => row.person.id)).size === 1 ? 'person' : 'people'}`}
              actions={group.attention ? <Badge tone="warning">{group.attention}</Badge> : null}
            />
            <CardBody className="flex flex-col gap-1.5">
              {group.items
                .sort((a, b) =>
                  (a.entry.expiresAt || '9999').localeCompare(b.entry.expiresAt || '9999')
                )
                .map((row) => {
                  const months = monthsAway(row.entry.expiresAt);
                  return (
                    <button
                      key={`${row.person.id}-${row.entry.name}-${row.entry.obtainedAt}`}
                      type="button"
                      onClick={() => onPick?.(row.person)}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-left text-xs transition hover:border-line hover:bg-canvas/70"
                    >
                      <Avatar user={row.person} size={20} />
                      <span className="truncate font-medium text-fg">{row.entry.name}</span>
                      <span className="truncate text-fg-subtle">{row.person.fullname}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {row.entry.expiresAt ? (
                          <span className="text-[0.625rem] text-fg-subtle">
                            {formatDate(row.entry.expiresAt)}
                            {months !== null && months >= 0 && months <= 12
                              ? ` · ${months === 0 ? 'this month' : `${months}mo`}`
                              : ''}
                          </span>
                        ) : null}
                        <Badge tone={row.state.tone}>{row.state.label}</Badge>
                      </span>
                    </button>
                  );
                })}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
