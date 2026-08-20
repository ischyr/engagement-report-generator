import { cn, SEVERITY_META, AUDIT_STATE_META } from '../../lib/utils.js';

const TONES = {
  neutral: 'bg-white/6 text-fg-muted ring-line',
  brand: 'bg-brand-500/12 text-brand-300 ring-brand-500/25',
  success: 'bg-low/12 text-low ring-low/25',
  warning: 'bg-med/12 text-med ring-med/25',
  danger: 'bg-crit/12 text-crit ring-crit/25',
  info: 'bg-info/12 text-info ring-info/25',
};

export function Badge({ tone = 'neutral', className, children, icon: Icon, title }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset',
        TONES[tone] ?? TONES.neutral,
        className
      )}
    >
      {Icon ? <Icon size={11} /> : null}
      {children}
    </span>
  );
}

/** Severity pill with the score attached — the shape used all over the app. */
export function SeverityBadge({ severity, score, className, showScore = true }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.None;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset',
        meta.bg,
        meta.text,
        meta.ring,
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
      {showScore && score !== null && score !== undefined && score !== '' ? (
        <span className="font-mono text-[0.625rem] opacity-80">{Number(score).toFixed(1)}</span>
      ) : null}
    </span>
  );
}

export function StateBadge({ state, className }) {
  const meta = AUDIT_STATE_META[state] ?? AUDIT_STATE_META.EDIT;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium',
        meta.bg,
        meta.text,
        className
      )}
    >
      {meta.label}
    </span>
  );
}

export default Badge;
