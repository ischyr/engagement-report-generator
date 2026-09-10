import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { cachedValue, fetchShared } from '../lib/resource-cache.js';

/**
 * Loads a GET endpoint and exposes `{ data, error, loading, reload, setData }`.
 *
 * A slow response can never overwrite newer state: every load takes a ticket, and a reply holding
 * anything but the current one is dropped. Requests are also stopped when nobody is waiting for
 * them any more — which is not the same as when *this* component stopped waiting, because two
 * components asking for one URL share the request. See `resource-cache.js`.
 *
 * The first frame after mounting may come from what that module already knows, if the same URL was
 * answered in the last half minute — so leaving a page and coming back paints instead of flashing.
 * A real request always follows, so what is painted from memory is never what a reader is left
 * with, and any write empties that memory.
 *
 * `poll` refetches quietly on a timer, for a page whose subject somebody else is changing —
 * a proposal being signed off by a manager while the salesperson has it open. Quietly means no
 * spinner and no flicker: the numbers simply become right. The same shape as the presence and
 * notification polls, lifted here so a page can ask for it in one word.
 *
 * @param {string|null} path pass null to skip fetching
 * @param {{initial?: any, enabled?: boolean, poll?: number}} [options] `poll` in milliseconds
 */
export function useResource(path, options = {}) {
  const { initial = null, enabled = true, poll = 0 } = options;

  /* Whatever is already known, so a remount inside the window paints rather than blinks. */
  const [data, setData] = useState(() => cachedValue(path)?.data ?? initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(
    () => Boolean(path) && enabled && !cachedValue(path)
  );
  const handleRef = useRef(null);
  const mountedRef = useRef(true);
  /** Which load is the current one. A reply holding an old ticket is somebody else's answer. */
  const ticketRef = useRef(0);
  /** The path this hook has already painted, so an explicit reload is never served from memory. */
  const paintedRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      handleRef.current?.detach();
    };
  }, []);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!path || !enabled) {
        setLoading(false);
        return null;
      }

      /*
       * Memory is allowed to paint the first frame of a path and nothing else. An explicit
       * `reload()` — which is what a page calls after saving something — must be a real answer,
       * never the one from before the save.
       */
      const first = paintedRef.current !== path;
      paintedRef.current = path;
      const known = first ? cachedValue(path) : null;

      if (known) {
        setData(known.data);
        setLoading(false);
      } else if (!quiet) {
        setLoading(true);
      }
      setError(null);

      handleRef.current?.detach();
      const ticket = ticketRef.current + 1;
      ticketRef.current = ticket;
      const handle = fetchShared(path, (signal) => api.get(path, { signal }));
      handleRef.current = handle;

      const mine = () => mountedRef.current && ticketRef.current === ticket;

      try {
        const result = await handle.promise;
        if (!mine()) return null;
        setData(result);
        return result;
      } catch (err) {
        if (err?.name === 'AbortError' || !mine()) return null;
        setError(err);
        return null;
      } finally {
        if (mine()) setLoading(false);
      }
    },
    [path, enabled]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!poll || !path || !enabled) return undefined;

    /*
     * Nothing while the tab is in the background: a page left open on a second monitor for a
     * fortnight would otherwise be a request every few seconds for a fortnight, and nobody is
     * reading it. Coming back triggers one immediately rather than waiting out the interval,
     * which is what makes it feel current instead of stale-then-current.
     */
    const tick = () => {
      if (!document.hidden) load({ quiet: true });
    };
    const timer = setInterval(tick, poll);
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [poll, path, enabled, load]);

  return { data, error, loading, reload: load, setData };
}

/**
 * Wraps an async action with `pending` state and consistent error surfacing.
 * Returns `[run, pending]` where `run` resolves to the action's value, or
 * rejects after the error has already been reported.
 */
export function useAction(action, { onError } = {}) {
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args) => {
      setPending(true);
      try {
        return await action(...args);
      } catch (error) {
        onError?.(error);
        throw error;
      } finally {
        if (mountedRef.current) setPending(false);
      }
    },
    [action, onError]
  );

  return [run, pending];
}

/** Debounced value, for search inputs that hit the API. */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default useResource;
