import { forwardRef, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const CONTROL =
  'w-full rounded-lg bg-canvas/60 px-3 text-sm text-fg ring-1 ring-line transition ' +
  'placeholder:text-fg-subtle hover:ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Label + control + help/error wrapper. Pass `label` to get the association
 * wired automatically; the error message replaces the hint when present.
 */
export function Field({ label, hint, error, required, htmlFor, className, children, actions }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label || actions ? (
        <div className="flex items-baseline justify-between gap-2">
          {label ? (
            <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
              {label}
              {required ? <span className="ml-0.5 text-crit">*</span> : null}
            </label>
          ) : (
            <span />
          )}
          {actions}
        </div>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-crit">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef(function Input(
  // `actions` is pulled out and handed to Field like the rest: Field has always rendered a
  // control beside the label, and left in `...props` it would land on the <input> instead as
  // an attribute the DOM does not know.
  { label, hint, error, required, className, wrapperClassName, id, actions, ...props },
  ref
) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      actions={actions}
      htmlFor={inputId}
      className={wrapperClassName}
    >
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'h-9.5', error && 'ring-crit/60 focus:ring-crit', className)}
        {...props}
      />
    </Field>
  );
});

export const Textarea = forwardRef(function Textarea(
  { label, hint, error, required, className, wrapperClassName, id, rows = 4, ...props },
  ref
) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      htmlFor={inputId}
      className={wrapperClassName}
    >
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'resize-y py-2 leading-relaxed', error && 'ring-crit/60', className)}
        {...props}
      />
    </Field>
  );
});

export const Select = forwardRef(function Select(
  {
    label,
    hint,
    error,
    required,
    className,
    wrapperClassName,
    id,
    options = [],
    placeholder,
    children,
    ...props
  },
  ref
) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      htmlFor={inputId}
      className={wrapperClassName}
    >
      <div className="relative">
        <select
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cn(
            CONTROL,
            'h-9.5 cursor-pointer appearance-none pr-9',
            error && 'ring-crit/60',
            className
          )}
          {...props}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((option) => {
            const value = typeof option === 'string' ? option : option.value;
            const text = typeof option === 'string' ? option : option.label;
            return (
              <option key={value} value={value}>
                {text}
              </option>
            );
          })}
          {children}
        </select>
        <ChevronDown
          size={15}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
      </div>
    </Field>
  );
});

/**
 * Switch with an optional label and hint.
 *
 * The knob is a flex item rather than an absolutely-positioned one. Absolute
 * positioning without an explicit `left` falls back to the element's static
 * position, and browsers centre `<button>` content by default — so the knob
 * started 10px in and the "on" transform pushed it clear of the track and over
 * the label. As a flex item it always starts at the track's left edge, and
 * `items-center` handles the vertical centring that `top` used to.
 *
 * The track is 36px, the knob 16px, and the travel 18px, leaving an even 2px
 * inset at both ends.
 */
export function Toggle({ checked, onChange, label, hint, disabled, id }) {
  const generated = useId();
  const inputId = id ?? generated;
  const on = Boolean(checked);

  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        id={inputId}
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange?.(!on)}
        className={cn(
          // h-5 matches the label's line-height, so tops align without a nudge.
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full',
          'transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
          on ? 'bg-brand-600 hover:bg-brand-500' : 'bg-line hover:bg-line/80'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none size-4 rounded-full bg-white shadow-sm',
            'transition-transform duration-200 ease-out',
            on ? 'translate-x-4.5' : 'translate-x-0.5'
          )}
        />
      </button>

      {label || hint ? (
        <div className="min-w-0 flex-1">
          <label
            htmlFor={inputId}
            className={cn(
              'block select-none text-sm leading-5 text-fg',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            )}
          >
            {label}
          </label>
          {hint ? <p className="mt-1 text-xs leading-relaxed text-fg-subtle">{hint}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, id }) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 text-sm text-fg',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className="size-4 cursor-pointer rounded border-line bg-canvas accent-brand-500"
      />
      {label}
    </label>
  );
}

export default Field;
