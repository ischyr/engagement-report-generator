import { currentRequestId } from './request-context.js';

const stamp = () => new Date().toISOString().slice(11, 23);

const paint = (color, label) => `\x1b[${color}m${label}\x1b[0m`;

/**
 * The stamp, and the request this line belongs to when it belongs to one.
 *
 * Every line written while a request is being served carries its id, without any caller passing
 * anything — which is the point. A warning from the vault, the mail sender or the webhook poster
 * becomes attributable to the person who caused it, and one grep collects everything that happened
 * to them. Lines from outside a request — boot, the trash sweep, the booking reminders — get
 * nothing, and their absence is itself information.
 *
 * Returned as an array to spread rather than as a string to interpolate, so a line with no id has
 * no gap where one would have been. `console.log(a, '', b)` prints two spaces, and a log format
 * that shifts depending on whether an id exists is a log format that is annoying to read and
 * awkward to grep.
 */
function prefix(color, label) {
  const head = paint(color, `[${stamp()}] ${label}`);
  const id = currentRequestId();
  return id ? [head, paint(90, `[${id}]`)] : [head];
}

export const log = {
  info: (...a) => console.log(...prefix(36, 'info '), ...a),
  warn: (...a) => console.warn(...prefix(33, 'warn '), ...a),
  error: (...a) => console.error(...prefix(31, 'error'), ...a),
  debug: (...a) => {
    if (process.env.NODE_ENV !== 'production') console.log(...prefix(90, 'debug'), ...a);
  },
};

export default log;
