import { Loader2, SearchX } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from './Button.jsx';

export function Spinner({ size = 18, className }) {
  return <Loader2 size={size} className={cn('animate-spin text-fg-subtle', className)} />;
}

export function LoadingBlock({ label = 'Loading…', className }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-14 text-sm text-fg-muted', className)}>
      <Spinner />
      {label}
    </div>
  );
}

/** Skeleton rows sized like the table they stand in for. */
export function SkeletonRows({ rows = 5, columns = 4 }) {
  return (
    <div className="divide-y divide-line-soft">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <div
              key={columnIndex}
              className="h-3 animate-pulse rounded bg-white/6"
              style={{
                width: columnIndex === 0 ? '32%' : `${Math.max(10, 22 - columnIndex * 3)}%`,
                animationDelay: `${(rowIndex * columns + columnIndex) * 40}ms`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon = SearchX,
  title,
  description,
  actionLabel,
  onAction,
  actionIcon,
  className,
  children,
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <span className="grid size-11 place-items-center rounded-xl bg-white/5 text-fg-subtle">
        <Icon size={20} />
      </span>
      <h3 className="mt-3.5 text-sm font-semibold text-fg">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-fg-muted text-balance">
          {description}
        </p>
      ) : null}
      {actionLabel && onAction ? (
        <Button variant="primary" size="sm" className="mt-4" onClick={onAction} icon={actionIcon}>
          {actionLabel}
        </Button>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }) {
  return (
    <div className={cn('px-6 py-12 text-center', className)}>
      <p className="text-sm font-medium text-crit">
        {error?.message ?? 'Something went wrong loading this page'}
      </p>
      {error?.detailText ? (
        <p className="mx-auto mt-1.5 max-w-md whitespace-pre-line text-xs text-fg-muted">
          {error.detailText}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Full-page loader used while the session is being restored. */
export function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-brand-500/15 text-brand-300">
          <Spinner size={20} className="text-brand-300" />
        </div>
        <p className="text-xs text-fg-subtle">Restoring your session…</p>
      </div>
    </div>
  );
}

export default LoadingBlock;
