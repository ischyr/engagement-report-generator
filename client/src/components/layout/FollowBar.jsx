import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Footprints, X } from 'lucide-react';

import { usePresence } from '../../context/PresenceContext.jsx';
import { Avatar } from '../ui/Misc.jsx';

/**
 * Following a teammate: your screen goes where theirs goes.
 *
 * Presence already knows what everybody has open — that is what the soft lock on a finding reads —
 * so this is mostly a matter of turning that key back into a route and navigating. It is the fastest
 * way to walk somebody through a finding, or to watch how a colleague scopes a test, without setting
 * up a screen share for a two-minute question.
 *
 * Deliberately one-way and interruptible. It follows *navigation*, not their scroll position or their
 * cursor, and browsing anywhere yourself does not break it — a follow that fought you for control of
 * your own browser would be a thing people turn on once.
 */

/** `finding:<audit>:<finding>` and `engagement:<audit>:<tab>` are the keys screens publish. */
export function routeForLocation(key) {
  const parts = String(key ?? '').split(':');
  if (parts[0] === 'finding' && parts[1] && parts[2]) {
    return `/engagements/${parts[1]}/findings/${parts[2]}`;
  }
  if (parts[0] === 'engagement' && parts[1]) {
    return parts[2] ? `/engagements/${parts[1]}?tab=${parts[2]}` : `/engagements/${parts[1]}`;
  }
  return '';
}

export default function FollowBar() {
  const { following, unfollow } = usePresence();
  const navigate = useNavigate();
  const here = useLocation();
  /** The last place we moved to on their behalf, so we do not fight the browser's own history. */
  const lastJump = useRef('');

  const target = routeForLocation(following?.location);

  useEffect(() => {
    if (!following) {
      lastJump.current = '';
      return;
    }
    if (!target || target === lastJump.current) return;
    // Already there — somebody navigated the same way by hand.
    if (`${here.pathname}${here.search}` === target) {
      lastJump.current = target;
      return;
    }
    lastJump.current = target;
    navigate(target);
  }, [following, target, navigate, here.pathname, here.search]);

  if (!following) return null;

  return (
    <div className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-brand-500/30 bg-brand-500/12 px-4 py-2 text-xs backdrop-blur">
      <Footprints size={14} className="shrink-0 text-brand-300" />
      <Avatar user={following} size={20} />
      <span className="text-fg">
        Following <span className="font-medium">{following.fullname}</span>
      </span>
      <span className="truncate text-fg-subtle">
        {target
          ? following.activity || 'moving around the app'
          : 'not in anything followable right now'}
      </span>
      <button
        type="button"
        onClick={() => unfollow()}
        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-white/10 hover:text-fg"
      >
        <X size={12} />
        Stop
      </button>
    </div>
  );
}
