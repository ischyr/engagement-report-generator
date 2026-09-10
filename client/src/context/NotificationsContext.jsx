import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { usePresence } from './PresenceContext.jsx';

const NotificationsContext = createContext(null);

/**
 * The notification bar.
 *
 * No timer of its own. It had one, at thirty seconds, asking `/notifications?limit=40` — and the
 * presence heartbeat was already going to the server every twenty-five seconds anyway, so that
 * request was a second round trip for something the first one could have carried. It carries it
 * now: `PresenceProvider` beats, the answer includes this exact list, and this reads it.
 *
 * Which is why the provider order in App.jsx matters — presence wraps notifications, so this can
 * read from it. Everything about what a notification *means* still lives here: the optimistic
 * mutations below, and `refresh` for the moments a beat is too far away to wait for.
 *
 * `mark as read` still writes to `/notifications/...`; only the reading was merged.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const { liveNotifications, refresh: beat } = usePresence();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  /**
   * Until the first beat has landed, which is not the same as having none.
   *
   * `liveNotifications` is null before the first answer and an object after it, even when that
   * object holds an empty list — so the bar can show a loading state rather than "nothing here"
   * to somebody whose notifications simply have not arrived yet.
   */
  const loading = Boolean(user) && liveNotifications === null;

  /* What the heartbeat brought, unless a local mutation has since moved ahead of it. */
  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnread(0);
      return;
    }
    if (!liveNotifications) return;
    setItems(Array.isArray(liveNotifications.items) ? liveNotifications.items : []);
    setUnread(liveNotifications.unread ?? 0);
  }, [user, liveNotifications]);

  /**
   * An immediate refresh, for after a write.
   *
   * A beat, so it is still one request rather than two — and it updates the roster on its way
   * past, which is free.
   */
  const refresh = useCallback(async () => {
    await beat();
  }, [beat]);

  /** Optimistic: the badge should drop the instant the item is clicked. */
  const markRead = useCallback(async (id) => {
    setItems((prev) =>
      prev.map((item) => (item._id === id ? { ...item, read: true, readAt: new Date() } : item))
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      await api.post(`/notifications/${id}/read`, { read: true });
    } catch {
      /* the next heartbeat puts the truth back */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((item) => ({ ...item, read: true })));
    setUnread(0);
    try {
      await api.post('/notifications/read-all', {});
    } catch {
      /* the next heartbeat puts the truth back */
    }
  }, []);

  const clearRead = useCallback(async () => {
    setItems((prev) => prev.filter((item) => !item.read));
    try {
      await api.del('/notifications/read');
    } catch {
      /* the next heartbeat puts the truth back */
    }
  }, []);

  const value = useMemo(
    () => ({ items, unread, loading, refresh, markRead, markAllRead, clearRead }),
    [items, unread, loading, refresh, markRead, markAllRead, clearRead]
  );

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications() {
  // A stub outside the provider, so the auth screens can call it unconditionally.
  return (
    useContext(NotificationsContext) ?? {
      items: [],
      unread: 0,
      loading: false,
      refresh: () => {},
      markRead: () => {},
      markAllRead: () => {},
      clearRead: () => {},
    }
  );
}

export default NotificationsContext;
