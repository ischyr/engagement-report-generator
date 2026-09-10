/**
 * One shared document per field, in memory, for as long as somebody is editing it.
 *
 * Two people writing the same paragraph is the one thing this app could never do. It has locks,
 * which are the honest answer when there is no shared document — "Ana has this one" — and a
 * conflict merge for when the locks were not used. Both exist because a save is all-or-nothing.
 * A shared document removes the question instead of answering it.
 *
 * ## What lives here, and what does not
 *
 * This is a **relay with a copy**. The server holds a `Y.Doc` per room so that somebody joining
 * late gets the current state, and it applies updates to that copy so the state stays current. It
 * does **not** understand the document: there is no ProseMirror schema here, no HTML, no notion of
 * what a finding is. That is deliberate — a second document model on the server is a second thing
 * to keep in step with the editor's own schema, and the day they disagree is the day somebody's
 * write-up is silently mangled.
 *
 * ## Where the text actually lives
 *
 * In Mongo, as HTML, exactly as before. Everything else in the app reads it from there — the
 * report, the figure numbering, search, preflight, the assistant — so the shared document is a
 * *way of editing* that field and never a second home for it. The clients write the HTML back
 * through the ordinary endpoint; see `useCollab.js` for which client does it and when, and for
 * what is lost if every one of them vanishes mid-sentence (about a second of typing).
 *
 * A room therefore has no persistence of its own on purpose. It is created from whatever the first
 * client seeds it with, it lives while people are in it, and it is dropped a little after the last
 * of them leaves. On the next open it is seeded again from the HTML. One source of truth.
 */

import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { log } from '../utils/logger.js';

/** The two message kinds y-websocket speaks. Anything else is not for us. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * How long an empty room is kept.
 *
 * Not zero, because the commonest reason a room empties is one person reloading the page, and
 * rebuilding the document for them a second later is work for nothing. Not long, because a room
 * held open is memory held for somebody who has gone.
 */
const EMPTY_ROOM_GRACE_MS = 30_000;

/** Rooms by name. A room is one field of one engagement — see `roomName` in `index.js`. */
const rooms = new Map();

export function roomCount() {
  return rooms.size;
}

/** Everybody currently in a room, as the presence list the sidebar and the section list draw. */
export function roomMembers(name) {
  const room = rooms.get(name);
  if (!room) return [];
  return [...room.awareness.getStates().entries()]
    .map(([, state]) => state?.user)
    .filter((user) => user && user.id);
}

/** Every room somebody is in, so presence can be answered for a whole engagement at once. */
export function membersByRoom(prefix) {
  const out = {};
  for (const [name, room] of rooms) {
    if (prefix && !name.startsWith(prefix)) continue;
    const people = [...room.awareness.getStates().entries()]
      .map(([, state]) => state?.user)
      .filter((user) => user && user.id);
    if (people.length) out[name] = people;
  }
  return out;
}

function createRoom(name) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  /* The server is not a participant: it has no cursor and no name to show anybody. */
  awareness.setLocalState(null);

  const room = { name, doc, awareness, sockets: new Set(), closeTimer: null };

  doc.on('update', (update, origin) => {
    /* Out to everybody except whoever sent it — they already have it. */
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_SYNC);
    syncProtocol.writeUpdate(message, update);
    broadcast(room, encoding.toUint8Array(message), origin);
  });

  awareness.on('update', ({ added, updated, removed }, origin) => {
    /*
     * Which socket owns which cursor.
     *
     * There is no way to ask an awareness update whose it was after the fact, and it has to be
     * known: a cursor left behind by somebody who closed their laptop says a person is in the
     * document. So the origin — the socket the update arrived on, set when it was applied — is
     * recorded here, which is the same bookkeeping the reference y-websocket server does.
     */
    if (origin?.collabControlled) {
      for (const id of added) origin.collabControlled.add(id);
      for (const id of removed) origin.collabControlled.delete(id);
    }

    const changed = added.concat(updated, removed);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, encodeAwarenessUpdate(awareness, changed));
    broadcast(room, encoding.toUint8Array(message), origin);
  });

  rooms.set(name, room);
  return room;
}

function broadcast(room, payload, exceptSocket) {
  for (const socket of room.sockets) {
    if (socket === exceptSocket) continue;
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(payload, (error) => {
      if (error) closeSocket(room, socket);
    });
  }
}

/** Drops a room once nobody has been in it for a while. */
function scheduleClose(room) {
  clearTimeout(room.closeTimer);
  room.closeTimer = setTimeout(() => {
    if (room.sockets.size > 0) return;
    room.doc.destroy();
    rooms.delete(room.name);
    log.debug?.(`Collab room ${room.name} closed`);
  }, EMPTY_ROOM_GRACE_MS);
}

function closeSocket(room, socket) {
  if (!room.sockets.delete(socket)) return;
  /*
   * Their cursor goes with them, and it has to be announced. A remote caret left behind by
   * somebody who closed the tab is worse than no presence at all: it says a person is there.
   */
  const owned = [...(socket.collabControlled ?? [])];
  if (owned.length) removeAwarenessStates(room.awareness, owned, null);
  try {
    socket.close();
  } catch {
    /* Already gone, which is the outcome either way. */
  }
  if (room.sockets.size === 0) scheduleClose(room);
}

/**
 * Puts one authenticated socket into one room.
 *
 * The handshake is y-websocket's: the server offers its state vector, the client answers with
 * whatever the server is missing, and both ends converge. It is the client library's protocol
 * rather than one invented here, which is the point — a protocol this file made up would need a
 * client this file also made up.
 */
export function joinRoom(name, socket) {
  const room = rooms.get(name) ?? createRoom(name);
  clearTimeout(room.closeTimer);
  room.sockets.add(socket);

  socket.binaryType = 'arraybuffer';
  /* The cursors this socket is responsible for, filled in as its updates arrive. */
  socket.collabControlled = new Set();

  socket.on('message', (data) => {
    try {
      const message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const kind = decoding.readVarUint(decoder);

      if (kind === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        /* `socket` as the origin, so the update is not sent back to the socket that sent it. */
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
        if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
        return;
      }

      if (kind === MESSAGE_AWARENESS) {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), socket);
      }
    } catch (error) {
      log.warn(`Collab message on ${name} could not be read: ${error.message}`);
    }
  });

  socket.on('close', () => closeSocket(room, socket));
  socket.on('error', () => closeSocket(room, socket));

  /* Step one of the handshake: here is what I have. */
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  socket.send(encoding.toUint8Array(encoder));

  /* And who else is here, so a joiner sees the others' cursors immediately. */
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      encodeAwarenessUpdate(room.awareness, [...states.keys()])
    );
    socket.send(encoding.toUint8Array(awarenessEncoder));
  }

  return room;
}

/** For the tests, and for a clean shutdown. */
export function closeAllRooms() {
  for (const room of rooms.values()) {
    clearTimeout(room.closeTimer);
    for (const socket of room.sockets) {
      try {
        socket.close();
      } catch {
        /* nothing to do */
      }
    }
    room.doc.destroy();
  }
  rooms.clear();
}

export default joinRoom;
