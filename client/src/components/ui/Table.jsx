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

export function TH({ children, className, align = 'left', width }) {
  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className
      )}
    >
      {children}
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
