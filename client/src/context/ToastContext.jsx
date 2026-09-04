import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { ApiError } from '../lib/api.js';

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TONE = {
  success: 'text-low border-low/30',
  error: 'text-crit border-crit/30',
  warning: 'text-med border-med/30',
  info: 'text-info border-info/30',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast) => {
      const id = nextId.current++;
      const entry = { id, variant: 'info', ...toast };
      setToasts((current) => [...current, entry]);
      // Errors stay until dismissed; they usually need reading.
      const ttl = entry.duration ?? (entry.variant === 'error' ? 9000 : 4500);
      if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss]
  );

  const toast = useMemo(
    () => ({
      success: (title, description, options) =>
        push({ variant: 'success', title, description, ...options }),
      error: (title, description) => push({ variant: 'error', title, description }),
      warning: (title, description) => push({ variant: 'warning', title, description }),
      info: (title, description) => push({ variant: 'info', title, description }),
      /**
       * A toast with one button on it — an undo, in practice.
       *
       * Longer-lived than a plain one: an action nobody can reach in time is worse
       * than no action, because it says the way back existed and was missed.
       */
      withAction: (title, description, action, duration = 12000) =>
        push({ variant: 'success', title, description, action, duration }),
      /** Surfaces an ApiError with its field-level details attached. */
      fromError: (error, fallback = 'Something went wrong') => {
        if (error?.name === 'AbortError') return null;
        const description = error instanceof ApiError ? error.detailText : '';
        return push({
          variant: 'error',
          title: error?.message || fallback,
          description: description || undefined,
        });
      },
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-100 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((entry) => {
          const Icon = ICONS[entry.variant] ?? Info;
          return (
            <div
              key={entry.id}
              role="status"
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-overlay/95 p-3 shadow-pop backdrop-blur',
                'animate-in',
                TONE[entry.variant]
              )}
              style={{ animation: 'toast-in 180ms ease-out' }}
            >
              <Icon size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{entry.title}</p>
                {entry.description ? (
                  <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-fg-muted">
                    {entry.description}
                  </p>
                ) : null}
                {/* One action, for the undo that has to be within reach of the thing
                    it undoes rather than somewhere else on the page. */}
                {entry.action ? (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(entry.id);
                      entry.action.onClick();
                    }}
                    className="mt-1.5 rounded-md bg-white/8 px-2 py-1 text-[0.6875rem] font-semibold text-fg transition hover:bg-white/12"
                  >
                    {entry.action.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(entry.id)}
                aria-label="Dismiss"
                className="rounded p-0.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes toast-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}`}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

export default ToastContext;
