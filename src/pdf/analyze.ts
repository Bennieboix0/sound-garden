import type { CropInsets } from '../types';
import { NO_CROP } from '../types';
import type { PDFDocumentProxy } from './pdfjs';

/** Long edge of a generated library thumbnail, in CSS pixels. */
const THUMB_LONG_EDGE = 360;

export async function renderThumbnail(doc: PDFDocumentProxy): Promise<string> {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = THUMB_LONG_EDGE / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;

  // WebP roughly halves the size versus PNG on engraved music. Browsers that
  // do not support it silently hand back a PNG data URL, which is fine.
  return canvas.toDataURL('image/webp', 0.85);
}

/** A pixel this dark counts as ink rather than paper or scanner noise. */
const INK_LUMA = 170;
/** A row/column needs this many ink pixels before it counts as content. */
const MIN_INK_PIXELS = 3;
/** Breathing room left around the detected content, as a fraction of the page. */
const PADDING = 0.012;

/**
 * Finds the bounding box of actual ink on a page, at low resolution.
 * Returns null when the page is blank.
 */
async function inkBoundsForPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  // 420px on the long edge is plenty to find margins and keeps this fast.
  const scale = 420 / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });

  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;

  const { data } = ctx.getImageData(0, 0, width, height);
  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      // Rec. 601 luma, integer-ish. Good enough to separate ink from paper.
      const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (luma < INK_LUMA) {
        rowInk[y]++;
        colInk[x]++;
      }
    }
  }

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    if (rowInk[y] >= MIN_INK_PIXELS) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x++) {
    if (colInk[x] >= MIN_INK_PIXELS) {
      if (left === -1) left = x;
      right = x;
    }
  }

  if (top === -1 || left === -1) return null;

  return {
    left: left / width,
    top: top / height,
    right: 1 - (right + 1) / width,
    bottom: 1 - (bottom + 1) / height,
  };
}

/**
 * Detects the margins to trim. Samples several pages and keeps the *smallest*
 * inset on each edge, so a page with wider content never gets clipped.
 */
export async function detectCrop(doc: PDFDocumentProxy): Promise<CropInsets> {
  const total = doc.numPages;
  const samples = new Set<number>([1]);
  if (total >= 2) samples.add(Math.ceil(total / 2));
  if (total >= 3) samples.add(total);

  let result: CropInsets | null = null;
  for (const pageNumber of samples) {
    let bounds: Awaited<ReturnType<typeof inkBoundsForPage>>;
    try {
      bounds = await inkBoundsForPage(doc, pageNumber);
    } catch {
      continue;
    }
    if (!bounds) continue;
    result = result
      ? {
          left: Math.min(result.left, bounds.left),
          top: Math.min(result.top, bounds.top),
          right: Math.min(result.right, bounds.right),
          bottom: Math.min(result.bottom, bounds.bottom),
        }
      : bounds;
  }

  if (!result) return NO_CROP;

  const pad = (n: number) => Math.max(0, Math.min(0.45, n - PADDING));
  const crop = {
    left: pad(result.left),
    top: pad(result.top),
    right: pad(result.right),
    bottom: pad(result.bottom),
  };

  // Refuse a crop that would leave a sliver — that means detection went wrong.
  if (1 - crop.left - crop.right < 0.3 || 1 - crop.top - crop.bottom < 0.3) return NO_CROP;
  return crop;
}
