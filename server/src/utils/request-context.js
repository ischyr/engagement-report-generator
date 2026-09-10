import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

/**
 * One id per request, readable from anywhere inside it.
 *
 * The problem this solves is support. Somebody says "it failed around three o'clock", and the answer
 * is a timestamp and a hope: the log holds every request from every person in that minute, the
 * failure is a stack trace with no way back to the browser that caused it, and the person reporting
 * it has nothing to quote. So every request gets a short id, and it appears in three places at
 * once — on every log line written while that request is being served, in the body of any error it
 * answers with, and in a response header. One string turns "grep the log around three" into "grep
 * for a1b2c3d4".
 *
 * ## Why `AsyncLocalStorage`
 *
 * Because the alternative is threading a request object through every function that might log. The
 * webhook sender, the mail sender, the report renderer and the vault all log, none of them is given
 * the request, and none of them should be — a service that needs an HTTP request in order to write a
 * warning is a service that cannot be called from a script. Async-local storage is the one mechanism
 * that lets a leaf function know which request it is inside without being told.
 *
 * It follows `await` correctly, which is the whole point: everything a handler does, however deep
 * and however asynchronous, is inside the same store. What it does *not* cover is work deliberately
 * detached from the request — a fire-and-forget webhook that outlives the response keeps the id,
 * which is right, and a scheduled sweep has none at all, which is also right.
 */

const storage = new AsyncLocalStorage();

/**
 * Whether an id from outside can be trusted into our logs and headers.
 *
 * A reverse proxy that already stamps requests should win, so its id is honoured — but a header is
 * attacker-controlled, and this one ends up in log lines and in a response header. A newline in it
 * would forge log entries; a colon or a CR would let somebody inject a header. So the rule is narrow
 * and anything else is replaced rather than sanitised, because a mangled id is worse than a fresh
 * one: it looks like it came from somewhere.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Short, because somebody has to read it off a screen and paste it into a message. */
export function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

/** @param {string|undefined} given a value offered by a proxy, or nothing */
export function acceptRequestId(given) {
  const offered = String(given ?? '').trim();
  return SAFE_ID.test(offered) ? offered : newRequestId();
}

/** Runs `fn` with `id` attached to everything it does, however deeply nested. */
export function runWithRequestId(id, fn) {
  return storage.run({ id }, fn);
}

/** The id of the request being served, or an empty string outside one. */
export function currentRequestId() {
  return storage.getStore()?.id ?? '';
}

export default storage;
