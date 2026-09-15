import { useEffect, useRef, useState } from 'react';

import { useNavigationPending } from '../../context/NavigationContext.jsx';
import { cn } from '../../lib/utils.js';

/**
 * A thin line along the top, while the next page is being fetched.
 *
 * The one piece of feedback missing between a click and a page. With the outgoing page now kept on
 * screen during the transition, the click would otherwise have *no* visible effect at all until
 * the new page drew — which is a worse trade than the blank it replaced, since at least a blank
 * screen said something had happened.
 *
 * ## Two delays, and they are doing opposite jobs
 *
 * **It waits before appearing.** Most navigations in this app are a cached chunk and a warm
 * endpoint — a hundred milliseconds, sometimes less. A bar that flashed on every one of those
 * would be noise, and noise that says "slow" about the fastest thing the app does. So nothing is
 * drawn until a navigation has taken longer than a person reads as instant.
 *
 * **It waits before leaving.** A bar that appeared and vanished within a frame is a flicker, so
 * once it is up it stays up long enough to be seen as a thing that happened rather than a glitch.
 *
 * ## And it never claims to know how far along it is
 *
 * There is no progress to report: a dynamic import gives no bytes-so-far, and a percentage that is
 * really a timer is a lie the reader will eventually catch. It animates indefinitely and stops
 * when the page arrives, which is exactly as much as is actually known.
 */

/** Long enough that an ordinary navigation never draws it. */
export const APPEAR_AFTER_MS = 180;
/** And long enough, once drawn, that it is never a flicker. */
export const LINGER_MS = 220;

export function NavigationProgress() {
  const pending = useNavigationPending();
  const [visible, setVisible] = useState(false);
  const timers = useRef([]);

  useEffect(() => {
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };

    clear();
    if (pending) {
      timers.current.push(setTimeout(() => setVisible(true), APPEAR_AFTER_MS));
    } else if (visible) {
      timers.current.push(setTimeout(() => setVisible(false), LINGER_MS));
    }
    return clear;
    /* `visible` deliberately out of the deps: it is what this effect sets, and reacting to its own
       write would restart the linger every time the linger finished. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="engy-nav-progress h-full w-full origin-left bg-brand-400/80" />
    </div>
  );
}

export default NavigationProgress;
