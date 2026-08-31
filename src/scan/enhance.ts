import type { ScanMode } from '../types';

function luma(data: Uint8ClampedArray, i: number): number {
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
}

/**
 * Bradley–Roth adaptive threshold.
 *
 * A single global threshold is useless on a photographed page: any shadow, or
 * the natural falloff towards a corner, turns half the sheet black. This
 * compares each pixel against the mean of its own neighbourhood via an
 * integral image, so a shadow shifts the local mean with it and the staves
 * still come out clean.
 */
/**
 * `strength` is how far below the local mean a pixel must fall to count as ink.
 * Kept fairly low because staff lines are the thinnest thing on the page and
 * are the first thing to break up if the threshold is too eager.
 */
function adaptiveThreshold(image: ImageData, strength = 11): ImageData {
  const { width, height, data } = image;
  const out = new ImageData(width, height);
  const dst = out.data;

  // Integral image of luma. Float64 keeps it exact at any realistic page size.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += luma(data, (y * width + x) * 4);
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const radius = Math.max(8, (width / 16) | 0);
  const factor = (100 - strength) / 100;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);

      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];

      const i = (y * width + x) * 4;
      const value = luma(data, i) * count < sum * factor ? 0 : 255;
      dst[i] = value;
      dst[i + 1] = value;
      dst[i + 2] = value;
      dst[i + 3] = 255;
    }
  }
  return out;
}

/** Percentile of the luma histogram, used to find the paper white point. */
function lumaPercentile(image: ImageData, percentile: number): number {
  const histogram = new Uint32Array(256);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) histogram[Math.round(luma(data, i))]++;
  const target = (data.length / 4) * percentile;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= target) return v;
  }
  return 255;
}

/**
 * Neutralises the grey cast of a photo by stretching the paper up to white.
 * Used for the greyscale and colour modes, where the ink is left continuous.
 */
function normaliseWhite(image: ImageData, desaturate: boolean): ImageData {
  const white = Math.max(60, lumaPercentile(image, 0.9));
  const black = Math.min(white - 20, lumaPercentile(image, 0.02));
  const range = Math.max(1, white - black);

  const out = new ImageData(image.width, image.height);
  const src = image.data;
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    if (desaturate) {
      const value = Math.max(0, Math.min(255, ((luma(src, i) - black) / range) * 255));
      dst[i] = value;
      dst[i + 1] = value;
      dst[i + 2] = value;
    } else {
      for (let c = 0; c < 3; c++) {
        dst[i + c] = Math.max(0, Math.min(255, ((src[i + c] - black) / range) * 255));
      }
    }
    dst[i + 3] = 255;
  }
  return out;
}

export function enhance(image: ImageData, mode: ScanMode): ImageData {
  switch (mode) {
    case 'bw':
      return adaptiveThreshold(image);
    case 'grey':
      return normaliseWhite(image, true);
    case 'colour':
      return normaliseWhite(image, false);
  }
}

export interface PackedBitmap {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Packs a black-and-white image into 1 bit per pixel, MSB first, rows padded to
 * whole bytes — exactly the layout a PDF image XObject expects. Sheet music is
 * line art, so this is both the smallest and the sharpest representation.
 */
export function packOneBit(image: ImageData): PackedBitmap {
  const { width, height, data } = image;
  const bytesPerRow = (width + 7) >> 3;
  const bytes = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      // 1 = white, matching DeviceGray with 1 bit per component.
      if (data[(y * width + x) * 4] >= 128) {
        bytes[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { bytes, width, height };
}

export function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas;
}
