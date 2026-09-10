import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CONNECT_DEADLINE_MS,
  abandonRoom,
  acquireRoom,
  recentlyFailed,
} from '../lib/collab-rooms.js';

/**
 * A shared document for one field, or nothing at all.
 *
 * ## No fallback, on purpose
 *
 * If the socket does not open — a proxy that does not pass upgrades, a network that blocks them,
 * an instance behind something nobody has configured yet — this gives up and reports
 * `unavailable`, and the editor mounts exactly as it always has: one writer, the soft lock that
 * says who has it, and the conflict merge if two people save anyway.
 *
 * The alternative, polling the document over HTTP, was deliberately not built. It is a second
 * transport with a second set of failure modes for a feature that is *only* worth having when it
 * is instant; a shared document that catches up every few seconds is not collaboration, it is a
 * slower way to overwrite somebody. Better to do one thing properly and degrade to the honest
 * single-writer behaviour that already works.
 *
 * ## Giving up quickly
 *
 * `y-websocket` reconnects for ever by design, which is right for a document that is already open
 * and wrong for deciding whether this instance can do this at all. So there is a deadline: if the
 * first connection has not opened by then, the room is abandoned and the field stays in
 * single-writer mode until it is opened again. Nothing retries in the background.
 *
 * ## The socket is not this hook's
 *
 * It belongs to `collab-rooms.js`, keyed by room and reference-counted, and this borrows it. That
 * is what makes a remount free: mounting six fields, having the finding arrive, and re-rendering
 * used to be twelve connections. Everything below therefore reads the provider's *current* state
 * on the way in rather than assuming a connection starts out closed — the room this hook is handed
 * may have been open, synced and full of other people's cursors for the last ten minutes.
 */

/**
 * A colour per person, from their id.
 *
 * Stable, so somebody's cursor is the same colour for everybody looking at it and the same colour
 * tomorrow. Picked from a small set with enough contrast against the editor's background rather
 * than generated, because a random hue is regularly unreadable.
 */
const CURSOR_COLOURS = [
  '#8b5cf6',
  '#06b6d4',
  '#f59e0b',
  '#ec4899',
  '#10b981',
  '#6366f1',
  '#ef4444',
  '#14b8a6',
];

export function cursorColour(id) {
  const text = String(id ?? '');
  let hash = 0;
  for (let at = 0; at < text.length; at += 1) hash = (hash * 31 + text.charCodeAt(at)) >>> 0;
  return CURSOR_COLOURS[hash % CURSOR_COLOURS.length];
}

/**
 * @param {string|null} room `<auditId>/finding/<id>/description`, or null to stay single-writer
 * @param {{user: object, enabled?: boolean}} options
 * @returns {{status: string, provider: object|null, doc: object|null, people: Array, isWriter: boolean}}
 */
export function useCollab(room, { user, enabled = true } = {}) {
  const [status, setStatus] = useState('idle');
  /**
   * Whether the first exchange with the server has finished.
   *
   * Different from being connected, and the difference matters: between the socket opening and the
   * server's state arriving, the shared document is legitimately empty. Anything that decides
   * "this document is empty, so I will fill it" in that window fills a document that already had
   * text in it, and the finding ends up saying everything twice.
   */
  const [synced, setSynced] = useState(false);
  const [people, setPeople] = useState([]);
  const [isWriter, setIsWriter] = useState(true);
  const handleRef = useRef(null);
  const [, force] = useState(0);

  const me = useMemo(
    () => ({
      /* `id` first: that is what the account endpoint sends. The other is for a raw user row. */
      id: String(user?.id ?? user?._id ?? ''),
      name: user?.fullname || user?.username || 'Somebody',
      colour: cursorColour(user?.id ?? user?._id ?? ''),
    }),
    [user]
  );

  useEffect(() => {
    if (!room || !enabled || !me.id || typeof window === 'undefined') {
      setStatus('idle');
      return undefined;
    }

    /*
     * Something has just failed to connect, and every room goes to the same path on the same
     * origin — so this one will fail too. Said immediately rather than after another four seconds
     * of a field pretending it might work.
     */
    if (recentlyFailed()) {
      setStatus('unavailable');
      return undefined;
    }

    /*
     * Borrowed, not built. The name and colour a colleague sees on the caret are set as part of
     * taking it, so nobody is ever an anonymous cursor — which is worse than no cursor: it says
     * somebody is here and will not say who.
     */
    const held = acquireRoom(room, me);
    const { doc, provider } = held;

    handleRef.current = { doc, provider };
    /* Already up, if somebody else in this tab had it open. Starting at 'connecting' would blink. */
    setStatus(provider.wsconnected ? 'connected' : 'connecting');
    setSynced(Boolean(provider.synced));

    const readPeople = () => {
      const states = [...provider.awareness.getStates().entries()];
      setPeople(
        states
          .map(([clientId, state]) => ({ clientId, ...(state?.user ?? {}) }))
          .filter((person) => person.id)
      );
      /*
       * Who writes the HTML back to the engagement.
       *
       * Exactly one of us, chosen by the lowest client id present — deterministic, needing no
       * coordination, and re-decided the moment that person leaves. Everybody saving would mean
       * everybody racing the freshness check on the same field and all but one being told they
       * were out of date, which is precisely the argument this feature exists to end.
       */
      const ids = states.map(([clientId]) => clientId);
      setIsWriter(ids.length === 0 || Math.min(...ids) === doc.clientID);
    };

    provider.awareness.on('change', readPeople);
    /*
     * Read once on the way in, not only when something next changes.
     *
     * A borrowed room may have been connected and full of people for ten minutes, and its
     * `status` event fired long before this hook existed. Waiting for the next awareness change
     * would show an empty field with nobody in it, and — worse — leave the writer election at its
     * optimistic default, so two people would both believe they were the one who saves.
     */
    readPeople();

    const onStatus = ({ status: next }) => {
      if (next === 'connected') {
        setStatus('connected');
        readPeople();
      }
    };
    provider.on('status', onStatus);
    const onSync = (isSynced) => {
      setSynced(Boolean(isSynced));
      force((count) => count + 1);
    };
    provider.on('sync', onSync);

    /*
     * One chance, and only for a room this hook actually opened. A room that was already up needs
     * no deadline — it is already connected, and a borrowed one that somebody else is using must
     * not be torn down by a newcomer's timer.
     */
    const deadline = held.fresh
      ? setTimeout(() => {
          if (provider.wsconnected) return;
          /* For every other field as well, not only this one. */
          abandonRoom(room);
          handleRef.current = null;
          setStatus('unavailable');
        }, CONNECT_DEADLINE_MS)
      : null;

    return () => {
      if (deadline) clearTimeout(deadline);
      setSynced(false);
      provider.awareness.off('change', readPeople);
      provider.off('status', onStatus);
      provider.off('sync', onSync);
      /*
       * Handed back rather than closed. The cursor is deliberately *not* cleared here: the room may
       * be borrowed again in the next tick by the remount that caused this, and a caret that
       * flickers off and on for everybody else on every re-render is worse than no caret at all.
       * `collab-rooms.js` announces the departure when it really does close the room.
       */
      held.release();
      handleRef.current = null;
    };
  }, [room, enabled, me.id, me.name, me.colour]);

  const handle = handleRef.current;
  return {
    status,
    /** True once the server's copy has arrived. Nothing may seed the document before this. */
    synced,
    /* Only once the socket is actually up: an editor must never bind to a document that is not shared. */
    provider: status === 'connected' ? handle?.provider ?? null : null,
    doc: status === 'connected' ? handle?.doc ?? null : null,
    people,
    isWriter,
    me,
  };
}

export default useCollab;
