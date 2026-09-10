import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Eraser, Square, Type, Undo2 } from 'lucide-react';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';

/**
 * Marking up a screenshot: boxes, arrows, and redaction that actually redacts.
 *
 * Two things make this worth building rather than telling people to use Paint. The first is that the
 * round trip through a desktop editor loses the evidence's provenance — a file on somebody's
 * machine, re-uploaded, is no longer obviously the screenshot that was taken. The second is
 * redaction: a black rectangle drawn in a PDF viewer or a comment layer leaves the pixels
 * underneath, and reports have leaked on exactly that. Here the shapes are drawn onto the bitmap and
 * a new PNG is exported, so what is under a redaction is gone before the file exists.
 *
 * The original is never touched. Stored images are deduplicated by hash and shared across
 * engagements — the same screenshot in two reports is one object — so editing bytes in place would
 * alter another client's report from inside this one. The caller is handed a new file and decides
 * what to do with it: the finding editor repoints this engagement's references at it, the evidence
 * bin replaces the capture.
 *
 * @param {{open: boolean, src: string, onClose: () => void, onSave: (file: File) => Promise<void>|void, busy?: boolean}} props
 */

const TOOLS = [
  { id: 'box', label: 'Box', icon: Square, hint: 'Draw attention to a region' },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight, hint: 'Point at something' },
  { id: 'redact', label: 'Redact', icon: Eraser, hint: 'Cover it — the pixels go, not just the view' },
];

/** Enough contrast on a light screenshot and on a dark terminal alike. */
const INK = '#ff3b5c';
const REDACT_FILL = '#000000';

export default function Annotator({ open, src, onClose, onSave, busy = false }) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const [shapes, setShapes] = useState([]);
  const [tool, setTool] = useState('box');
  const [drawing, setDrawing] = useState(null);
  const [ready, setReady] = useState(false);

  // Fresh sheet whenever a different screenshot is opened.
  useEffect(() => {
    if (!open) return;
    setShapes([]);
    setDrawing(null);
    setReady(false);
  }, [open, src]);

  /** Draws the image, then every shape over it, at natural resolution. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !image.naturalWidth) return;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    const scale = Math.max(2, Math.round(image.naturalWidth / 500));
    for (const shape of [...shapes, drawing].filter(Boolean)) {
      const { x1, y1, x2, y2 } = shape;
      if (shape.tool === 'redact') {
        ctx.fillStyle = REDACT_FILL;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        continue;
      }
      ctx.strokeStyle = INK;
      ctx.fillStyle = INK;
      ctx.lineWidth = scale;
      ctx.lineJoin = 'round';
      if (shape.tool === 'box') {
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        continue;
      }
      // An arrow: the shaft, then a filled head sized off the image rather than the arrow, so a
      // short arrow on a big screenshot is still visible.
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = scale * 6;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
  }, [shapes, drawing]);

  useEffect(() => {
    if (ready) paint();
  }, [ready, paint]);

  /** Canvas coordinates from a pointer event, whatever the on-screen size is. */
  const at = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    await onSave(new File([blob], 'annotated.png', { type: 'image/png' }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Annotate this screenshot"
      description="Boxes and arrows point; redaction removes. The original is left as it is — this saves a new image."
      size="xl"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {TOOLS.map((entry) => {
            const Icon = entry.icon;
            return (
              <Button
                key={entry.id}
                variant={tool === entry.id ? 'secondary' : 'ghost'}
                size="sm"
                icon={Icon}
                title={entry.hint}
                onClick={() => setTool(entry.id)}
              >
                {entry.label}
              </Button>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            icon={Undo2}
            disabled={!shapes.length}
            onClick={() => setShapes((current) => current.slice(0, -1))}
          >
            Undo
          </Button>
          <span className="ml-auto text-xs text-fg-subtle">
            {shapes.length
              ? `${shapes.length} mark${shapes.length === 1 ? '' : 's'}`
              : 'Drag on the image'}
          </span>
        </div>

        <div className="max-h-[60vh] overflow-auto rounded-xl bg-black/40 p-2 ring-1 ring-line">
          {/* The image itself is never shown: it is the source the canvas paints from. */}
          <img
            ref={imageRef}
            src={src}
            alt=""
            className="hidden"
            onLoad={() => setReady(true)}
          />
          <canvas
            ref={canvasRef}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = at(event);
              setDrawing({ tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y });
            }}
            onPointerMove={(event) => {
              if (!drawing) return;
              const point = at(event);
              setDrawing((current) => ({ ...current, x2: point.x, y2: point.y }));
            }}
            onPointerUp={() => {
              if (!drawing) return;
              // A click with no drag is not a shape; it is a click.
              const big = Math.abs(drawing.x2 - drawing.x1) + Math.abs(drawing.y2 - drawing.y1) > 8;
              if (big) setShapes((current) => [...current, drawing]);
              setDrawing(null);
            }}
            className="mx-auto block max-w-full cursor-crosshair touch-none"
          />
        </div>

        <p className="text-xs leading-relaxed text-fg-subtle">
          Redaction is a filled rectangle drawn into the bitmap before the file is written, so
          nothing readable survives underneath it. That is the difference between this and a black
          box drawn over a PDF, which has leaked more than one report.
        </p>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!shapes.length} onClick={save}>
            Save as a new screenshot
          </Button>
        </div>
      </div>
    </Modal>
  );
}
