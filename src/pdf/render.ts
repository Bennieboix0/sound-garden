import type { CropInsets, FitMode } from '../types';
import { openScoreDocument, type PDFPageProxy } from './pdfjs';

/**
 * Hard ceiling on the backing store of a rendered page. A portrait A4 at 5M
 * pixels is comfortably sharper than any display this runs on, and keeps the
 * cache from exhausting memory on a phone.
 */
const MAX_PIXELS = 5_000_000;

/**
 * Enough for prev + current + next + the next score's first page, doubled for
 * two-page spreads. Spread pages are half-width, so the memory cost of the
 * larger limit lands mostly in the mode that has the smaller canvases.
 */
const CACHE_LIMIT = 10;

export interface PageGeometry {
  /** Page box in PDF points, with rotation applied. */
  baseWidth: number;
  baseHeight: number;
  /** The visible region after the crop insets. */
  cropWidth: number;
  cropHeight: number;
}

export function pageGeometry(page: PDFPageProxy, crop: CropInsets): PageGeometry {
  const base = page.getViewport({ scale: 1 });
  const horizontal = Math.max(0.05, 1 - crop.left - crop.right);
  const vertical = Math.max(0.05, 1 - crop.top - crop.bottom);
  return {
    baseWidth: base.width,
    baseHeight: base.height,
    cropWidth: base.width * horizontal,
    cropHeight: base.height * vertical,
  };
}

export function fitScale(
  geo: PageGeometry,
  availWidth: number,
  availHeight: number,
  fitMode: FitMode,
): number {
  const byWidth = availWidth / geo.cropWidth;
  if (fitMode === 'width') return byWidth;
  return Math.min(byWidth, availHeight / geo.cropHeight);
}

export interface PageRequest {
  scoreId: string;
  pageNumber: number;
  crop: CropInsets;
  fitMode: FitMode;
  availWidth: number;
  availHeight: number;
  dpr: number;
}

function cropKey(crop: CropInsets): string {
  const r = (n: number) => Math.round(n * 1000);
  return `${r(crop.left)},${r(crop.top)},${r(crop.right)},${r(crop.bottom)}`;
}

function requestKey(req: PageRequest): string {
  return [
    req.scoreId,
    req.pageNumber,
    req.fitMode,
    Math.round(req.availWidth),
    Math.round(req.availHeight),
    cropKey(req.crop),
    req.dpr.toFixed(2),
  ].join('|');
}

/** Thrown-away sentinel so a cancelled render never resolves into the cache. */
class RenderCancelled extends Error {}

/**
 * Renders pages to detached canvases and caches them, so that a page turn is a
 * DOM insertion of an already-painted canvas rather than a render.
 */
export class PageRenderer {
  private cache = new Map<string, HTMLCanvasElement>();
  private inflight = new Map<string, Promise<HTMLCanvasElement | null>>();
  private cancels = new Map<string, () => void>();
  private order: string[] = [];
  private disposed = false;

  /** Synchronous cache lookup. A hit is what makes a turn feel instant. */
  peek(req: PageRequest): HTMLCanvasElement | undefined {
    const key = requestKey(req);
    const hit = this.cache.get(key);
    if (hit) this.touch(key);
    return hit;
  }

  /** Renders if needed. Returns null if the render was superseded or failed. */
  request(req: PageRequest): Promise<HTMLCanvasElement | null> {
    const key = requestKey(req);
    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key);
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const job = this.run(key, req);
    this.inflight.set(key, job);
    void job.finally(() => {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    });
    return job;
  }

  /** Fire-and-forget warm-up for pages the player is about to reach. */
  prefetch(reqs: PageRequest[]): void {
    for (const req of reqs) {
      if (req.pageNumber < 1) continue;
      void this.request(req).catch(() => undefined);
    }
  }

  private async run(key: string, req: PageRequest): Promise<HTMLCanvasElement | null> {
    try {
      const doc = await openScoreDocument(req.scoreId);
      if (this.disposed) return null;
      if (req.pageNumber < 1 || req.pageNumber > doc.numPages) return null;

      const page = await doc.getPage(req.pageNumber);
      if (this.disposed) return null;

      const geo = pageGeometry(page, req.crop);
      const cssScale = fitScale(geo, req.availWidth, req.availHeight, req.fitMode);

      // Scale down rather than allocate an enormous backing store.
      let deviceScale = cssScale * req.dpr;
      const pixels = geo.cropWidth * geo.cropHeight * deviceScale * deviceScale;
      if (pixels > MAX_PIXELS) deviceScale *= Math.sqrt(MAX_PIXELS / pixels);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(geo.cropWidth * deviceScale));
      canvas.height = Math.max(1, Math.round(geo.cropHeight * deviceScale));
      canvas.style.width = `${geo.cropWidth * cssScale}px`;
      canvas.style.height = `${geo.cropHeight * cssScale}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      // An opaque context starts black; scores are printed on white paper.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const viewport = page.getViewport({ scale: deviceScale });
      // Shift the full-page viewport so the crop's top-left lands at the canvas
      // origin; the canvas bounds then do the cropping.
      const offsetX = req.crop.left * geo.baseWidth * deviceScale;
      const offsetY = req.crop.top * geo.baseHeight * deviceScale;

      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, -offsetX, -offsetY],
        background: '#ffffff',
      });
      this.cancels.set(key, () => task.cancel());

      await task.promise;
      this.cancels.delete(key);
      if (this.disposed) return null;

      this.put(key, canvas);
      return canvas;
    } catch (err) {
      this.cancels.delete(key);
      if (err instanceof RenderCancelled) return null;
      // pdf.js reports cancellation by name, not by an exported class.
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException') {
        return null;
      }
      console.warn('[sound-garden] page render failed', req.scoreId, req.pageNumber, err);
      return null;
    }
  }

  private put(key: string, canvas: HTMLCanvasElement) {
    this.cache.set(key, canvas);
    this.touch(key);
    while (this.order.length > CACHE_LIMIT) {
      const victim = this.order.shift();
      if (!victim) break;
      const dead = this.cache.get(victim);
      this.cache.delete(victim);
      // Zeroing the backing store releases the memory immediately rather than
      // waiting for collection — but never blank a canvas that is on screen.
      if (dead && !dead.isConnected) {
        dead.width = 0;
        dead.height = 0;
      }
    }
  }

  private touch(key: string) {
    const at = this.order.indexOf(key);
    if (at !== -1) this.order.splice(at, 1);
    this.order.push(key);
  }

  /**
   * Cancels outstanding renders and empties the cache, leaving the renderer
   * usable. Called when the performance view closes, so a large library does
   * not sit in memory while browsing.
   */
  clear(): void {
    this.cancelAll();
    for (const canvas of this.cache.values()) {
      if (!canvas.isConnected) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    this.cache.clear();
    this.inflight.clear();
    this.order = [];
  }

  private cancelAll(): void {
    for (const cancel of this.cancels.values()) {
      try {
        cancel();
      } catch {
        /* already finished */
      }
    }
    this.cancels.clear();
  }

  /** Permanent teardown. After this the renderer stops producing pages. */
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancels.values()) {
      try {
        cancel();
      } catch {
        /* already finished */
      }
    }
    this.cancels.clear();
    for (const canvas of this.cache.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.cache.clear();
    this.inflight.clear();
    this.order = [];
  }
}
