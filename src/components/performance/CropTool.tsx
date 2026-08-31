import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { db } from '../../db/db';
import { detectCrop } from '../../pdf/analyze';
import { openScoreDocument } from '../../pdf/pdfjs';
import type { CropInsets, Score } from '../../types';
import { NO_CROP } from '../../types';
import { Button, Spinner, cx } from '../ui/controls';

type Edge = 'left' | 'top' | 'right' | 'bottom';

/** Never let the visible window shrink below this fraction of the page. */
const MIN_WINDOW = 0.2;

function clampCrop(crop: CropInsets): CropInsets {
  const left = Math.max(0, Math.min(crop.left, 1 - MIN_WINDOW - crop.right));
  const right = Math.max(0, Math.min(crop.right, 1 - MIN_WINDOW - left));
  const top = Math.max(0, Math.min(crop.top, 1 - MIN_WINDOW - crop.bottom));
  const bottom = Math.max(0, Math.min(crop.bottom, 1 - MIN_WINDOW - top));
  return { left, top, right, bottom };
}

/**
 * Trims the white border off a page.
 *
 * Scanned scores routinely waste a third of the screen on margin, which on a
 * music stand is the difference between a readable staff and a squint. The
 * crop is stored per score and applied to every page.
 */
export default function CropTool({
  score,
  pageNumber,
  onClose,
}: {
  score: Score;
  pageNumber: number;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<CropInsets>(score.crop ?? NO_CROP);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'loading' | 'detecting' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<Edge | null>(null);

  // Render the page *uncropped*, so the handles can be dragged back outwards.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const doc = await openScoreDocument(score.id);
        const page = await doc.getPage(Math.min(pageNumber, doc.numPages));
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(900 / base.width, 1200 / base.height);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
        if (cancelled) return;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
        setBusy(null);
      } catch (err) {
        if (cancelled) return;
        console.error('[sound-garden] crop preview failed', err);
        setError('Could not render this page.');
        setBusy(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [score.id, pageNumber]);

  const applyPointer = useCallback((edge: Edge, clientX: number, clientY: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;

    setCrop((current) => {
      const next = { ...current };
      if (edge === 'left') next.left = fx;
      if (edge === 'right') next.right = 1 - fx;
      if (edge === 'top') next.top = fy;
      if (edge === 'bottom') next.bottom = 1 - fy;
      return clampCrop(next);
    });
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      event.preventDefault();
      applyPointer(dragging.current, event.clientX, event.clientY);
    };
    const onUp = () => {
      dragging.current = null;
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [applyPointer]);

  const autoDetect = async () => {
    setBusy('detecting');
    try {
      const doc = await openScoreDocument(score.id);
      setCrop(clampCrop(await detectCrop(doc)));
    } catch (err) {
      console.error('[sound-garden] auto crop failed', err);
      setError('Could not detect the margins.');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    await db.scores.update(score.id, { crop: clampCrop(crop) });
    onClose();
  };

  const percent = (n: number) => `${(n * 100).toFixed(1)}%`;

  // Built with a switch rather than a computed key so the result is a plain,
  // properly typed CSSProperties.
  const handleStyle = (edge: Edge): CSSProperties => {
    const inset = `calc(${percent(crop[edge])} - 1.375rem)`;
    switch (edge) {
      case 'left':
        return { top: percent(crop.top), bottom: percent(crop.bottom), left: inset };
      case 'right':
        return { top: percent(crop.top), bottom: percent(crop.bottom), right: inset };
      case 'top':
        return { left: percent(crop.left), right: percent(crop.right), top: inset };
      case 'bottom':
        return { left: percent(crop.left), right: percent(crop.right), bottom: inset };
    }
  };

  const nudge = (edge: Edge, delta: number) =>
    setCrop((current) => clampCrop({ ...current, [edge]: current[edge] + delta }));
  const trimmed = Math.round(
    (1 - (1 - crop.left - crop.right) * (1 - crop.top - crop.bottom)) * 100,
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950 text-ink-100">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b-2 border-ink-700 px-4 py-3 pad-safe-top">
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-xl font-bold">Trim margins</h2>
          <p className="truncate text-base text-ink-300">
            {score.title} · page {pageNumber}
          </p>
        </div>
        <Button size="lg" onClick={() => void autoDetect()} disabled={busy !== null}>
          {busy === 'detecting' ? 'Detecting…' : 'Auto'}
        </Button>
        <Button size="lg" onClick={() => setCrop(NO_CROP)} disabled={busy !== null}>
          Reset
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <p className="text-xl font-semibold text-amber-300">{error}</p>
        ) : preview === null ? (
          <Spinner className="h-10 w-10 text-moss-400" />
        ) : (
          <div ref={frameRef} className="relative max-h-full">
            <img
              src={preview}
              alt={`Page ${pageNumber} of ${score.title}`}
              className="block max-h-[70vh] w-auto select-none"
              draggable={false}
            />

            {/* Shade everything that the crop throws away. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 bg-ink-950/70"
              style={{ height: percent(crop.top) }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 bg-ink-950/70"
              style={{ height: percent(crop.bottom) }}
            />
            <div
              className="pointer-events-none absolute left-0 bg-ink-950/70"
              style={{ width: percent(crop.left), top: percent(crop.top), bottom: percent(crop.bottom) }}
            />
            <div
              className="pointer-events-none absolute right-0 bg-ink-950/70"
              style={{ width: percent(crop.right), top: percent(crop.top), bottom: percent(crop.bottom) }}
            />

            {/* The kept region, outlined. */}
            <div
              className="pointer-events-none absolute border-2 border-moss-400"
              style={{
                left: percent(crop.left),
                right: percent(crop.right),
                top: percent(crop.top),
                bottom: percent(crop.bottom),
              }}
            />

            {(['left', 'right', 'top', 'bottom'] as Edge[]).map((edge) => {
              const vertical = edge === 'left' || edge === 'right';
              return (
                <div
                  key={edge}
                  role="slider"
                  tabIndex={0}
                  aria-label={`${edge} margin`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(crop[edge] * 100)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    dragging.current = edge;
                    applyPointer(edge, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                        ? -0.005
                        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 0.005
                          : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    nudge(edge, delta);
                  }}
                  // A 44px grab strip centred on each edge of the kept region.
                  className={cx(
                    'absolute touch-none',
                    vertical ? 'w-11 cursor-ew-resize' : 'h-11 cursor-ns-resize',
                  )}
                  style={handleStyle(edge)}
                >
                  <span
                    className={cx(
                      'absolute rounded-full bg-moss-400',
                      vertical
                        ? 'inset-y-0 left-1/2 w-1.5 -translate-x-1/2'
                        : 'inset-x-0 top-1/2 h-1.5 -translate-y-1/2',
                    )}
                  />
                  <span
                    className={cx(
                      'absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full',
                      'border-4 border-ink-950 bg-moss-400 shadow-lg',
                    )}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t-2 border-ink-700 px-4 py-3 pad-safe-bottom">
        <p className="mr-auto text-base font-semibold text-ink-200">
          {trimmed > 0 ? `Trimming ${trimmed}% of the page` : 'Nothing trimmed'}
        </p>
        <Button size="xl" onClick={onClose}>
          Cancel
        </Button>
        <Button size="xl" variant="primary" onClick={() => void save()}>
          Save crop
        </Button>
      </footer>
    </div>
  );
}
