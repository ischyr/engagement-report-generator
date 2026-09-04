import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from './Button.jsx';

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[min(72rem,calc(100vw-2rem))]',
};

/**
 * Centred dialog rendered in a portal. Escape and backdrop clicks close it,
 * body scroll is locked while open, and focus moves inside on mount.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  className,
  closeOnBackdrop = true,
}) {
  const panelRef = useRef(null);

  // Callers almost always pass an inline arrow, so `onClose` is a new function on
  // every render. Reading it through a ref keeps it out of the effect's
  // dependencies — otherwise the effect below re-ran on each keystroke and stole
  // focus back to the first control in the dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Start the caret in the first field rather than on the close button, which
    // is what a plain "first focusable element" query would pick.
    const panel = panelRef.current;
    const target =
      panel?.querySelector('[data-autofocus]') ??
      panel?.querySelector(
        'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
      ) ??
      panel;
    target?.focus?.({ preventScroll: true });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // Deliberately only `open`: this should run when the dialog opens, not on
    // every re-render while the user is typing in it.
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={closeOnBackdrop ? onClose : undefined}
        className="fixed inset-0 cursor-default bg-black/65 backdrop-blur-sm"
        style={{ animation: 'fade-in 140ms ease-out' }}
      />
      <div
        ref={panelRef}
        // Focus target of last resort when the dialog contains no fields.
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'relative my-auto w-full rounded-card border border-line bg-surface shadow-pop',
          SIZES[size],
          className
        )}
        style={{ animation: 'modal-in 180ms cubic-bezier(.16,1,.3,1)' }}
      >
        {title ? (
          <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg">{title}</h2>
              {description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
              ) : null}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" icon={X} />
          </div>
        ) : null}

        <div className="max-h-[calc(100vh-14rem)] overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes fade-in{from{opacity:0}to{opacity:1}}
        @keyframes modal-in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}
      `}</style>
    </div>,
    document.body
  );
}

/** Confirmation prompt. `tone="danger"` for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading = false,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg-muted">{message}</p>
    </Modal>
  );
}

export default Modal;
