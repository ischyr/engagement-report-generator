/**
 * One request per answer, shared by everybody who asked for it.
 *
 * Two components wanting the same URL at the same moment used to be two requests. That is not a
 * rare case in this app, it is the normal one: opening a finding asks for the vulnerability types,
 * the categories, the custom fields and the active users, and several of those are asked for by
 * more than one component in the same render — the tab that lists them and the dialog that picks
 * from them. The server answered each twice, the browser held the connections, and every one of
 * them arrived with the same body.
 *
 * So there are two maps here.
 *
 * **In flight**, keyed by URL, holds the request that is already happening. A second caller gets
 * the same promise rather than a second request, and the entry is dropped the moment it settles.
 * Nothing can go stale in this one: concurrent readers of one URL are asking a single question,
 * and they get a single answer.
 *
 * **Values**, keyed by URL, holds what came back and when. Its only job is the *first frame* after
 * a component mounts: navigating away from an engagement and back within half a minute paints
 * immediately instead of flashing a spinner at somebody who was just looking at the answer. It is
 * never the final word — a read from this map is always followed by a real request, which is what
 * makes it safe to keep at all. A cache that revalidates is a paint optimisation; a cache that does
 * not is a bug with a TTL.
 *
 * ## And it is emptied by every write
 *
 * `api.js` clears it after any successful POST, PUT, PATCH or DELETE. Bluntly, all of it, rather
 * than working out which URLs a write could have changed — that reasoning is exactly what goes
 * wrong later, when somebody adds an endpoint whose write affects a list nobody thought of. The
 * cost of being wrong about it is a page that shows a figure somebody has just changed; the cost of
 * clearing everything is one extra request on the next mount, and writes are rare next to reads.
 */

/**
 * How old a cached value may be and still paint the first frame.
 *
 * Long enough to cover leaving a page and coming back, short enough that a value this old is never
 * what a reader ends up looking at — the revalidation that always follows lands in milliseconds.
 */
export const FRESH_MS = 30_000;

/** @type {Map<string, {controller: AbortController, promise: Promise<any>, waiters: number}>} */
const inFlight = new Map();
/** @type {Map<string, {data: any, at: number}>} */
const values = new Map();

/**
 * What is already known for this URL, if it is recent enough to show.
 *
 * @returns {{data: any, at: number}|null}
 */
export function cachedValue(path) {
  if (!path) return null;
  const held = values.get(path);
  if (!held) return null;
  if (Date.now() - held.at > FRESH_MS) {
    values.delete(path);
    return null;
  }
  return held;
}

/**
 * Runs `send` for this URL, or joins the request already running for it.
 *
 * The caller gets a handle rather than a bare promise, because leaving is not the same as
 * cancelling: a component that unmounts stops caring about the answer, but another component may
 * still be waiting for it. Only when the last of them has let go is the request actually stopped.
 *
 * @param {string} path the URL, which is the key
 * @param {(signal: AbortSignal) => Promise<any>} send
 * @returns {{promise: Promise<any>, detach: () => void}}
 */
export function fetchShared(path, send) {
  let entry = inFlight.get(path);

  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters: 0, promise: null };

    const promise = send(controller.signal).then(
      (value) => {
        values.set(path, { data: value, at: Date.now() });
        if (inFlight.get(path) === entry) inFlight.delete(path);
        return value;
      },
      (error) => {
        if (inFlight.get(path) === entry) inFlight.delete(path);
        throw error;
      }
    );
    /*
     * The rejection is handled here as well as by every caller. Without this, a request whose last
     * waiter walked away before it failed is an unhandled rejection in the console — noise that
     * says nothing, on a path where nobody was listening by design. Callers still see the error:
     * one handler does not consume it.
     */
    promise.catch(() => {});

    entry.promise = promise;
    inFlight.set(path, entry);
  }

  entry.waiters += 1;
  let gone = false;

  return {
    promise: entry.promise,
    detach() {
      if (gone) return;
      gone = true;
      entry.waiters -= 1;
      if (entry.waiters > 0) return;

      /*
       * Deferred by a tick, because an unmount followed immediately by a mount of the same thing is
       * not somebody losing interest — it is React in strict mode, or a changed `key`, or a
       * re-render that moved the component. Aborting synchronously there would throw away a request
       * that is about to be asked for again. Anybody who rejoins before this fires keeps it alive.
       */
      setTimeout(() => {
        if (entry.waiters > 0 || inFlight.get(path) !== entry) return;
        inFlight.delete(path);
        entry.controller.abort();
      }, 0);
    },
  };
}

/**
 * Forgets every cached value, and lets every request in flight finish on its own.
 *
 * Called after each successful write. In-flight requests are deliberately left alone: they were
 * asked for before the write and their callers are waiting on them, and cancelling somebody's read
 * because an unrelated write happened would turn a saved form into an empty page.
 */
export function clearResourceCache() {
  values.clear();
}

/** For tests and for reasoning about it in a console. */
export function resourceCacheState() {
  return { inFlight: inFlight.size, values: values.size };
}
