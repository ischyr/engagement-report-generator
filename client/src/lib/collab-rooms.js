import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

/**
 * One socket per room, however many times the field is mounted.
 *
 * A shared field opens a WebSocket when it mounts and closes it when it unmounts, which was fine
 * until you watched what actually mounts. Opening a finding builds six of these; the finding then
 * arrives from the server, the panel it lives in re-renders with different props, and the six build
 * again. In the server log that is twelve joins for one person looking at one finding — and each
 * rebuild is a fresh document, a fresh handshake, a caret that vanishes and comes back, and a
 * re-run of the rule that decides who writes the text back.
 *
 * So the provider is not owned by the component any more. It is owned here, keyed by room and
 * counted, and a component borrows it.
 *
 * ## Why it is not closed the moment the last one leaves
 *
 * Because "the last one left" and "somebody is about to ask again" look identical from here. A
 * remount is an unmount followed by a mount, and closing on the unmount would make every remount
 * pay for a new connection — which is the thing this exists to stop. So the close is held for a
 * grace period, and anybody who asks for the room in that window gets the live one back with its
 * document, its connection and everybody else's cursors intact.
 *
 * The server does the same thing from the other end: a room there outlives its last member by
 * thirty seconds, so the document does not have to be rebuilt from stored text for somebody who
 * clicked away and back. This is the near side of that decision.
 *
 * ## Why a failure is remembered
 *
 * If the socket cannot be opened at all — a proxy that does not pass upgrades is the usual reason —
 * then it cannot be opened for *any* room, because they all go to one path on one origin. Letting
 * each field discover that for itself means every field waits out the deadline separately, so a
 * finding takes six lots of four seconds to settle into single-writer mode. One failure is
 * therefore remembered for a short while and the rest give up immediately.
 *
 * Briefly, though. A remembered failure that never expires would turn one bad moment — a reverse
 * proxy restarting, a laptop waking up — into an instance that has quietly stopped sharing until
 * somebody reloads the page.
 */

/** Long enough for a slow proxy handshake, short enough that nobody waits for the editor. */
export const CONNECT_DEADLINE_MS = 4000;
/** How long a room is kept after the last field lets go of it. */
export const IDLE_GRACE_MS = 10_000;
/** How long one failed connection speaks for the others. */
export const FAILURE_MEMORY_MS = 30_000;

/** @type {Map<string, {doc: object, provider: object, users: number, closer: any, failed: boolean}>} */
const rooms = new Map();
/** When the last attempt failed, so the next field does not repeat a four-second wait. */
let failedAt = 0;

/** `wss://` when the page is https, and the same host either way: one origin, one proxy rule. */
function socketBase() {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/collab`;
}

/** Whether it is worth trying at all, or whether something just told us it is not. */
export function recentlyFailed() {
  return failedAt > 0 && Date.now() - failedAt < FAILURE_MEMORY_MS;
}

/** Called when a connection could not be established, for everybody else's benefit. */
export function noteFailure() {
  failedAt = Date.now();
}

/** For tests, and for a console that wants to know what is open. */
export function roomState() {
  return {
    open: rooms.size,
    users: [...rooms.values()].reduce((total, entry) => total + entry.users, 0),
    failedRecently: recentlyFailed(),
  };
}

function destroy(room) {
  const entry = rooms.get(room);
  if (!entry) return;
  rooms.delete(room);
  /*
   * Announced before the socket goes, so a colleague's screen loses the caret rather than keeping
   * a ghost of it. The server removes a departed client's cursors as well, so this is belt and
   * braces — but the belt is what makes the common case instant.
   */
  try {
    entry.provider.awareness.setLocalState(null);
  } catch {
    /* A provider already torn down by a network error. */
  }
  entry.provider.destroy();
  entry.doc.destroy();
}

/**
 * Borrows the room, building it if nobody has it open.
 *
 * @param {string} room `<auditId>/finding/<id>/description` and the other shapes the server accepts
 * @param {{id: string, name: string, colour: string}} me whose caret this is
 * @returns {{doc: object, provider: object, release: () => void, fresh: boolean}}
 */
export function acquireRoom(room, me) {
  let entry = rooms.get(room);
  const fresh = !entry;

  if (entry) {
    /* Somebody wants it again — whatever was going to close it is now wrong. */
    if (entry.closer) {
      clearTimeout(entry.closer);
      entry.closer = null;
    }
  } else {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(socketBase(), room, doc, {
      /* The cookie goes by itself; there is no token in this URL. See `collab/index.js`. */
      connect: true,
    });
    entry = { doc, provider, users: 0, closer: null, failed: false };
    rooms.set(room, entry);
  }

  entry.users += 1;

  /*
   * Set on every borrow rather than only on the first, so somebody who changed their name in the
   * time between opening two findings is not two different people to everybody else.
   */
  entry.provider.awareness.setLocalStateField('user', {
    id: me.id,
    name: me.name,
    color: me.colour,
  });

  let released = false;
  return {
    doc: entry.doc,
    provider: entry.provider,
    fresh,
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;

      /* Held, not closed. See the note at the top of the file. */
      entry.closer = setTimeout(() => {
        if (rooms.get(room) === entry && entry.users <= 0) destroy(room);
      }, IDLE_GRACE_MS);
    },
  };
}

/**
 * Gives up on a room that never connected, for everybody rather than only for the caller.
 *
 * Separate from `release` because the two mean different things: releasing is a component going
 * away and expecting the room to be there when it comes back, while this is the room being no good.
 */
export function abandonRoom(room) {
  noteFailure();
  const entry = rooms.get(room);
  if (!entry) return;
  entry.failed = true;
  entry.users = 0;
  if (entry.closer) clearTimeout(entry.closer);
  destroy(room);
}

/** Closes everything, for a sign-out. Nothing here should outlive the session that opened it. */
export function closeAllRooms() {
  for (const room of [...rooms.keys()]) {
    const entry = rooms.get(room);
    if (entry?.closer) clearTimeout(entry.closer);
    entry.users = 0;
    destroy(room);
  }
  failedAt = 0;
}
