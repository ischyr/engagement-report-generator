/**
 * Does a field that remounts reuse the socket it already had?
 *
 *   npm run test:collab-rooms --workspace client
 *
 * Opening a finding mounts six shared fields, the finding then arrives from the server, the panel
 * re-renders, and the six mount again. That showed up in the server log as twelve joins for one
 * person looking at one finding — each one a new document, a new handshake, and a caret that
 * disappeared and came back for everybody else.
 *
 * The registry under `useCollab` is what fixes it, and every rule it follows is invisible from the
 * outside: you cannot see reference counting, you can only see a log with half as many lines in
 * it. So the rules are asserted here instead.
 *
 * No server, and no real socket: `WebSocket` is replaced with a stub that never connects, so the
 * provider is built exactly as it is in the browser and simply never comes up. What is measured is
 * how many were built.
 */

import { JSDOM } from 'jsdom';

/* Before yjs and y-websocket load: both read `document` and `window` as their modules initialise. */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
for (const name of ['window', 'document', 'navigator', 'Event', 'MessageEvent', 'CustomEvent']) {
  if (globalThis[name] === undefined && dom.window[name] !== undefined) {
    globalThis[name] = dom.window[name];
  }
}

/**
 * A socket that is constructed and then does nothing at all.
 *
 * Which is the honest stand-in: the case this registry is about is a field mounting, and whether
 * the connection later succeeds or fails is a different question with its own tests. Every instance
 * is counted, because "how many sockets did six mounts and six remounts open" is the whole point.
 */
const built = [];
class DeadSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    built.push(this);
  }

  send() {}

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
globalThis.WebSocket = DeadSocket;

const {
  acquireRoom,
  abandonRoom,
  closeAllRooms,
  recentlyFailed,
  roomState,
  IDLE_GRACE_MS,
  FAILURE_MEMORY_MS,
} = await import('../src/lib/collab-rooms.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

const ME = { id: '650000000000000000000001', name: 'Engy Administrator', colour: '#8b5cf6' };
const OTHER = { id: '650000000000000000000002', name: 'Mario Rossi', colour: '#06b6d4' };
const ROOM = '6a70c9343bb8776321e44693/finding/6a70c9343bb8776321e4469a/description';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A clean start for a block that is about to count sockets.
 *
 * Rooms outlive the field that let go of them, by design, so without this the room from the block
 * before is still open when the next one begins — and is then correctly reused, which reads as
 * "no socket was opened" and looks like a failure of the very thing being tested.
 */
const isolate = () => {
  closeAllRooms();
  built.length = 0;
};

/* ------------------------------------------------------------------ borrowing */
console.log('\nOne room, borrowed twice:');
{
  isolate();
  const first = acquireRoom(ROOM, ME);
  const second = acquireRoom(ROOM, ME);

  check('only one socket is opened', built.length === 1, `${built.length} opened`);
  check('and both borrowers hold the same document', first.doc === second.doc);
  check('and the same provider', first.provider === second.provider);
  check('the first borrower is told it built it', first.fresh === true);
  check('and the second is told it did not', second.fresh === false);
  check('the room counts both of them', roomState().users === 2, JSON.stringify(roomState()));

  check(
    'and the caret carries the borrower’s name from the moment it is taken',
    first.provider.awareness.getLocalState()?.user?.name === ME.name,
    JSON.stringify(first.provider.awareness.getLocalState())
  );

  first.release();
  second.release();
  await settle();
}

console.log('\nA field that unmounts and mounts again:');
{
  isolate();
  const before = acquireRoom(ROOM, ME);
  const providerBefore = before.provider;

  /*
   * The case the whole file exists for: React unmounts and mounts in the same tick, and the room
   * must survive it. Anything that closed on the unmount would make this a second connection.
   */
  before.release();
  const after = acquireRoom(ROOM, ME);
  await settle();

  check('does not open a second socket', built.length === 1, `${built.length} opened`);
  check('and gets its own document back', after.provider === providerBefore);
  check('and is not told it built anything', after.fresh === false);
  after.release();
  await settle();
}

console.log('\nAnd when the last field really has gone:');
{
  isolate();
  const held = acquireRoom(ROOM, ME);
  held.release();

  check(
    'the room is kept for a moment rather than closed at once',
    roomState().open === 1,
    JSON.stringify(roomState())
  );

  await new Promise((resolve) => setTimeout(resolve, IDLE_GRACE_MS + 50));
  check('and closed once the grace period is up', roomState().open === 0, JSON.stringify(roomState()));

  const next = acquireRoom(ROOM, ME);
  check('so asking again after that does open a new one', built.length === 2, `${built.length} opened`);
  next.release();
  await settle();
  closeAllRooms();
}

/* ---------------------------------------------------------------- many rooms */
console.log('\nSix fields of one finding:');
{
  isolate();
  const fields = ['title', 'description', 'scope', 'poc', 'observation', 'remediation'];
  const base = '6a70c9343bb8776321e44693/finding/6a70c9343bb8776321e4469a';
  const held = fields.map((field) => acquireRoom(`${base}/${field}`, ME));

  check('are six rooms, because each field is its own', built.length === 6, `${built.length} opened`);
  check('all counted', roomState().open === 6 && roomState().users === 6, JSON.stringify(roomState()));

  /* The finding arrives, the panel re-renders, and all six mount again in the same tick. */
  for (const one of held) one.release();
  const again = fields.map((field) => acquireRoom(`${base}/${field}`, ME));
  await settle();

  check(
    'and the re-render costs nothing: still six',
    built.length === 6,
    `${built.length} opened in total`
  );
  check('with the same six rooms open', roomState().open === 6, JSON.stringify(roomState()));

  for (const one of again) one.release();
  closeAllRooms();
  check('and closing the session closes all of them', roomState().open === 0, JSON.stringify(roomState()));
}

/* ------------------------------------------------------------------- failing */
console.log('\nWhen the connection cannot be made:');
{
  isolate();
  const held = acquireRoom(ROOM, ME);
  check('nothing is assumed to have failed before it does', recentlyFailed() === false);

  /* Which is what `useCollab` does when its deadline passes with the socket still down. */
  abandonRoom(ROOM);

  check('the room is gone at once, not after a grace period', roomState().open === 0, JSON.stringify(roomState()));
  check('and the failure is remembered', recentlyFailed() === true);
  check(
    'so the other five fields need not each wait their own four seconds',
    FAILURE_MEMORY_MS > 0,
    `${FAILURE_MEMORY_MS}ms`
  );
  held.release();

  /* Not for ever, though: a proxy that was restarting must be allowed to have come back. */
  const realNow = Date.now;
  Date.now = () => realNow() + FAILURE_MEMORY_MS + 1;
  const later = recentlyFailed();
  Date.now = realNow;
  check('but only briefly, so one bad moment is not the rest of the session', later === false);

  closeAllRooms();
  check('and a sign-out forgets it too', recentlyFailed() === false);
}

/* -------------------------------------------------------------------- naming */
console.log('\nAnd whose caret it is:');
{
  isolate();
  const held = acquireRoom(ROOM, ME);
  /*
   * Borrowing sets the name every time rather than only on the first. Somebody who edits their
   * profile between opening two findings would otherwise be two different people to everybody
   * else — the old name on one field's caret and the new one on the next.
   */
  const second = acquireRoom(ROOM, OTHER);
  check(
    'the latest borrower’s name is the one on it',
    held.provider.awareness.getLocalState()?.user?.name === OTHER.name,
    JSON.stringify(held.provider.awareness.getLocalState()?.user)
  );
  held.release();
  second.release();
  closeAllRooms();
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
