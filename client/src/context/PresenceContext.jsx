import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const PresenceContext = createContext(null);

/** Well inside the server's 75s window, so a dropped beat is not visible. */
const HEARTBEAT_MS = 25_000;
const POLL_MS = 20_000;
/** While a record is open, because "somebody else is in here" is worth knowing quickly. */
const HERE_POLL_MS = 8_000;

/**
 * Keeps the signed-in user marked as online and holds the list of everyone else.
 *
 * A heartbeat plus polling rather than a socket: presence is advisory, two
 * requests a minute is nothing, and it needs no extra transport to operate.
 * Both loops pause while the tab is hidden — a backgrounded tab is not someone
 * working, and it avoids pointless traffic from tabs left open overnight.
 */
export function PresenceProvider({ children }) {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const activityRef = useRef('');
  /**
   * Where this browser is, as a stack.
   *
   * Screens nest — a finding is open *inside* an engagement — and both want to say where they are.
   * One field and two writers means the inner one wins on mount and then clears the outer one's
   * claim when it unmounts, which is how "follow" loses somebody the moment they close a finding.
   * A stack has the right shape: the most specific screen is the top, and popping it exposes what
   * was underneath.
   */
  const locationsRef = useRef([]);
  const locationRef = useRef('');

  const beat = useCallback(async () => {
    try {
      await api.post('/presence/heartbeat', {
        activity: activityRef.current,
        location: locationRef.current,
      });
    } catch {
      /* offline or signed out — the next tick tries again */
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const data = await api.get('/presence');
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch {
      /* leave the previous list in place rather than flashing it empty */
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setUsers([]);
      return undefined;
    }

    let cancelled = false;
    const tick = async (fn) => {
      if (cancelled || document.hidden) return;
      await fn();
    };

    // Announce immediately so the user appears without waiting a full interval.
    beat();
    poll();

    const beatTimer = setInterval(() => tick(beat), HEARTBEAT_MS);
    const pollTimer = setInterval(() => tick(poll), POLL_MS);

    // Coming back to the tab should refresh at once, not after up to 20 seconds.
    const onVisible = () => {
      if (!document.hidden) {
        beat();
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(beatTimer);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, beat, poll]);

  /**
   * Publishes what the user is doing, e.g. "editing Acme Portal". Kept in a ref
   * so setting it never re-renders the tree; it rides along on the next beat and
   * is sent immediately so the change is visible without a delay.
   */
  const setActivity = useCallback(
    (label) => {
      const next = String(label ?? '').slice(0, 120);
      if (next === activityRef.current) return;
      activityRef.current = next;
      if (user) beat();
    },
    [user, beat]
  );

  /**
   * Publishes which record is open. Same ref-not-state treatment as the activity label, and sent
   * at once: the useful moment for "somebody else is in here" is the second you both are.
   */
  /**
   * Publishes the top of the stack, if it changed.
   *
   * `.key`, not the entry. The stack holds objects — they are compared by identity when a screen
   * gives its place up, so that two screens claiming the same name cannot release each other's —
   * and sending one of those objects as the location made the server refuse every heartbeat with a
   * place in it. Silently: presence has always swallowed its own errors so that being offline is
   * not a dialog, which is right, and which is why nobody noticed that "who else is looking at this"
   * and following a teammate had stopped working.
   */
  const publish = useCallback(() => {
    const next = locationsRef.current.at(-1)?.key ?? '';
    if (next === locationRef.current) return;
    locationRef.current = next;
    if (user) beat();
  }, [user, beat]);

  /**
   * Declares a place, and returns the function that gives it up.
   *
   * Keyed by identity rather than by value so two screens claiming the same key — a list and the
   * thing it opened — cannot release each other's.
   */
  const pushLocation = useCallback(
    (key) => {
      const entry = { key: String(key ?? '').slice(0, 200) };
      locationsRef.current = [...locationsRef.current, entry];
      publish();
      return () => {
        locationsRef.current = locationsRef.current.filter((item) => item !== entry);
        publish();
      };
    },
    [publish]
  );

  /** Everybody else who has the same record open. */
  const othersAt = useCallback(
    (key) => (key ? users.filter((u) => !u.isSelf && u.location === key) : []),
    [users]
  );

  /**
   * Following somebody: their id, or null.
   *
   * Held here rather than in the screen doing the following, because the point of it is that it
   * survives the navigation it causes.
   */
  const [followingId, setFollowingId] = useState(null);
  const following = users.find((u) => u.id === followingId) ?? null;

  // Stop following somebody who has gone home; a follow that silently does nothing is worse.
  useEffect(() => {
    if (followingId && users.length && !users.some((u) => u.id === followingId)) {
      setFollowingId(null);
    }
  }, [followingId, users]);

  const value = useMemo(
    () => ({
      users,
      others: users.filter((u) => !u.isSelf),
      onlineCount: users.length,
      setActivity,
      pushLocation,
      othersAt,
      refresh: poll,
      following,
      follow: setFollowingId,
      unfollow: () => setFollowingId(null),
    }),
    [users, setActivity, pushLocation, othersAt, poll, following]
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresence() {
  // Returns a harmless stub outside the provider so components can call it
  // unconditionally (the auth screens render outside it).
  return (
    useContext(PresenceContext) ?? {
      users: [],
      others: [],
      onlineCount: 0,
      setActivity: () => {},
      pushLocation: () => () => {},
      othersAt: () => [],
      refresh: () => {},
      following: null,
      follow: () => {},
      unfollow: () => {},
    }
  );
}

/**
 * Declares what the mounting screen is working on, and clears it on unmount.
 * `useEffect` cleanup means navigating away always resets the label.
 */
export function useActivity(label) {
  const { setActivity } = usePresence();
  useEffect(() => {
    if (!label) return undefined;
    setActivity(label);
    return () => setActivity('');
  }, [label, setActivity]);
}

/**
 * Declares which record this screen has open, and who else has it open too.
 *
 * Polls faster than the sidebar does while it is mounted. Twenty seconds is fine for "who is
 * around"; it is not fine for "am I about to overwrite somebody" — by the time that appears the
 * damage is typed. It clears on unmount, so closing a finding releases it immediately.
 *
 * @param {string} key An opaque key both browsers will agree on, or '' to declare nothing.
 * @returns {Array} Everybody else currently at that key.
 */
export function useHere(key) {
  const { pushLocation, othersAt, refresh } = usePresence();

  useEffect(() => {
    if (!key) return undefined;
    return pushLocation(key);
  }, [key, pushLocation]);

  useEffect(() => {
    if (!key) return undefined;
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, HERE_POLL_MS);
    return () => clearInterval(timer);
  }, [key, refresh]);

  return othersAt(key ?? '');
}

export default PresenceContext;
