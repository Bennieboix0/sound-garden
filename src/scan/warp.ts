import type { Quad } from '../types';

/** Cap on the corrected page's long edge — roughly 200dpi for A4. */
const MAX_OUTPUT_EDGE = 2200;
/** Cap on the source we sample from, to keep ImageData memory sane. */
const MAX_SOURCE_EDGE = 2600;

/**
 * Solves a linear system by Gauss-Jordan elimination with partial pivoting.
 * Returns null if the matrix is singular.
 */
function solve(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const divisor = a[col][col];
    for (let k = col; k <= n; k++) a[col][k] /= divisor;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row) => row[n]);
}

/**
 * Homography mapping destination rectangle coordinates back to source pixels.
 *
 * Deliberately solved in the inverse direction: the warp loop walks every
 * output pixel and asks where it came from, which is what lets it sample
 * bilinearly and leave no holes.
 */
function inverseHomography(
  quad: { x: number; y: number }[],
  width: number,
  height: number,
): number[] | null {
  const destination = [
    { u: 0, v: 0 },
    { u: width, v: 0 },
    { u: width, v: height },
    { u: 0, v: height },
  ];

  const matrix: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { u, v } = destination[i];
    const { x, y } = quad[i];
    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    rhs.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    rhs.push(y);
  }
  return solve(matrix, rhs);
}

function drawScaled(source: CanvasImageSource, width: number, height: number): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export interface WarpResult {
  image: ImageData;
  width: number;
  height: number;
}

/**
 * Flattens the quadrilateral region of `source` into an upright rectangle.
 * Corner coordinates are normalised 0–1 against the source's own dimensions.
 */
export function warpQuad(
  source: HTMLCanvasElement | HTMLImageElement | ImageBitmap,
  quad: Quad,
  naturalWidth: number,
  naturalHeight: number,
): WarpResult | null {
  // Work from a bounded copy of the photo rather than a 12MP original.
  const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(naturalWidth, naturalHeight));
  const sourceWidth = Math.max(1, Math.round(naturalWidth * scale));
  const sourceHeight = Math.max(1, Math.round(naturalHeight * scale));
  const sourceImage = drawScaled(source, sourceWidth, sourceHeight);
  if (!sourceImage) return null;

  const rawCorners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map(
    ([nx, ny]) => ({ x: nx * sourceWidth, y: ny * sourceHeight }),
  );

  // Pull the corners very slightly inwards. Pixels exactly on the page boundary
  // are a blend of paper and whatever it is lying on, and sampling them leaves a
  // dark rim around every scan. Content never reaches the edge of a sheet, so
  // half a percent costs nothing.
  const centroid = {
    x: rawCorners.reduce((sum, c) => sum + c.x, 0) / 4,
    y: rawCorners.reduce((sum, c) => sum + c.y, 0) / 4,
  };
  const INSET = 0.005;
  const corners = rawCorners.map((corner) => ({
    x: corner.x + (centroid.x - corner.x) * INSET,
    y: corner.y + (centroid.y - corner.y) * INSET,
  }));

  // Output size comes from the quad's own edges, so the corrected page keeps
  // roughly the aspect ratio of the real sheet rather than being forced to A4.
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  let width = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]));
  let height = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 8 || height < 8) return null;

  const cap = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
  width = Math.max(8, Math.round(width * cap));
  height = Math.max(8, Math.round(height * cap));

  const h = inverseHomography(corners, width, height);
  if (!h) return null;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

  const src = sourceImage.data;
  const out = new ImageData(width, height);
  const dst = out.data;

  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const w = h6 * u + h7 * v + 1;
      const sx = (h0 * u + h1 * v + h2) / w;
      const sy = (h3 * u + h4 * v + h5) / w;
      const target = (v * width + u) * 4;

      if (sx < 0 || sy < 0 || sx > sourceWidth - 1 || sy > sourceHeight - 1) {
        // Outside the photo: paint paper white rather than a black edge.
        dst[target] = 255;
        dst[target + 1] = 255;
        dst[target + 2] = 255;
        dst[target + 3] = 255;
        continue;
      }

      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(x0 + 1, sourceWidth - 1);
      const y1 = Math.min(y0 + 1, sourceHeight - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * sourceWidth + x0) * 4;
      const i10 = (y0 * sourceWidth + x1) * 4;
      const i01 = (y1 * sourceWidth + x0) * 4;
      const i11 = (y1 * sourceWidth + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      for (let channel = 0; channel < 3; channel++) {
        dst[target + channel] =
          src[i00 + channel] * w00 +
          src[i10 + channel] * w10 +
          src[i01 + channel] * w01 +
          src[i11 + channel] * w11;
      }
      dst[target + 3] = 255;
    }
  }

  return { image: out, width, height };
}
