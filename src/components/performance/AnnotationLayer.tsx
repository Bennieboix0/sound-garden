import { useCallback, useEffect, useRef } from 'react';
import { addStroke, usePageStrokes } from '../../db/annotations';
import type { AnnotationTool, CropInsets, Stroke, StrokeLayer, StrokeRecord } from '../../types';

export interface PenSettings {
  tool: AnnotationTool;
  color: string;
  /** Stroke width as a fraction of the full page width. */
  width: number;
}

/** Ignore points closer together than this (in CSS px) to keep strokes light. */
const MIN_POINT_GAP = 1.6;

/**
 * Draws a page's markings over the rendered score, and captures new ones.
 *
 * Strokes are stored in *uncropped* page space, so re-cropping a score or
 * switching between fit-width and fit-page moves the markings with the music
 * rather than sliding them off it. The original PDF is never modified.
 */
export default function AnnotationLayer({
  contentHash,
  pageNumber,
  crop,
  editing,
  pen,
  layer = 'personal',
  visibleEnsembles,
  onStrokeAdded,
}: {
  /** Markings are keyed to the document's content, not to a local row id. */
  contentHash: string;
  pageNumber: number;
  crop: CropInsets;
  editing: boolean;
  pen: PenSettings;
  layer?: StrokeLayer;
  /** Which published layers to show. Undefined means all of them. */
  visibleEnsembles?: Set<string>;
  onStrokeAdded?: (pageNumber: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = usePageStrokes(contentHash, pageNumber, visibleEnsembles);
  const live = useRef<number[] | null>(null);
  /** Set once a stylus is seen, after which touch input is treated as palm. */
  const penSeen = useRef(false);

  const visibleWidth = Math.max(0.02, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.02, 1 - crop.top - crop.bottom);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // A stroke width given as a fraction of the *page* stays visually constant
    // relative to the music however the page is cropped or scaled.
    const pageWidthPx = width / visibleWidth;

    const trace = (points: number[]) => {
      ctx.beginPath();
      for (let i = 0; i < points.length; i += 2) {
        const x = ((points[i] - crop.left) / visibleWidth) * width;
        const y = ((points[i + 1] - crop.top) / visibleHeight) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (points.length === 2) {
        // A single tap should still leave a dot.
        ctx.lineTo(
          ((points[0] - crop.left) / visibleWidth) * width + 0.01,
          ((points[1] - crop.top) / visibleHeight) * height,
        );
      }
    };

    const drawStroke = (stroke: Stroke, published = false) => {
      const points = stroke.points;
      if (points.length < 2) return;
      const lineWidth = Math.max(1, stroke.width * pageWidthPx);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (published && stroke.tool !== 'highlighter') {
        // A published marking gets a pale keyline underneath it. It reads
        // instantly as "not mine" from a metre away, and unlike dimming or
        // dashing it costs nothing in legibility — which matters, because
        // these are the markings the director actually wants followed.
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = lineWidth + Math.max(2, lineWidth * 0.9);
        trace(points);
        ctx.stroke();
      }

      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = lineWidth;
      if (stroke.tool === 'highlighter') {
        // Multiply keeps the notes legible through the wash of colour.
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = published ? 0.3 : 0.42;
      }
      trace(points);
      ctx.stroke();
      ctx.restore();
    };

    for (const stroke of strokes) {
      drawStroke(stroke, Boolean((stroke as StrokeRecord).ensembleId));
    }
    if (live.current && live.current.length >= 2) {
      drawStroke({ ...pen, points: live.current });
    }
  }, [strokes, crop.left, crop.top, visibleWidth, visibleHeight, pen]);

  // Match the backing store to the element's real size, then repaint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      paint();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  useEffect(paint, [paint]);

  const toPageSpace = (event: React.PointerEvent): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return [
      crop.left + ((event.clientX - rect.left) / rect.width) * visibleWidth,
      crop.top + ((event.clientY - rect.top) / rect.height) * visibleHeight,
    ];
  };

  const lastClient = useRef<[number, number] | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (!editing) return;
    if (event.pointerType === 'pen') penSeen.current = true;
    // Once a stylus has been used, treat fingers as palm and ignore them.
    if (penSeen.current && event.pointerType === 'touch') return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const point = toPageSpace(event);
    if (!point) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    live.current = [point[0], point[1]];
    lastClient.current = [event.clientX, event.clientY];
    paint();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!editing || !live.current) return;
    if (penSeen.current && event.pointerType === 'touch') return;
    const previous = lastClient.current;
    if (previous) {
      const moved = Math.hypot(event.clientX - previous[0], event.clientY - previous[1]);
      if (moved < MIN_POINT_GAP) return;
    }
    const point = toPageSpace(event);
    if (!point) return;
    event.preventDefault();
    live.current.push(point[0], point[1]);
    lastClient.current = [event.clientX, event.clientY];
    paint();
  };

  const finish = (event: React.PointerEvent) => {
    if (!editing) return;
    const points = live.current;
    live.current = null;
    lastClient.current = null;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    if (!points || points.length < 2) {
      paint();
      return;
    }
    void addStroke(contentHash, pageNumber, { ...pen, points }, { layer }).then(() =>
      onStrokeAdded?.(pageNumber),
    );
    paint();
  };

  return (
    <canvas
      ref={canvasRef}
      aria-hidden={!editing}
      className={
        'absolute inset-0 h-full w-full ' +
        (editing ? 'cursor-crosshair touch-none' : 'pointer-events-none')
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
