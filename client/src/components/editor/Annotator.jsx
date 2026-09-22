import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Droplets, Eraser, ListOrdered, Square, Type, Undo2 } from 'lucide-react';

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
  /*
   * A numbered marker — the ①②③ that makes a three-screenshot proof of concept readable.
   *
   * The most-missed annotation in this kind of report and the reason a write-up ends up carrying a
   * paragraph explaining what order to look at things in. Click, do not drag: a step marker has a
   * position and no size.
   */
  { id: 'step', label: 'Step', icon: ListOrdered, hint: 'A numbered marker — click where it goes' },
  { id: 'label', label: 'Label', icon: Type, hint: 'A few words on the image itself' },
  /*
   * Blur, which is not redaction and must not be confused with it.
   *
   * For the thing that has to stay recognisable as *a* customer name without being readable as
   * *this* one — the shape of the page, the layout of the table. Anything that must be gone uses
   * redaction, and the difference is stated in the hint and again under the canvas, because a
   * reversible blur over a password would be the worst bug in this file.
   */
  { id: 'blur', label: 'Blur', icon: Droplets, hint: 'Obscure it but keep the shape — not for secrets' },
  { id: 'redact', label: 'Redact', icon: Eraser, hint: 'Cover it — the pixels go, not just the view' },
];

/** Enough contrast on a light screenshot and on a dark terminal alike. */
const INK = '#ff3b5c';
const REDACT_FILL = '#000000';

/**
 * Obscures a region by averaging it into blocks, in place, on the bitmap.
 *
 * **Pixelation rather than a blur filter, and that is the whole design.** `ctx.filter = 'blur()'`
 * is a convolution: the original values are still in there, spread out, and there are published
 * tools that recover readable text from a gaussian-blurred screenshot. Averaging into blocks
 * destroys the information instead — every pixel in a block becomes one number, and no amount of
 * processing brings back what the block contained.
 *
 * It is still not redaction, and the interface says so twice. This is for the thing that has to
 * stay recognisable as *a* customer name without being readable as *this* one. Anything that must
 * be gone — a password, a token, a real address — uses redaction, which fills with black and
 * removes even the shape.
 *
 * Block size scales with the image so a 4K screenshot is obscured as thoroughly as a 800px one.
 */
function blur(ctx, canvas, x, y, width, height, scale) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(canvas.width, Math.ceil(x + width));
  const bottom = Math.min(canvas.height, Math.ceil(y + height));
  if (right <= left || bottom <= top) return;

  const block = Math.max(6, scale * 4);
  const region = ctx.getImageData(left, top, right - left, bottom - top);
  const { data } = region;
  const rowWidth = right - left;

  for (let by = 0; by < bottom - top; by += block) {
    for (let bx = 0; bx < rowWidth; bx += block) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      const maxY = Math.min(by + block, bottom - top);
      const maxX = Math.min(bx + block, rowWidth);
      for (let py = by; py < maxY; py += 1) {
        for (let px = bx; px < maxX; px += 1) {
          const at = (py * rowWidth + px) * 4;
          r += data[at];
          g += data[at + 1];
          b += data[at + 2];
          count += 1;
        }
      }
      if (!count) continue;
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      for (let py = by; py < maxY; py += 1) {
        for (let px = bx; px < maxX; px += 1) {
          const at = (py * rowWidth + px) * 4;
          data[at] = r;
          data[at + 1] = g;
          data[at + 2] = b;
        }
      }
    }
  }
  ctx.putImageData(region, left, top);
}

export default function Annotator({ open, src, onClose, onSave, busy = false }) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const [shapes, setShapes] = useState([]);
  const [tool, setTool] = useState('box');
  const [drawing, setDrawing] = useState(null);
  const [ready, setReady] = useState(false);
  /** Where a label was dropped, while its words are being typed. Null when nothing is pending. */
  const [labelAt, setLabelAt] = useState(null);
  const [labelText, setLabelText] = useState('');

  // Fresh sheet whenever a different screenshot is opened.
  useEffect(() => {
    if (!open) return;
    setShapes([]);
    setDrawing(null);
    setLabelAt(null);
    setLabelText('');
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
    /* Step markers number themselves in the order they were placed, and renumber after an undo. */
    let step = 0;
    for (const shape of [...shapes, drawing].filter(Boolean)) {
      const { x1, y1, x2, y2 } = shape;
      if (shape.tool === 'redact') {
        ctx.fillStyle = REDACT_FILL;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        continue;
      }
      if (shape.tool === 'blur') {
        blur(ctx, canvas, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), scale);
        continue;
      }
      if (shape.tool === 'step') {
        step += 1;
        const radius = scale * 7;
        ctx.beginPath();
        ctx.arc(x1, y1, radius, 0, Math.PI * 2);
        ctx.fillStyle = INK;
        ctx.fill();
        /* A ring in the opposite ink, so the marker survives landing on a red background. */
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, scale / 2);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${radius * 1.3}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(step), x1, y1 + radius * 0.06);
        continue;
      }
      if (shape.tool === 'label') {
        if (!shape.text) continue;
        const size = scale * 8;
        ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const padding = size * 0.35;
        const width = ctx.measureText(shape.text).width;
        /*
         * A filled plate under the words.
         *
         * Text straight onto a screenshot is unreadable about half the time — it lands on a
         * terminal, or a table header, or something the same colour as the ink. The plate costs a
         * rectangle and makes the label legible wherever it is dropped.
         */
        ctx.fillStyle = INK;
        ctx.fillRect(x1 - padding, y1 - padding, width + padding * 2, size + padding * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(shape.text, x1, y1);
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
              /*
               * A step marker is placed, not dragged: it has a position and no size, so the
               * drag test below would throw every one of them away.
               */
              if (drawing.tool === 'step') {
                setShapes((current) => [...current, drawing]);
                setDrawing(null);
                return;
              }
              /*
               * A label is placed too, and then asks for its words.
               *
               * A prompt rather than an editable box on the canvas: the words go into a bitmap and
               * are not editable afterwards by anything, so an in-place editor would be promising
               * something the format cannot keep. Cancelled or empty, no label is added.
               */
              if (drawing.tool === 'label') {
                const spot = drawing;
                setDrawing(null);
                setLabelAt(spot);
                return;
              }
              // A click with no drag is not a shape; it is a click.
              const big = Math.abs(drawing.x2 - drawing.x1) + Math.abs(drawing.y2 - drawing.y1) > 8;
              if (big) setShapes((current) => [...current, drawing]);
              setDrawing(null);
            }}
            className="mx-auto block max-w-full cursor-crosshair touch-none"
          />
        </div>

        {/*
          The words for a label, asked for after it is placed.

          A prompt rather than an editable box on the canvas, because the words are baked into a
          bitmap and nothing can edit them afterwards — an in-place editor would be promising
          something the format cannot keep.
        */}
        {labelAt ? (
          <form
            className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface/60 px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = labelText.trim();
              if (text) setShapes((current) => [...current, { ...labelAt, text }]);
              setLabelAt(null);
              setLabelText('');
            }}
          >
            <input
              autoFocus
              value={labelText}
              onChange={(event) => setLabelText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                setLabelAt(null);
                setLabelText('');
              }}
              maxLength={80}
              placeholder="The payload fires here"
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
            <Button type="submit" size="sm" disabled={!labelText.trim()}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setLabelAt(null);
                setLabelText('');
              }}
            >
              Cancel
            </Button>
          </form>
        ) : null}

        <p className="text-xs leading-relaxed text-fg-subtle">
          Redaction is a filled rectangle drawn into the bitmap before the file is written, so
          nothing readable survives underneath it. That is the difference between this and a black
          box drawn over a PDF, which has leaked more than one report.{' '}
          <strong className="font-medium text-fg-muted">Blur is not redaction.</strong> It averages
          the region into blocks — irreversible, but it keeps the shape, which is the point. Use it
          for something that should stay recognisable as <em>a</em> customer name without being
          readable as <em>this</em> one. For a password or a token, redact.
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
