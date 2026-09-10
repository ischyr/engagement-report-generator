import { useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Undo2 } from 'lucide-react';

import { Button } from '../ui/Button.jsx';

/**
 * A place to draw a signature with a mouse, a finger or a pen.
 *
 * Pointer events rather than mouse or touch ones: one code path covers all three, and a stylus
 * reports pressure and tilt through the same API — which matters here, because a signature drawn
 * with a pen is the case this exists for.
 *
 * The canvas is sized in device pixels and scaled down by CSS, so a line drawn on a 2× display is
 * not the blurry half-resolution smear a naïve canvas gives you. Strokes are kept as points and
 * redrawn on demand, which is what makes undo possible at all — a canvas remembers pixels, not
 * what put them there.
 */
export default function SignaturePad({ onChange, disabled, height = 180 }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  /** Completed strokes, each an array of points. Undo pops one. */
  const strokes = useRef([]);
  const current = useRef(null);
  const [hasInk, setHasInk] = useState(false);

  /** Redraws everything from the strokes, at the current size. */
  const repaint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(ratio, ratio);

    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    // Ink, not theme: this image ends up on a white page in a Word document, where a
    // light-on-dark signature would be invisible.
    context.strokeStyle = '#111827';

    for (const stroke of strokes.current) {
      if (stroke.length < 2) {
        // A single tap is a dot, and a dot is a legitimate part of a signature.
        const [point] = stroke;
        context.beginPath();
        context.arc(point.x, point.y, 1.2, 0, Math.PI * 2);
        context.fillStyle = '#111827';
        context.fill();
        continue;
      }
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  };

  /** Matches the backing store to the box, then repaints — resizing a canvas clears it. */
  const resize = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(wrap.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = '100%';
    canvas.style.height = `${height}px`;
    repaint();
  };

  useEffect(() => {
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  const pointFrom = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event) => {
    if (disabled) return;
    // Keeps the pointer even if it leaves the canvas mid-stroke, so a line does not stop dead
    // at the edge when somebody signs with a flourish.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    current.current = [pointFrom(event)];
    strokes.current.push(current.current);
    setHasInk(true);
  };

  const move = (event) => {
    if (!current.current) return;
    current.current.push(pointFrom(event));
    repaint();
  };

  const end = () => {
    if (!current.current) return;
    current.current = null;
    emit();
  };

  /** Hands the drawing up as a PNG data URI, or null when it is empty. */
  const emit = () => {
    const canvas = canvasRef.current;
    if (!canvas || strokes.current.length === 0) {
      onChange?.(null);
      return;
    }
    onChange?.(canvas.toDataURL('image/png'));
  };

  const clear = () => {
    strokes.current = [];
    current.current = null;
    setHasInk(false);
    repaint();
    onChange?.(null);
  };

  const undo = () => {
    strokes.current.pop();
    setHasInk(strokes.current.length > 0);
    repaint();
    emit();
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={wrapRef}
        className="relative rounded-lg border border-line-soft bg-white"
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
          // Otherwise a finger drag scrolls the page instead of drawing on a tablet.
          className="absolute inset-0 touch-none rounded-lg"
          style={{ cursor: disabled ? 'not-allowed' : 'crosshair' }}
        />
        {!hasInk ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-neutral-400">
            <PenLine size={14} />
            Sign here — mouse, finger or pen
          </span>
        ) : null}
        {/* A rule to sign on, like a paper form. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-neutral-300"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={Undo2} disabled={disabled || !hasInk} onClick={undo}>
          Undo
        </Button>
        <Button variant="ghost" size="sm" icon={Eraser} disabled={disabled || !hasInk} onClick={clear}>
          Clear
        </Button>
        <span className="ml-auto text-[0.625rem] text-fg-subtle">
          Drawn in black on white, because it is printed onto a page.
        </span>
      </div>
    </div>
  );
}
