import { cn } from '../../lib/utils.js';

export function Card({ className, children, as: Tag = 'div', ...props }) {
  return (
    <Tag
      className={cn(
        'rounded-card border border-line-soft bg-surface/80 shadow-panel backdrop-blur-[2px]',
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, actions, icon: Icon, className }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-5 py-4',
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500/12 text-brand-300">
            <Icon size={16} />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

export function CardFooter({ className, children }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-5 py-3',
        className
      )}
    >
      {children}
    </div>
  );
}

export default Card;
