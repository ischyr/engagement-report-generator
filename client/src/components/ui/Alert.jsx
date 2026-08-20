import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const TONES = {
  error: {
    icon: XCircle,
    box: 'border-crit/30 bg-crit/[0.07]',
    icon_: 'text-crit',
    title: 'text-crit',
  },
  warning: {
    icon: AlertTriangle,
    box: 'border-med/30 bg-med/[0.07]',
    icon_: 'text-med',
    title: 'text-med',
  },
  success: {
    icon: CheckCircle2,
    box: 'border-low/30 bg-low/[0.07]',
    icon_: 'text-low',
    title: 'text-low',
  },
  info: {
    icon: Info,
    box: 'border-info/30 bg-info/[0.07]',
    icon_: 'text-info',
    title: 'text-info',
  },
};

/**
 * Inline message block for form-level and page-level feedback — the kind of
 * error that belongs next to the thing that failed rather than in a toast that
 * disappears.
 *
 * `role="alert"` so screen readers announce it the moment it appears.
 */
export function Alert({ tone = 'error', title, children, icon, className, action }) {
  const meta = TONES[tone] ?? TONES.info;
  const Icon = icon ?? meta.icon;

  return (
    <div
      role="alert"
      className={cn('flex items-start gap-3 rounded-xl border px-3.5 py-3', meta.box, className)}
      style={{ animation: 'alert-in 200ms cubic-bezier(.16,1,.3,1)' }}
    >
      <Icon size={17} className={cn('mt-0.5 shrink-0', meta.icon_)} />
      <div className="min-w-0 flex-1">
        {title ? <p className={cn('text-sm font-medium', meta.title)}>{title}</p> : null}
        {children ? (
          <div className={cn('text-xs leading-relaxed text-fg-muted', title && 'mt-1')}>
            {children}
          </div>
        ) : null}
        {action ? <div className="mt-2.5">{action}</div> : null}
      </div>
      <style>{`@keyframes alert-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

export default Alert;
