import { cn } from '../../lib/utils.js';

/**
 * Presentational table primitives. Horizontal overflow is contained here so a
 * wide table never makes the page itself scroll sideways.
 */
export function Table({ className, children }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full min-w-full border-collapse text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ children }) {
  return (
    <thead className="border-b border-line-soft bg-white/[0.02]">
      <tr>{children}</tr>
    </thead>
  );
}

/**
 * A column heading, and optionally a control for ordering by it.
 *
 * `sort` is a `useTableSort()` and `sortKey` names this column in it. Both or neither: a heading
 * that looks sortable and is not is worse than one that plainly is not, and most columns — an
 * actions column, a checkbox — have nothing to sort by.
 *
 * `aria-sort` on the cell rather than a label on the button, because that is what a screen reader
 * announces when it reaches the column, which is the moment the information is useful.
 */
export function TH({ children, className, align = 'left', width, sort, sortKey }) {
  const sortable = Boolean(sort && sortKey);
  const active = sortable && sort.key === sortKey;

  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      aria-sort={active ? (sort.direction === 'desc' ? 'descending' : 'ascending') : undefined}
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => sort.toggle(sortKey)}
          title={`Sort by ${typeof children === 'string' ? children.toLowerCase() : 'this column'}`}
          className={cn(
            'group inline-flex items-center gap-1 rounded uppercase tracking-wider transition hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            align === 'right' && 'flex-row-reverse',
            active && 'text-fg'
          )}
        >
          {children}
          {/*
            An arrow only on the column doing the sorting, and a faint one on hover elsewhere —
            so the table is not a row of arrows, and it is still discoverable without one.
          */}
          <span
            aria-hidden
            className={cn(
              'text-[0.625rem] leading-none transition',
              active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
            )}
          >
            {active && sort.direction === 'desc' ? '▼' : '▲'}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TBody({ children, className }) {
  return <tbody className={cn('divide-y divide-line-soft', className)}>{children}</tbody>;
}

export function TR({ children, className, onClick, ...props }) {
  const interactive = Boolean(onClick);
  return (
    <tr
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick(event);
              }
            }
          : undefined
      }
      tabIndex={interactive ? 0 : undefined}
      className={cn(
        'transition-colors',
        interactive && 'cursor-pointer hover:bg-white/[0.035] focus:bg-white/[0.05] focus:outline-none',
        className
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export function TD({ children, className, align = 'left', colSpan }) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'px-4 py-3 align-middle text-fg',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className
      )}
    >
      {children}
    </td>
  );
}

export default Table;
