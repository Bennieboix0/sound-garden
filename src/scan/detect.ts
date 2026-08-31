import type { Quad } from '../types';

/** Working resolution for detection. Plenty to find a page edge, and fast. */
const ANALYSIS_WIDTH = 480;

export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function toGray(source: ImageData): GrayImage {
  const { data, width, height } = source;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return { data: out, width, height };
}

/** Otsu's method: the threshold that best separates the histogram into two classes. */
export function otsuThreshold(image: GrayImage): number {
  const histogram = new Uint32Array(256);
  for (const value of image.data) histogram[value]++;

  const total = image.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/**
 * Finds the page in a photo.
 *
 * Assumes the usual case: a bright sheet of paper against a darker surface.
 * Otsu-thresholds the frame, takes the largest bright connected region, then
 * reads its four corners off the extremes of (x+y) and (x−y) — the standard
 * trick for a rotated rectangle, and far less code than contour tracing.
 *
 * Returns null when it is not confident, so the caller can fall back to a
 * default rectangle rather than showing a nonsense quad.
 */
export function detectPageQuad(source: ImageData): Quad | null {
  const gray = toGray(source);
  const { width, height } = gray;
  const threshold = otsuThreshold(gray);

  // Label bright pixels into connected regions with an iterative flood fill;
  // recursion would blow the stack on a full-frame region.
  const labels = new Int32Array(width * height).fill(-1);
  const stack: number[] = [];
  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;

  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== -1 || gray.data[start] <= threshold) continue;
    let size = 0;
    stack.push(start);
    labels[start] = label;

    while (stack.length > 0) {
      const at = stack.pop() as number;
      size++;
      const x = at % width;
      const y = (at / width) | 0;

      if (x > 0) {
        const n = at - 1;
        if (labels[n] === -1 && gray.data[n] > threshold) { labels[n] = label; stack.push(n); }
      }
      if (x < width - 1) {
        const n = at + 1;
        if (labels[n] === -1 && gray.data[n] > threshold) { labels[n] = label; stack.push(n); }
      }
      if (y > 0) {
        const n = at - width;
        if (labels[n] === -1 && gray.data[n] > threshold) { labels[n] = label; stack.push(n); }
      }
      if (y < height - 1) {
        const n = at + width;
        if (labels[n] === -1 && gray.data[n] > threshold) { labels[n] = label; stack.push(n); }
      }
    }

    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
    label++;
  }

  // A page should dominate the frame. Much less than a fifth and we have
  // probably locked onto a highlight or a patch of tablecloth.
  if (bestLabel === -1 || bestSize < width * height * 0.2) return null;

  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  let topLeft: [number, number] = [0, 0];
  let bottomRight: [number, number] = [0, 0];
  let topRight: [number, number] = [0, 0];
  let bottomLeft: [number, number] = [0, 0];

  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== bestLabel) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) { minSum = sum; topLeft = [x, y]; }
    if (sum > maxSum) { maxSum = sum; bottomRight = [x, y]; }
    if (diff > maxDiff) { maxDiff = diff; topRight = [x, y]; }
    if (diff < minDiff) { minDiff = diff; bottomLeft = [x, y]; }
  }

  const norm = ([x, y]: [number, number]): [number, number] => [x / width, y / height];
  const quad: Quad = {
    topLeft: norm(topLeft),
    topRight: norm(topRight),
    bottomRight: norm(bottomRight),
    bottomLeft: norm(bottomLeft),
  };

  return isPlausible(quad) ? quad : null;
}

/** Rejects quads too small or too skewed to be a photographed page. */
function isPlausible(quad: Quad): boolean {
  const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  // Shoelace area in normalised units.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  area = Math.abs(area) / 2;
  if (area < 0.15) return false;

  const side = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = side(quad.topLeft, quad.topRight);
  const bottom = side(quad.bottomLeft, quad.bottomRight);
  const left = side(quad.topLeft, quad.bottomLeft);
  const right = side(quad.topRight, quad.bottomRight);
  if (Math.min(top, bottom, left, right) < 0.1) return false;

  // Opposite sides of a page photographed at a sane angle stay comparable.
  return Math.max(top, bottom) / Math.min(top, bottom) < 2.5 &&
    Math.max(left, right) / Math.min(left, right) < 2.5;
}

/** Downscales to detection resolution and returns the pixels. */
export function analysisImageData(source: HTMLCanvasElement | ImageBitmap): ImageData | null {
  const width = ANALYSIS_WIDTH;
  const sourceWidth = 'width' in source ? source.width : 0;
  const sourceHeight = 'height' in source ? source.height : 0;
  if (!sourceWidth || !sourceHeight) return null;
  const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** The fallback quad: a modest inset, for the user to drag into place. */
export const DEFAULT_QUAD: Quad = {
  topLeft: [0.08, 0.08],
  topRight: [0.92, 0.08],
  bottomRight: [0.92, 0.92],
  bottomLeft: [0.08, 0.92],
};
