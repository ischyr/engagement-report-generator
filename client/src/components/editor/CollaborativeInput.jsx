import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../context/AuthContext.jsx';
import { useCapabilities } from '../../context/CapabilitiesContext.jsx';
import { useCollab } from '../../hooks/useCollab.js';
import { textDelta } from '../../lib/text-delta.js';

/**
 * A single-line box, shared with whoever else has it open.
 *
 * The rich-text fields get this for free: ProseMirror has a document, and Yjs binds to it. A plain
 * `<input>` has no document, so this is the other half — a `Y.Text` on one side, a controlled input
 * on the other, and `textDelta` in between working out which characters actually changed.
 *
 * ## What it does not have
 *
 * **A caret with a name on it.** There is nowhere to put one: a plain input renders no DOM for its
 * own text, so a coloured caret and a floating label cannot be positioned inside it. Instead the
 * names of anybody else in the field appear beside the label, which answers the same question one
 * step less precisely — you know Mario is in the title, not which character he is on.
 *
 * ## Why the value is not simply pushed in
 *
 * Because the box is being typed in while it arrives. Assigning the whole shared value to the input
 * on every remote change would move the caret to the end mid-word, which is the thing that makes
 * shared single-line fields unusable. So a remote change is applied through `onChange` like any
 * other, and the caret is put back where it was relative to the text that did not move.
 */
export default function CollaborativeInput({
  as: Component,
  auditId,
  scope,
  id,
  field,
  enabled = true,
  value,
  onChange,
  label,
  ...rest
}) {
  const { user } = useAuth();
  const { collab: allowed } = useCapabilities();

  /* Nothing attempted when sharing is off — see the note in `CollaborativeField`. */
  const room =
    allowed && enabled && auditId && id && field
      ? `${auditId}/${scope}/${id}/${field}`
      : null;
  const { provider, doc, synced, people, isWriter, me } = useCollab(room, { user });

  /* Everybody but me — see the note in `CollaborativeField`. */
  const others = people.filter((person) => String(person.id) !== me.id);
  const live = Boolean(provider && doc && synced);

  const inputRef = useRef(null);
  /* What the shared text said last time we looked, so a remote change can be told from our own. */
  const mirrored = useRef('');
  const [ready, setReady] = useState(false);

  /* ------------------------------------------------------------- the binding */
  useEffect(() => {
    if (!live || !doc) {
      setReady(false);
      return undefined;
    }

    const shared = doc.getText('text');

    /*
     * The seed, by one client only, and only once the server's copy has arrived — the same rule the
     * rich-text fields follow, and for the same reason. Seeding an empty-looking document that is
     * merely still loading is how a field comes to contain itself twice.
     */
    if (isWriter && shared.length === 0 && String(value ?? '').length > 0) {
      shared.insert(0, String(value));
    }

    mirrored.current = shared.toString();
    setReady(true);

    const observe = (event, transaction) => {
      const text = shared.toString();
      mirrored.current = text;
      /* Our own edit, already in the box. Reapplying it would fight the caret for no reason. */
      if (transaction.local) return;

      const element = inputRef.current;
      const caret = element?.selectionStart ?? null;
      onChange?.(text);

      /*
       * Put the caret back. Somebody else inserting three characters before the cursor should move
       * it along by three, not to the end of the line — and `event.delta` is exactly how far.
       */
      if (element && caret !== null) {
        let shift = 0;
        let at = 0;
        for (const part of event.delta ?? []) {
          if (part.retain) at += part.retain;
          else if (part.insert) {
            if (at <= caret) shift += String(part.insert).length;
            at += String(part.insert).length;
          } else if (part.delete) {
            if (at < caret) shift -= Math.min(part.delete, caret - at);
          }
        }
        const next = Math.max(0, caret + shift);
        requestAnimationFrame(() => {
          try {
            element.setSelectionRange(next, next);
          } catch {
            /* A box that has since lost focus, or is no longer in the document. */
          }
        });
      }
    };

    shared.observe(observe);

    /* Whatever the document says is the truth on arrival, even if this box was showing something else. */
    const initial = shared.toString();
    if (initial !== String(value ?? '')) onChange?.(initial);

    return () => shared.unobserve(observe);
    /* `value` deliberately absent: this effect binds once per document, and reads it only to seed. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, doc, isWriter]);

  /* --------------------------------------------------------- what we type in */
  const handleChange = (event) => {
    const next = event.target.value;
    onChange?.(next);

    if (!live || !doc || !ready) return;
    const shared = doc.getText('text');
    const delta = textDelta(mirrored.current, next);
    if (!delta) return;

    /*
     * One transaction, so a replacement is one change rather than a delete everybody sees followed
     * by an insert. `mirrored` is updated by the observer, which fires inside this transaction.
     */
    doc.transact(() => {
      if (delta.remove > 0) shared.delete(delta.at, delta.remove);
      if (delta.insert) shared.insert(delta.at, delta.insert);
    });
  };

  return (
    <Component
      {...rest}
      ref={inputRef}
      label={
        label !== undefined && live && others.length ? (
          <span className="flex items-center gap-1.5">
            {label}
            {others.map((person) => (
              <span
                key={person.clientId}
                title={`${person.name} is editing this`}
                className="rounded-full px-1.5 text-[0.625rem] font-normal ring-1"
                style={{ '--tw-ring-color': person.color, color: person.color }}
              >
                {person.name}
              </span>
            ))}
          </span>
        ) : (
          label
        )
      }
      value={value ?? ''}
      onChange={handleChange}
      /* So a shared box is recognisable as one even when nobody else is in it. */
      data-shared={live ? me.id : undefined}
    />
  );
}
