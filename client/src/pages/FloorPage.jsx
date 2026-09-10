import { Link } from 'react-router-dom';
import { Clock, MoonStar, Radio, TriangleAlert } from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { cn, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Avatar } from '../components/ui/Misc.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * Who is where, right now — and what nobody is looking at.
 *
 * The heartbeat has always known this. It fed a row of avatars in the sidebar and a "somebody else
 * is in this finding" banner, and both answer a question about *one* record. A lead running three
 * engagements at once has the opposite question and had to open each one to answer it.
 *
 * The Team page is next door and is a different thing: roles and skills, which change monthly. This
 * changes every thirty seconds, which is why it polls and why it is worth its own page rather than
 * a card on one that does not.
 *
 * The third list is the point. "Who is online" is pleasant to look at; "which engagement has had
 * nobody in it since Tuesday" is the one that changes what somebody does next — so it is last,
 * where the eye ends up, rather than first.
 */
const WHERE = {
  findings: 'the findings',
  enumeration: 'the enumeration',
  notes: 'the notes',
  scope: 'the scope',
  overview: 'the overview',
  delivery: 'the delivery record',
  evidence: 'the evidence',
  detection: 'the detection log',
  'a finding': 'a finding',
};

export default function FloorPage() {
  /* Twice the heartbeat's own interval: this is a board somebody glances at, not a live feed. */
  const { data, loading, error } = useResource('/presence/board', {
    initial: null,
    poll: 30_000,
  });

  if (loading && !data) return <LoadingBlock label="Looking around…" />;

  const here = data?.here ?? [];
  const away = data?.away ?? [];
  const quiet = data?.quiet ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Right now"
        description="Where everybody is, and which engagements nobody has been near. Refreshes itself every half minute."
      />

      {error ? (
        <Card>
          <CardBody className="text-xs text-fg-muted">That could not be loaded.</CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={Radio}
            title={`Working now${here.length ? ` · ${here.length}` : ''}`}
            description="Anybody whose browser has said hello in the last minute or so."
          />
          <CardBody className="p-0">
            {here.length ? (
              <ul className="divide-y divide-line-soft">
                {here.map((person) => (
                  <li key={person.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="relative shrink-0">
                      <Avatar user={person} size={30} />
                      {/*
                        Two states, not one: inside the window but quiet for half a minute is a
                        person who has stepped away from a page they left open, and a board that
                        showed them as working would be lying by a small and useful amount.
                      */}
                      <span
                        className={cn(
                          'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface',
                          person.idle ? 'bg-fg-subtle' : 'bg-low'
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-xs font-medium text-fg">
                        {person.fullname}
                        {person.isSelf ? <Badge tone="neutral">you</Badge> : null}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-fg-muted">
                        {person.engagement ? (
                          <>
                            in{' '}
                            <Link
                              to={`/engagements/${person.engagement._id}`}
                              className="text-fg-muted underline decoration-dotted hover:text-fg"
                            >
                              {person.engagement.name}
                            </Link>
                            {person.where ? ` · ${WHERE[person.where] ?? person.where}` : ''}
                          </>
                        ) : (
                          person.activity || 'elsewhere in the app'
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                      {person.idle ? 'idle' : 'active'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-fg-muted">Nobody is about.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={MoonStar}
            title="Not here"
            description="Everybody else, and when they were last seen."
          />
          <CardBody className="max-h-96 overflow-auto p-0">
            {away.length ? (
              <ul className="divide-y divide-line-soft">
                {away.map((person) => (
                  <li key={person.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar user={person} size={24} />
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                      {person.fullname}
                    </span>
                    <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                      {person.lastSeenAt ? timeAgo(person.lastSeenAt) : 'never signed in'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-fg-muted">Everybody is here.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={Clock}
          title={`Nobody has touched these${quiet.length ? ` · ${quiet.length}` : ''}`}
          description="Open engagements with nobody in them and no edit today, longest first. An engagement somebody is in right now is not on this list, whatever its timestamp says."
        />
        <CardBody className="p-0">
          {quiet.length ? (
            <ul className="divide-y divide-line-soft">
              {quiet.map((audit) => (
                <li key={audit._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Link
                    to={`/engagements/${audit._id}`}
                    className="min-w-0 flex-1 truncate text-xs font-medium text-fg hover:underline"
                  >
                    {audit.name}
                  </Link>
                  {audit.onHold ? <Badge tone="warning">on hold</Badge> : null}
                  <span className="flex -space-x-1.5">
                    {audit.team.slice(0, 4).map((person) => (
                      <Avatar key={person.id} user={person} size={20} className="ring-1 ring-surface" />
                    ))}
                  </span>
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1 text-[0.6875rem]',
                      audit.untouchedDays >= 10 ? 'text-med' : 'text-fg-subtle'
                    )}
                  >
                    {audit.untouchedDays >= 10 ? <TriangleAlert size={12} /> : null}
                    {audit.untouchedDays === 1 ? 'yesterday' : `${audit.untouchedDays} days ago`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Clock}
              title="Everything open has been touched today"
              description="Which is either a good day or a small team. Either way there is nothing here to chase."
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
