import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { cn, displayName, initialsOf } from '../../lib/utils.js';

export function PageHeader({ title, description, actions, breadcrumb, className }) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1.5">{breadcrumb}</div> : null}
        <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className, autoFocus }) {
  return (
    <div className={cn('relative', className)}>
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg bg-canvas/60 pl-9 pr-8 text-sm text-fg ring-1 ring-line transition placeholder:text-fg-subtle focus:ring-2 focus:ring-brand-500 focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Segmented control. Options are `{ value, label, count?, icon? }`.
 *
 * Scrolls sideways when it does not fit, which an engagement's fifteen tabs stopped
 * doing on a laptop a while ago. It always *could* — the row has been `overflow-x-auto`
 * from the start — but the scrollbar was hidden, so there was nothing to grab and no
 * sign that anything had been cut off. The bar looked like it ended at "Documents".
 *
 * So the overflow is made visible and reachable three ways, and none of them appear
 * until there is actually something off-screen:
 *
 *   - the clipped edge fades out, which is the only honest way to say "there is more"
 *   - a chevron sits over each faded edge and scrolls by most of a screenful
 *   - the wheel scrolls it sideways while hovering, and hands the page back its wheel
 *     at either end rather than swallowing it
 *
 * The fade is a mask on the row rather than a gradient painted over it: a gradient has
 * to know what colour is behind it, and this control sits on three different surfaces.
 * The mask is on an inner element so the pill's own background, ring and corners stay
 * crisp — masking the container faded those too.
 *
 * Arrow keys move focus along the tabs and Enter selects, rather than selecting as
 * focus arrives: each of these tabs fetches, and holding a key down should not fire ten
 * requests. The bar is one tab stop, so a keyboard reaches the rest of the page without
 * walking through fifteen buttons.
 */
export function Tabs({ options, value, onChange, className, size = 'md' }) {
  const scroller = useRef(null);
  /** Whether anything is cut off on each side. Both false means it fits. */
  const [clipped, setClipped] = useState({ left: false, right: false });
  /**
   * How far the row can scroll.
   *
   * Kept in state rather than read when needed, because it is what tells the
   * keep-the-tab-visible effect below to look again. The row grows after it first
   * renders — the counts beside "Findings" and "Sections" arrive with the data — and a
   * tab that was scrolled to the end of a narrower row is a few pixels off the end of
   * the wider one.
   */
  const [reach, setReach] = useState(0);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const furthest = el.scrollWidth - el.clientWidth;
    // A pixel of slack: fractional layout widths make an exact comparison flicker.
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < furthest - 1;
    /*
     * The same answer as last time is the usual answer — scrolling asks this on every
     * frame and it changes at most twice — so hand back the object we already have.
     * A fresh one would re-render the whole row forty times per press for nothing.
     */
    setClipped((current) =>
      current.left === left && current.right === right ? current : { left, right }
    );
    setReach(furthest);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    measure();
    el.addEventListener('scroll', measure, { passive: true });

    /*
     * The row's own width, and its contents'. Both matter: the window resizes, and a
     * count appearing next to a label as data arrives widens the row without any
     * resize of the row itself.
     */
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);

    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure, options.length]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;

    const onWheel = (event) => {
      if (el.scrollWidth <= el.clientWidth) return;
      // A trackpad's sideways gesture already scrolls this; doubling it would race.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const furthest = el.scrollWidth - el.clientWidth;
      const stuck =
        (event.deltaY < 0 && el.scrollLeft <= 0) || (event.deltaY > 0 && el.scrollLeft >= furthest);
      // At either end the wheel goes back to the page, rather than the bar eating it.
      if (stuck) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };

    // Not React's onWheel: preventDefault needs a listener that is not passive.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * Keeps the selected tab on screen — including on arrival, since a deep link can name
   * a tab that is off the end of the bar.
   *
   * Written out rather than `scrollIntoView`, which also scrolls whatever contains this,
   * so landing on such a link would jump the whole page down to the tab bar.
   *
   * From bounding rectangles and as a relative nudge, not from `offsetLeft`: that is
   * measured against the nearest positioned ancestor, which here is the pill outside
   * this row, so its padding made every calculation a couple of pixels wrong — enough
   * to stop two tab-widths short and leave a chevron pointing at nothing.
   */
  useEffect(() => {
    const el = scroller.current;
    const active = el?.querySelector('[aria-selected="true"]');
    if (!el || !active) return;
    const row = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const margin = 24;
    if (tab.left < row.left) el.scrollLeft += tab.left - row.left - margin;
    else if (tab.right > row.right) el.scrollLeft += tab.right - row.right + margin;
  }, [value, options.length, reach]);

  /*
   * Moves now, rather than over the four hundred milliseconds a smooth scroll takes.
   *
   * `behavior: 'smooth'` was the whole of the lag: measured, a press dropped no frames
   * and ran no long task, it just took 411ms to arrive — and Chrome spends about that
   * long whatever the distance, so a small nudge felt worse than a big one. Pressing
   * twice quickly was worse again, each press restarting an animation already running.
   * Scrollbar arrows have always jumped; this does too.
   */
  const nudge = (direction) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft += direction * Math.max(120, el.clientWidth * 0.7);
  };

  const onKeyDown = (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();

    const buttons = [...(scroller.current?.querySelectorAll('[role="tab"]') ?? [])];
    if (!buttons.length) return;
    const from = buttons.indexOf(document.activeElement);
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : // Wraps, so the end of a long bar is one keypress from the start of it.
            (((from === -1 ? buttons.findIndex((b) => b.ariaSelected === 'true') : from) + step) +
              buttons.length) %
            buttons.length;
    buttons[to]?.focus();
  };

  /* Faded only where something is actually cut off, and wide enough to sit under the
     chevron that covers it. */
  const fade = (() => {
    if (!clipped.left && !clipped.right) return undefined;
    const from = clipped.left ? 'transparent 0, black 2.25rem' : 'black 0';
    const to = clipped.right ? 'black calc(100% - 2.25rem), transparent 100%' : 'black 100%';
    return `linear-gradient(to right, ${from}, ${to})`;
  })();

  const arrow = (side) => (
    <button
      type="button"
      // A mouse affordance for what the arrow keys already do, so it stays out of the
      // tab order and out of the tablist, where it would be counted as a tab.
      aria-hidden="true"
      tabIndex={-1}
      onClick={() => nudge(side === 'left' ? -1 : 1)}
      className={cn(
        'absolute top-1/2 z-10 grid -translate-y-1/2 place-items-center rounded-md text-fg-muted transition-colors hover:bg-raised hover:text-fg',
        size === 'sm' ? 'size-6' : 'size-7',
        side === 'left' ? 'left-0.5' : 'right-0.5'
      )}
    >
      {side === 'left' ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
    </button>
  );

  return (
    <div
      className={cn(
        'relative inline-flex max-w-full items-center rounded-lg bg-canvas/60 p-0.5 ring-1 ring-line',
        className
      )}
    >
      {clipped.left ? arrow('left') : null}
      <div
        ref={scroller}
        role="tablist"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar"
        style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              // One tab stop for the whole bar; the arrow keys move within it.
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium transition-colors',
                size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[0.8125rem]',
                active ? 'bg-raised text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.icon ? <option.icon size={14} /> : null}
              {option.label}
              {option.count !== undefined ? (
                <span
                  className={cn(
                    'rounded px-1 font-mono text-[0.625rem]',
                    active ? 'bg-white/8 text-fg-muted' : 'text-fg-subtle'
                  )}
                >
                  {option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {clipped.right ? arrow('right') : null}
    </div>
  );
}

export function Avatar({ user, name, size = 32, className }) {
  const label = initialsOf(user ?? name);
  return (
    <span
      title={typeof name === 'string' ? name : undefined}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-brand-600/25 font-semibold text-brand-300 ring-1 ring-brand-500/20',
        className
      )}
    >
      {label}
    </span>
  );
}

/**
 * A row of avatars with a "+n" overflow chip.
 *
 * Spaced rather than overlapped. Overlapping needs each avatar to be opaque and to
 * carry a ring in the colour of whatever is behind it — but these sit in table rows,
 * cards and hover states, so the ring never matched, and the fill is translucent, so
 * the avatar underneath showed through the overlap. Two initials on top of each other
 * read as one unreadable smudge, which is exactly what a team column must not do.
 *
 * The whole group is titled with everyone's name, including the ones folded into +n,
 * because that is the question being asked of it.
 */
export function AvatarGroup({ users = [], max = 4, size = 26 }) {
  const nameOf = (user) => displayName(user) || user?.username || 'Unnamed';

  /*
   * Deduplicated, because the lists handed to this are composed rather than stored: an engagement's
   * team is its creator plus its collaborators, and somebody who is both appeared twice — as two
   * identical avatars, and as a React key collision, which is the same person being drawn over
   * themselves. Whoever composes the list should not have to remember.
   */
  const unique = [];
  const seen = new Set();
  for (const user of users) {
    const key = String(user?.id ?? user?._id ?? nameOf(user));
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(user);
  }
  const shown = unique.slice(0, max);
  const hidden = unique.slice(max);

  if (!unique.length) return <span className="text-xs text-fg-subtle">—</span>;

  return (
    <div className="flex items-center gap-1" title={unique.map(nameOf).join(', ')}>
      {shown.map((user, index) => (
        <Avatar
          key={user?.id ?? user?._id ?? index}
          user={user}
          name={nameOf(user)}
          size={size}
        />
      ))}
      {hidden.length ? (
        <span
          title={hidden.map(nameOf).join(', ')}
          style={{ width: size, height: size, fontSize: size * 0.34 }}
          className="grid shrink-0 place-items-center rounded-full bg-white/8 font-semibold text-fg-muted ring-1 ring-line"
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

/** Monospace chip for template tags, with click-to-copy. */
export function TagChip({ tag, prefix = '', onCopy, className }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const full = prefix === '@' ? `{{@${tag}}}` : `{{ .${tag} }}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      onCopy?.(full);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      onCopy?.(full);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${full}`}
      className={cn(
        'group inline-flex items-center rounded-md bg-canvas/70 px-1.5 py-0.5 font-mono text-[0.6875rem] text-brand-300 ring-1 ring-line transition hover:bg-brand-500/10 hover:ring-brand-500/30',
        className
      )}
    >
      {copied ? <span className="text-low">copied</span> : full}
    </button>
  );
}

/** Small labelled stat used on the dashboard and audit header. */
export function Stat({ label, value, sub, tone = 'neutral', icon: Icon }) {
  const toneText =
    { crit: 'text-crit', high: 'text-high', med: 'text-med', low: 'text-low', info: 'text-info' }[
      tone
    ] ?? 'text-fg';
  return (
    <div className="rounded-xl border border-line-soft bg-surface/70 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-fg-subtle">{label}</p>
        {Icon ? <Icon size={14} className="text-fg-subtle" /> : null}
      </div>
      {/* Proportional figures, not tabular: equal-width digits make a headline
          number like 121 look loose at this size. Tabular belongs in table columns,
          where digits have to line up vertically. */}
      <p className={cn('mt-1.5 text-2xl font-semibold', toneText)}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-fg-muted">{sub}</p> : null}
    </div>
  );
}

export default PageHeader;
