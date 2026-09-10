import { useState } from 'react';
import { X } from 'lucide-react';

import { Field, Input } from './Field.jsx';

/**
 * Chips, a box to type in, and what other people have already used.
 *
 * Extracted from the engagement's tag card when findings got tags of their own, rather than written
 * a second time. The two are the same widget over a different array, and the interesting parts —
 * lower-casing on the way in, refusing a duplicate silently rather than complaining, offering what
 * is already in use so the same idea is not spelled three ways — are exactly the parts that would
 * have drifted apart.
 *
 * Controlled: it owns the half-typed word and nothing else. Who saves the array, and when, is the
 * caller's business, because the two callers answer that differently — an engagement writes each
 * change straight through, and a finding's tags travel with the rest of the form to the save button.
 */
export default function TagPicker({
  value,
  onChange,
  suggestions = [],
  editable = true,
  busy = false,
  label,
  hint,
  placeholder = 'Add a tag and press enter',
  empty = 'None yet.',
  max = 20,
}) {
  const [draft, setDraft] = useState('');
  const tags = value ?? [];
  const full = tags.length >= max;

  const add = (raw) => {
    const tag = String(raw ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 40);
    setDraft('');
    /* A duplicate is not an error, it is a thing somebody already did. */
    if (!tag || tags.includes(tag) || full) return;
    onChange([...tags, tag]);
  };

  const remove = (tag) => onChange(tags.filter((entry) => entry !== tag));

  const offered = (suggestions ?? [])
    .filter((entry) => !tags.includes(entry.tag))
    .filter((entry) => (draft ? entry.tag.includes(draft.trim().toLowerCase()) : true))
    .slice(0, 8);

  const body = (
    <div className="flex flex-col gap-2.5">
      {tags.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag}>
              <span className="inline-flex items-center gap-1 rounded-md bg-brand-500/12 px-2 py-1 text-[0.6875rem] font-medium text-brand-300 ring-1 ring-inset ring-brand-500/25">
                {tag}
                {editable ? (
                  <button
                    type="button"
                    aria-label={`Remove the tag ${tag}`}
                    disabled={busy}
                    className="transition hover:text-fg"
                    onClick={() => remove(tag)}
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-fg-subtle">{empty}</p>
      )}

      {editable ? (
        <>
          <Input
            placeholder={full ? `That is ${max} tags — plenty` : placeholder}
            value={draft}
            disabled={busy || full}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add(draft);
              }
              /* Backspace on an empty box takes the last one off, which is what people try. */
              if (event.key === 'Backspace' && !draft && tags.length) remove(tags.at(-1));
            }}
          />
          {/* What is already in use elsewhere, so the same idea is not spelled three ways. */}
          {offered.length ? (
            <div className="flex flex-wrap gap-1.5">
              {offered.map((entry) => (
                <button
                  key={entry.tag}
                  type="button"
                  disabled={busy || full}
                  onClick={() => add(entry.tag)}
                  className="rounded-md bg-canvas/60 px-2 py-1 text-[0.625rem] text-fg-muted ring-1 ring-line transition hover:text-fg hover:ring-brand-500/30"
                >
                  {entry.tag}
                  <span className="ml-1 text-fg-subtle">{entry.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );

  return label === undefined ? body : <Field label={label} hint={hint}>{body}</Field>;
}
