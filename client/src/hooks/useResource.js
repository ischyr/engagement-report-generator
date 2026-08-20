import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Loads a GET endpoint and exposes `{ data, error, loading, reload, setData }`.
 *
 * In-flight requests are aborted when the path changes or the component
 * unmounts, so a slow response can never overwrite newer state.
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

  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(path) && enabled);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!path || !enabled) {
        setLoading(false);
        return null;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!quiet) setLoading(true);
      setError(null);
      try {
        const result = await api.get(path, { signal: controller.signal });
        if (!mountedRef.current || controller.signal.aborted) return null;
        setData(result);
        return result;
      } catch (err) {
        if (err?.name === 'AbortError' || !mountedRef.current) return null;
        setError(err);
        return null;
      } finally {
        if (mountedRef.current && !controller.signal.aborted) setLoading(false);
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
