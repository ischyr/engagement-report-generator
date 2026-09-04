import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from 'lucide-react';

import { cn } from '../../lib/utils.js';

/**
 * A screenshot, full size, for looking at.
 *
 * Evidence is rendered inline at the width of a text column, which for a 1920-wide terminal
 * capture means unreadable. The only way to actually *read* a screenshot was to generate the
 * report and open it in Word — on the one kind of content this whole app exists to carry.
 *
 * Deliberately not a gallery library: it does the four things a tester needs and nothing else.
 * Zoom is to the pointer rather than to the centre, because the thing being examined is a line of
 * output somewhere in the corner, not the middle of the picture.
 */
export default function Lightbox({ images = [], index = 0, onClose, onIndex }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(null);
  const frame = useRef(null);

  const current = images[index];
  const many = images.length > 1;

  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // A new image starts fitted: keeping the previous zoom would open the next screenshot
  // scrolled to a corner of something else.
  useEffect(reset, [index, reset]);

  const step = useCallback(
    (delta) => {
      if (!many) return;
      onIndex?.((index + delta + images.length) % images.length);
    },
    [index, images.length, many, onIndex]
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === '+' || event.key === '=') setZoom((z) => Math.min(8, z * 1.4));
      else if (event.key === '-') setZoom((z) => Math.max(1, z / 1.4));
      else if (event.key === '0') reset();
    };
    document.addEventListener('keydown', onKeyDown);
    // The page behind must not scroll while a full-screen overlay is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, step, reset]);

  if (!current) return null;

  /**
   * Zoom towards the pointer.
   *
   * The offset is corrected so the pixel under the cursor stays under the cursor — without it,
   * zooming into the bottom-right of a wide capture walks the interesting part off the screen and
   * the reader has to drag it back every time.
   */
  const zoomAt = (factor, clientX, clientY) => {
    const next = Math.min(8, Math.max(1, zoom * factor));
    if (next === zoom) return;

    const box = frame.current?.getBoundingClientRect();
    setZoom(next);
    if (!box) return;

    /*
     * Both pieces of state are set from the values already in scope rather than from inside an
     * updater. A `setOffset` nested in a `setZoom` updater runs twice under StrictMode and is not
     * something React promises to honour — which showed up as a zoom that appeared to do nothing.
     */
    const px = (clientX ?? box.left + box.width / 2) - box.left - box.width / 2;
    const py = (clientY ?? box.top + box.height / 2) - box.top - box.height / 2;
    const ratio = next / zoom;
    setOffset(
      next === 1
        ? { x: 0, y: 0 }
        : { x: (offset.x - px) * ratio + px, y: (offset.y - py) * ratio + py }
    );
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.caption || current.alt || 'Screenshot'}
      className="fixed inset-0 z-200 flex flex-col bg-canvas/95 backdrop-blur-sm"
      style={{ animation: 'notif-fade 120ms ease-out' }}
    >
      {/* The bar carries the count and the controls; the caption sits under the image, where a
          caption belongs. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="font-mono text-[0.6875rem] tabular-nums text-fg-subtle">
          {many ? `${index + 1} / ${images.length}` : '1 image'}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {current.caption || current.alt || ''}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomAt(1 / 1.4)}
            disabled={zoom <= 1}
            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg disabled:opacity-30"
          >
            <Minus size={14} />
          </button>
          <span className="w-10 text-center font-mono text-[0.625rem] tabular-nums text-fg-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomAt(1.4)}
            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Fit to the window"
            title="Fit (0)"
            onClick={reset}
            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
          >
            <Maximize2 size={14} />
          </button>
          <a
            href={current.src}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-2 py-1.5 text-[0.625rem] text-fg-subtle transition hover:bg-white/5 hover:text-fg"
          >
            Open
          </a>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg"
          >
            <X size={16} />
          </button>
        </span>
      </header>

      <div
        ref={frame}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden',
          zoom > 1 ? 'cursor-grab' : 'cursor-zoom-in'
        )}
        onWheel={(event) => {
          event.preventDefault();
          zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
        }}
        onDoubleClick={(event) => (zoom > 1 ? reset() : zoomAt(2.5, event.clientX, event.clientY))}
        onPointerDown={(event) => {
          if (zoom <= 1) return;
          dragging.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          setOffset({ x: event.clientX - dragging.current.x, y: event.clientY - dragging.current.y });
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        /* Clicking the empty space around the image closes it, which is what everybody tries. */
        onClick={(event) => {
          if (event.target === event.currentTarget && zoom === 1) onClose?.();
        }}
      >
        <img
          src={current.src}
          alt={current.alt || current.caption || 'Screenshot'}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: 'center',
            // No transition while dragging, or the image lags behind the pointer.
            transition: dragging.current ? 'none' : 'transform 90ms ease-out',
          }}
        />

        {many ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => step(-1)}
              className="absolute left-2 grid size-9 place-items-center rounded-full bg-overlay/80 text-fg-muted ring-1 ring-line transition hover:text-fg"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => step(1)}
              className="absolute right-2 grid size-9 place-items-center rounded-full bg-overlay/80 text-fg-muted ring-1 ring-line transition hover:text-fg"
            >
              <ChevronRight size={18} />
            </button>
          </>
        ) : null}
      </div>

      {/* Thumbnails, so "the one after the login page" is findable without cycling. */}
      {many ? (
        <footer className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-line-soft px-3 py-2">
          {images.map((image, at) => (
            <button
              key={`${image.src}-${at}`}
              type="button"
              onClick={() => onIndex?.(at)}
              title={image.caption || image.alt || `Image ${at + 1}`}
              className={cn(
                'h-12 shrink-0 overflow-hidden rounded ring-1 transition',
                at === index ? 'ring-brand-400' : 'ring-line-soft opacity-60 hover:opacity-100'
              )}
            >
              <img src={image.src} alt="" className="h-full w-auto object-cover" />
            </button>
          ))}
        </footer>
      ) : (
        <footer className="shrink-0 border-t border-line-soft px-3 py-2 text-center text-[0.625rem] text-fg-subtle">
          Scroll to zoom · double-click to zoom in · drag to move · Esc to close
        </footer>
      )}
    </div>,
    document.body
  );
}
