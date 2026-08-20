import { useCallback, useEffect, useState } from 'react';

/**
 * What you searched for, and what you opened.
 *
 * The palette opened empty every time, so the same three queries got retyped all day and the
 * fastest way back to a finding you had open five minutes ago was the browser's back button.
 *
 * Kept in `localStorage` rather than on the server, and keyed by user id: it is a convenience
 * about one person's browser, not a fact about the engagement, and a shared machine must not hand
 * the next person a list of the last one's searches. Storage failures are swallowed — a browser
 * with storage disabled should lose the convenience, not the search box.
 */
const LIMIT = 8;

const keyFor = (userId, kind) => `engy:search:${kind}:${userId || 'anonymous'}`;

function read(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value.slice(0, LIMIT)));
  } catch {
    /* private mode, quota, a browser with storage off — none of it is worth an error */
  }
}

export function useSearchMemory(userId) {
  const [queries, setQueries] = useState([]);
  const [opened, setOpened] = useState([]);

  useEffect(() => {
    setQueries(read(keyFor(userId, 'queries')));
    setOpened(read(keyFor(userId, 'opened')));
  }, [userId]);

  /**
   * Remembered when a result is opened, not on every keystroke.
   *
   * A query somebody abandoned halfway is not a query they want offered back, and a debounced
   * search box would otherwise store "x", "xs", "xss" as three separate memories.
   */
  const remember = useCallback(
    (query, result) => {
      const trimmed = String(query ?? '').trim();
      if (trimmed.length >= 2) {
        setQueries((current) => {
          const next = [trimmed, ...current.filter((entry) => entry !== trimmed)];
          write(keyFor(userId, 'queries'), next);
          return next.slice(0, LIMIT);
        });
      }
      if (result?.href) {
        setOpened((current) => {
          const entry = {
            type: result.type,
            title: result.title,
            subtitle: result.subtitle ?? '',
            href: result.href,
            severity: result.severity ?? null,
            at: Date.now(),
          };
          const next = [entry, ...current.filter((row) => row.href !== entry.href)];
          write(keyFor(userId, 'opened'), next);
          return next.slice(0, LIMIT);
        });
      }
    },
    [userId]
  );

  const forget = useCallback(() => {
    write(keyFor(userId, 'queries'), []);
    write(keyFor(userId, 'opened'), []);
    setQueries([]);
    setOpened([]);
  }, [userId]);

  return { queries, opened, remember, forget };
}

export default useSearchMemory;
