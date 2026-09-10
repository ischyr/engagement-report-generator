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
/**
 * How fast the roster refreshes while any record is open.
 *
 * Twenty-five seconds is fine for "who is around"; it is not fine for "am I about to overwrite
 * somebody" — by the time that appears the damage is typed. So the one timer runs at this rate
 * while at least one screen has declared a place, and at `HEARTBEAT_MS` otherwise.
 */
const HERE_MS = 8_000;

/**
 * Keeps the signed-in user marked as online, holds the list of everyone else, and carries the
 * notifications along with it.
 *
 * A heartbeat rather than a socket: presence is advisory, a few seconds of staleness costs
 * nothing, and it needs no extra transport to operate. It pauses while the tab is hidden — a
 * backgrounded tab is not someone working, and it avoids pointless traffic from tabs left open
 * overnight.
 *
 * **One timer.** There were four: this heartbeat every 25 seconds, a roster read every 20, a
 * notification read every 30, and another roster read every 8 for each mounted `useHere`. They
 * asked three endpoints for things the heartbeat's own request already had to look up on its way
 * past. Now the heartbeat answers with all of it — see `live.service.js` — and everything else
 * reads what it brought back.
 *
 * The notifications are held here for that reason and only that reason; `NotificationsContext`
 * still owns what they *mean*, and reads them from `liveNotifications` below.
 */
export function PresenceProvider({ children }) {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  /**
   * The notification payload from the last beat, for `NotificationsProvider` to pick up.
   *
   * Null until the first beat lands, which is how that provider tells "nothing has arrived yet"
   * from "you have no notifications" — the first should keep showing its loading state and the
   * second should not.
   */
  const [liveNotifications, setLiveNotifications] = useState(null);
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

  /**
   * One request: says this browser is here, and takes back everything on a timer.
   *
   * The roster is left alone when a beat fails rather than flashed empty — being briefly offline
   * should not look like everybody going home.
   */
  const beat = useCallback(async () => {
    try {
      const data = await api.post('/presence/heartbeat', {
        activity: activityRef.current,
        location: locationRef.current,
      });
      if (Array.isArray(data?.users)) setUsers(data.users);
      if (data?.notifications) setLiveNotifications(data.notifications);
      return data;
    } catch {
      /* offline or signed out — the next tick tries again */
      return null;
    }
  }, []);

  /**
   * Whether any screen currently has a place, which decides how fast the timer runs.
   *
   * State rather than a ref, because the interval below has to be rebuilt when it changes — and
   * it is set from `publish`, which every `useHere` already calls on mount and unmount.
   */
  const [somewhere, setSomewhere] = useState(false);

  /**
   * Announce on arrival, and again whenever the tab comes back to the front.
   *
   * Deliberately separate from the interval below, and the separation is not tidiness: the
   * interval has to be rebuilt when the rate changes, and while these were one effect that
   * rebuild also re-ran this `beat()`. So opening a finding sent two heartbeats a millisecond
   * apart — one for the place, one for the timer being replaced. Splitting them means the rate can
   * change without anybody being announced twice.
   */
  useEffect(() => {
    if (!user) {
      setUsers([]);
      setLiveNotifications(null);
      return undefined;
    }

    beat();

    const onVisible = () => {
      if (!document.hidden) beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user, beat]);

  /**
   * The one timer.
   *
   * Faster while any screen has declared a place — see `HERE_MS` — and slower when none has. It
   * does not beat on setup, because whatever caused it to be rebuilt has just beaten.
   */
  useEffect(() => {
    if (!user) return undefined;

    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || document.hidden) return;
      beat();
    }, somewhere ? HERE_MS : HEARTBEAT_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, beat, somewhere]);

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
    /* Whether anybody is anywhere, which is what makes the single timer run at the faster rate. */
    setSomewhere(locationsRef.current.length > 0);
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
      /* A beat is the refresh now: it is the request that brings the roster back. */
      refresh: beat,
      following,
      follow: setFollowingId,
      unfollow: () => setFollowingId(null),
      /** What the last beat carried for the notification bar. See `NotificationsProvider`. */
      liveNotifications,
    }),
    [users, setActivity, pushLocation, othersAt, beat, following, liveNotifications]
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
      liveNotifications: null,
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
 * Clears on unmount, so closing a finding releases it immediately.
 *
 * It used to start a timer of its own, at eight seconds, per mount — so a page with three of
 * these ran three timers asking one endpoint the same question at three unrelated offsets. Now
 * declaring a place is all it does: the provider's single timer speeds up to eight seconds while
 * anything is declared, and slows back down when nothing is. The refresh on mount stays, because
 * the useful moment for "somebody else is in here" is the second you both are.
 *
 * @param {string} key An opaque key both browsers will agree on, or '' to declare nothing.
 * @returns {Array} Everybody else currently at that key.
 */
export function useHere(key) {
  const { pushLocation, othersAt } = usePresence();

  useEffect(() => {
    if (!key) return undefined;
    /*
     * Declaring the place is also the refresh.
     *
     * `pushLocation` publishes, and publishing a new place beats — so the roster comes back in the
     * same request that announced the arrival. The explicit `refresh()` that used to sit here was
     * a second request that announced nothing, which is strictly worse than the one it duplicated.
     */
    return pushLocation(key);
  }, [key, pushLocation]);

  return othersAt(key ?? '');
}

export default PresenceContext;
