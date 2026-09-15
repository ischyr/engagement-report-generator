/**
 * Show the answer now, put it back if the server disagrees.
 *
 * Every small write in this app was pessimistic: send, wait, refetch, redraw. Ticking a check on a
 * methodology list is a POST and then a GET before the box moves — two round trips to change a
 * boolean the reader already decided. On a laptop beside the server that is imperceptible; over a
 * VPN from a client site, which is where this software is actually used, it is a checkbox that
 * hesitates. Do that forty times down a list and the application feels broken, though nothing is.
 *
 * Nothing here makes the write faster. It moves the drawing to the front of it, which is the part
 * a person experiences.
 *
 * ## Only for writes that can be taken back
 *
 * A pin, a tick, a shared flag: one field, one row, obvious when it is wrong, harmless for a
 * second while it is in flight. Not for anything that creates, deletes, sends or signs — those
 * must show their real state, because "it looked like it worked" is the worst possible outcome for
 * a report going to a client. The rule is whether a rollback would be *invisible in consequence*,
 * not merely possible.
 *
 * ## And it puts the value back rather than hoping
 *
 * `markRead` in the notifications context predates this and takes the other route — it swallows the
 * failure and lets the next heartbeat correct it. That works there because something polls. For
 * everything else there is nothing coming along behind, so a failed write that left the optimistic
 * value on screen would be a lie with no expiry: the box is ticked, the server says it is not, and
 * the next person to open the engagement sees the truth and nobody knows why.
 *
 * ## It rolls back and then rethrows
 *
 * Reporting is not this function's job. Every call site already had a `catch` that knows what to
 * say — which row, which word, whether a conflict deserves the conflict dialog rather than a
 * toast — and swallowing the error here would silently disarm all of it. So the value goes back
 * and the error carries on to the handler that was always there.
 */

/**
 * @param {object} options
 * @param {any} options.from  the data as it stands, to go back to if the write fails
 * @param {any} options.to    the data as it will be, drawn immediately
 * @param {(value: any) => void} options.setData  the resource's setter
 * @param {() => Promise<any>} options.request    the write itself
 * @param {(opts?: object) => Promise<any>} [options.reload]  a quiet refetch once it lands
 */
export async function optimistically({ from, to, setData, request, reload }) {
  setData(to);
  try {
    await request();
    /*
     * And then the truth, quietly.
     *
     * The optimistic value is a prediction about one field; the server may have done more — an
     * `updatedAt` that another screen sorts by, a counter, a derived flag. This costs a round
     * trip that nobody waits for, which is the whole difference from where it used to be.
     */
    await reload?.({ quiet: true });
  } catch (error) {
    /*
     * `from` rather than a functional update. A React state updater can be called more than once
     * for one write — StrictMode does it deliberately — so an updater that captured "whatever is
     * there now" would capture the optimistic value on its second run and roll back to it.
     */
    setData(from);
    throw error;
  }
}

/**
 * One row of a list, with some fields changed. Identity by string, because an id arrives as an
 * ObjectId from one endpoint and a string from the next.
 */
export function replacing(rows, id, change) {
  return (rows ?? []).map((row) =>
    String(row._id) === String(id) ? { ...row, ...change } : row
  );
}

export default optimistically;
