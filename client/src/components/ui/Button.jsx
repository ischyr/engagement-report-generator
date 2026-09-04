import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const VARIANTS = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-sm shadow-brand-700/30',
  secondary: 'bg-raised text-fg ring-1 ring-line hover:bg-overlay hover:ring-line',
  ghost: 'text-fg-muted hover:bg-white/5 hover:text-fg',
  outline: 'ring-1 ring-line text-fg hover:bg-white/5',
  danger: 'bg-crit/15 text-crit ring-1 ring-crit/30 hover:bg-crit/25',
  subtle: 'bg-white/5 text-fg-muted hover:bg-white/10 hover:text-fg',
};

const SIZES = {
  xs: 'h-7 px-2 text-xs gap-1 rounded-md',
  sm: 'h-8 px-3 text-[0.8125rem] gap-1.5 rounded-lg',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[0.9375rem] gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg justify-center',
  'icon-sm': 'h-7.5 w-7.5 rounded-md justify-center',
};

/**
 * `loading` disables the button and swaps the leading icon for a spinner, so
 * layout does not jump while a request is in flight.
 *
 * Pass `as={Link}` (plus `to`) to render a router link that looks like a button —
 * the correct element when the action is navigation rather than a command.
 */
export const Button = forwardRef(function Button(
  {
    as: Tag = 'button',
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon: Icon,
    iconRight: IconRight,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref
) {
  const isIconOnly = size === 'icon' || size === 'icon-sm';
  const iconSize = size === 'xs' || size === 'icon-sm' ? 14 : size === 'lg' ? 18 : 16;
  const isNative = Tag === 'button';
  const inert = disabled || loading;

  return (
    <Tag
      ref={ref}
      // `type` only means something on a real button; anchors would reject it.
      type={isNative ? (type ?? 'button') : undefined}
      disabled={isNative ? inert : undefined}
      aria-disabled={!isNative && inert ? true : undefined}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-45',
        inert && !isNative && 'pointer-events-none opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {loading ? (
        <Loader2 size={iconSize} className="animate-spin" />
      ) : Icon ? (
        <Icon size={iconSize} className="shrink-0" />
      ) : null}
      {isIconOnly ? null : children}
      {!isIconOnly && IconRight && !loading ? <IconRight size={iconSize} className="shrink-0" /> : null}
    </Tag>
  );
});

export default Button;
