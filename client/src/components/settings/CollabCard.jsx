import { Users } from 'lucide-react';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Toggle } from '../ui/Field.jsx';

/**
 * Whether two people may edit the same field at once.
 *
 * One switch, and everything hangs off it — there is nothing to configure, because there is nothing
 * to point at: the socket is this app on this origin. What the switch is really for is the two cases
 * where the feature is unwanted rather than unavailable: a reverse proxy that does not pass
 * WebSocket upgrades, where every field would attempt a connection that can only fail; and a firm
 * that would simply rather people took turns.
 *
 * Off is not a degraded mode. It is the app as it was before any of this existed, which is why the
 * copy says so plainly rather than warning anybody about what they are missing.
 */
export default function CollabCard({ value, onChange }) {
  const enabled = Boolean(value?.enabled);

  return (
    <Card>
      <CardHeader
        icon={Users}
        title="Editing the same field at once"
        description="Lets two people write in one finding, section, note or enumeration step together, each seeing the other's cursor and text as it is typed."
      />
      <CardBody className="flex flex-col gap-4">
        <Toggle
          checked={enabled}
          onChange={(next) => onChange({ ...value, enabled: next })}
          label="Share documents between people editing them"
          hint="Off is the app as it was before this existed: one writer at a time, the lock that says who has a finding, and the conflict merge if two people save anyway."
        />

        {enabled ? (
          <div className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-fg-muted">
            <p>
              Behind a reverse proxy, <span className="font-mono text-fg">/api/collab</span> needs
              WebSocket upgrades passed through. In nginx that is{' '}
              <span className="font-mono text-fg">proxy_set_header Upgrade $http_upgrade;</span> and{' '}
              <span className="font-mono text-fg">proxy_set_header Connection &quot;upgrade&quot;;</span>.
            </p>
            <p className="mt-1.5">
              Without it nothing breaks: each field falls back to a single writer after a few
              seconds, which is the same behaviour as leaving this switched off.
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
