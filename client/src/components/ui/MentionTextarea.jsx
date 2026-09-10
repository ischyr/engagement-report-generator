import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';

import { cn, displayName } from '../../lib/utils.js';
import { Textarea } from './Field.jsx';
import { Avatar } from './Misc.jsx';

/**
 * The token the caret is sitting in, if it is a mention being typed.
 *
 * Anchored to the start of a word so an email address does not turn into a
 * mention halfway through, and the handle charset matches the server's.
 */
const MENTION_AT_CARET = /(?:^|[^\w@])@([a-z0-9._-]*)$/i;

function activeMention(value, caret) {
  const match = String(value ?? '')
    .slice(0, caret)
    .match(MENTION_AT_CARET);
  if (!match) return null;
  return { query: match[1].toLowerCase(), start: caret - match[1].length - 1 };
}

/**
 * A textarea that completes `@username` against the people on the instance.
 *
 * The server resolves handles against real accounts when the comment is posted,
 * so completion is a convenience rather than the mechanism — but typing a handle
 * from memory and getting the spelling wrong is exactly how a mention silently
 * notifies nobody, which is what this prevents.
 */
const MentionTextarea = forwardRef(function MentionTextarea(
  { value, onChange, users = [], onKeyDown, className, ...props },
  forwardedRef
) {
  const innerRef = useRef(null);
  const ref = forwardedRef ?? innerRef;
  const [mention, setMention] = useState(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!mention) return [];
    const needle = mention.query;
    return users
      .filter((user) => user.enabled !== false)
      .filter((user) => {
        if (!needle) return true;
        return (
          user.username?.toLowerCase().startsWith(needle) ||
          displayName(user).toLowerCase().includes(needle)
        );
      })
      .slice(0, 6);
  }, [users, mention]);

  // Reset the highlight whenever the candidate list changes underneath it.
  useEffect(() => setActive(0), [mention?.query]);

  const syncMention = (element) => {
    setMention(activeMention(element.value, element.selectionStart ?? 0));
  };

  const insert = (user) => {
    if (!mention) return;
    const element = ref.current;
    const caret = element?.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const next = `${before}@${user.username} ${after}`;
    onChange(next);
    setMention(null);

    // Put the caret after the inserted handle, not at the end of the box.
    const position = before.length + user.username.length + 2;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const open = Boolean(mention) && matches.length > 0;

  const handleKeyDown = (event) => {
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      // Enter picks the highlighted person rather than submitting the form —
      // otherwise completing a mention would post a half-written comment.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insert(matches[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        className={className}
        onChange={(event) => {
          onChange(event.target.value);
          syncMention(event.target);
        }}
        onKeyUp={(event) => syncMention(event.currentTarget)}
        onClick={(event) => syncMention(event.currentTarget)}
        onBlur={() => setMention(null)}
        onKeyDown={handleKeyDown}
        {...props}
      />

      {open ? (
        <ul
          role="listbox"
          aria-label="People you can mention"
          className="absolute bottom-full left-0 z-40 mb-1 w-64 overflow-hidden rounded-xl border border-line bg-overlay shadow-pop"
        >
          {matches.map((user, index) => (
            <li key={user.id ?? user._id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                // The textarea's blur would close the menu before a click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(user)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left transition',
                  index === active ? 'bg-brand-500/12' : 'hover:bg-white/5'
                )}
              >
                <Avatar user={user} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">{displayName(user)}</span>
                  <span className="block truncate font-mono text-[0.625rem] text-fg-subtle">
                    @{user.username}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

export default MentionTextarea;
