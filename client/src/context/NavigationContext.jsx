import { createContext, useCallback, useContext, useMemo, useTransition } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Going somewhere, without the page going blank on the way.
 *
 * Every page in this app is loaded on demand, and until now arriving at one meant the same three
 * frames: the click did nothing visible, the content area emptied, a spinner appeared, and then
 * the page drew. The emptying is the part that reads as slow — the wait is the same either way,
 * but a reader who is looking at *nothing* has no evidence the click registered, and the usual
 * response to that is to click again.
 *
 * So navigation happens inside a transition. React then keeps the outgoing page on screen while
 * the incoming one's chunk is fetched and rendered, and shows the `Suspense` fallback only when
 * there is nothing to keep — the first page after a sign-in, or a reload. Nothing is faster; the
 * reader simply stops being shown an empty room.
 *
 * ## Why the transition lives here and not at each call site
 *
 * `useTransition` reports pending for the updates scheduled inside *its own* scope. Fifteen call
 * sites with fifteen hooks would be fifteen unrelated booleans and nothing that could draw one
 * progress bar. One hook, one `go()`, one `pending` — which is the thing the bar needs.
 *
 * ## What is deliberately not here
 *
 * The unsaved-work guard. `NavItem` asks `guard()` before it calls this, and it must stay that
 * way round: the question "do you want to lose this draft" is not a transition, it is a dialog,
 * and wrapping it in one would make the dialog itself arrive late.
 */
const NavigationContext = createContext({
  go: () => {},
  pending: false,
});

export function NavigationProvider({ children }) {
  const navigate = useNavigate();
  const [pending, startTransition] = useTransition();

  const go = useCallback(
    (to, options) => {
      startTransition(() => {
        navigate(to, options);
      });
    },
    [navigate]
  );

  const value = useMemo(() => ({ go, pending }), [go, pending]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * `go(to, options)` — `navigate`, but the page you are leaving stays until the next one is ready.
 *
 * Interchangeable with `useNavigate()` at the call site, which is the point: a component that
 * wants the smooth version changes one word.
 */
export function useSmoothNavigate() {
  return useContext(NavigationContext).go;
}

/** Whether a navigation is in flight, for whatever wants to say so. */
export function useNavigationPending() {
  return useContext(NavigationContext).pending;
}

export default NavigationContext;
