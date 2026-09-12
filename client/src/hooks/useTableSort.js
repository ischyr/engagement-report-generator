import { useCallback, useMemo } from 'react';

import { useUrlState } from './useUrlState.js';

/**
 * Clicking a column heading to reorder a list.
 *
 * Every table in the app was ordered one way, decided in code — `TH` took `children`, `className`,
 * `align` and `width`, and there was nowhere to put a sort even if a page had wanted one. On Users,
 * Templates, Clients and the library that is the first thing a person tries, and the second thing
 * they do is ask for it.
 *
 * In the address bar rather than in the component, for the same reasons as every other filter:
 * `?sort=name&dir=desc` reloads, bookmarks and sends.
 *
 * ```js
 * const sort = useTableSort('name');
 * const rows = sort.apply(people, { name: (p) => p.fullname, seen: (p) => p.lastSeenAt });
 * // …
 * <TH sort={sort} sortKey="name">Name</TH>
 * ```
 *
 * The accessors live at the call site rather than on the column, because what a column *displays*
 * and what it should *sort by* are often different things: a row showing "3 days ago" sorts by the
 * date behind it, and a severity chip sorts by score rather than alphabetically.
 */

const isEmpty = (value) => value === null || value === undefined || value === '';

/** One comparison of two values that are both actually there. */
function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date || b instanceof Date) return new Date(a) - new Date(b);

  /* `numeric` so PT-2 comes before PT-10, which is the whole point of a reference column. */
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function useTableSort(defaultKey = '', defaultDirection = 'asc') {
  const [key, setKey] = useUrlState('sort', defaultKey);
  const [direction, setDirection] = useUrlState('dir', defaultDirection);

  /**
   * Click once to sort by a column, again to reverse it.
   *
   * Both writes happen in one tick when the column changes, which `useUrlState` is built to
   * survive — see the note on `pending` there. Without that, the direction reset would be written
   * from params that did not yet have the new key and the two would cancel out.
   */
  const toggle = useCallback(
    (next) => {
      if (next === key) {
        setDirection(direction === 'asc' ? 'desc' : 'asc');
        return;
      }
      setKey(next);
      setDirection('asc');
    },
    [key, direction, setKey, setDirection]
  );

  const apply = useCallback(
    (rows, accessors) => {
      const read = accessors?.[key];
      if (!read || !Array.isArray(rows)) return rows;

      /*
       * The direction goes into the comparison, not on the result.
       *
       * Sorting ascending and then reversing looks equivalent and is not: it reverses the
       * empties-last rule along with everything else, so "last signed in, newest first" led with
       * every account that has never signed in. It also reverses rows that compared equal, which
       * makes a stable sort visibly unstable. Both fall out of comparing properly instead.
       *
       * Empties stay last in both directions — "sort by expiry" is asking what expires soonest,
       * and answering with every row that has no expiry is defensible and useless.
       */
      const sign = direction === 'desc' ? -1 : 1;
      /* A copy: the caller's array is usually a `useMemo` result that something else also reads. */
      return [...rows].sort((a, b) => {
        const left = read(a);
        const right = read(b);
        if (isEmpty(left) || isEmpty(right)) {
          if (isEmpty(left) && isEmpty(right)) return 0;
          return isEmpty(left) ? 1 : -1;
        }
        return sign * compare(left, right);
      });
    },
    [key, direction]
  );

  return useMemo(() => ({ key, direction, toggle, apply }), [key, direction, toggle, apply]);
}

export default useTableSort;
