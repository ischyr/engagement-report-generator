import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const NotificationsContext = createContext(null);

/** Same reasoning as presence: polled, because a few seconds of lag is invisible. */
const POLL_MS = 30_000;

export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/notifications?limit=40');
      setItems(Array.isArray(data?.items) ? data.items : []);
      setUnread(data?.unread ?? 0);
    } catch {
      /* keep whatever is on screen rather than flashing it empty */
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnread(0);
      return undefined;
    }

    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      refresh();
    };

    setLoading(true);
    refresh().finally(() => !cancelled && setLoading(false));

    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refresh]);

  /** Optimistic: the badge should drop the instant the item is clicked. */
  const markRead = useCallback(async (id) => {
    setItems((prev) =>
      prev.map((item) => (item._id === id ? { ...item, read: true, readAt: new Date() } : item))
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      await api.post(`/notifications/${id}/read`, { read: true });
    } catch {
      /* the next poll puts the truth back */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((item) => ({ ...item, read: true })));
    setUnread(0);
    try {
      await api.post('/notifications/read-all', {});
    } catch {
      /* the next poll puts the truth back */
    }
  }, []);

  const clearRead = useCallback(async () => {
    setItems((prev) => prev.filter((item) => !item.read));
    try {
      await api.del('/notifications/read');
    } catch {
      /* the next poll puts the truth back */
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
