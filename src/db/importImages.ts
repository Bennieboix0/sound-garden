import { packOneBit } from '../scan/enhance';
import { canvasToJpegBytes, imagesToPdf, type PdfImagePage } from '../scan/pdf';

/**
 * Turning images into scores.
 *
 * Images are converted to a PDF at import rather than given their own rendering
 * path. Everything downstream — crop, fit modes, annotation coordinates, the
 * content hash that ensemble sharing depends on — already works in terms of PDF
 * pages, and a second kind of document would have to reimplement all of it.
 * Converting once at the door keeps a single rendering pipeline.
 */

/** What the browser can reliably decode. HEIC is deliberately not here. */
const SUPPORTED = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
];

const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export function isSupportedImage(file: File): boolean {
  if (SUPPORTED.includes(file.type)) return true;
  // Some sources hand over a blank type; fall back to the extension.
  return file.type === '' && SUPPORTED_EXTENSIONS.test(file.name);
}

export function isImageByName(file: File): boolean {
  return file.type.startsWith('image/') || SUPPORTED_EXTENSIONS.test(file.name);
}

/** iPhone photos land as HEIC, which no browser but Safari can decode. */
export function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * Orders files the way a person would: page2 before page10.
 * A plain lexicographic sort gets multi-page scans out of order.
 */
export function naturalSort(files: File[]): File[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * True when an image is essentially black ink on white paper.
 *
 * Notation software exports exactly that, and 1-bit gives a smaller and
 * *sharper* result than JPEG, which puts ringing artefacts around staff lines.
 * Photographs and anything coloured fall through to JPEG instead.
 */
function isLineArt(data: Uint8ClampedArray): boolean {
  let extreme = 0;
  let coloured = 0;
  let samples = 0;
  // Sample rather than scan: this only needs to tell two populations apart.
  const stride = Math.max(4, Math.floor(data.length / 4 / 20000) * 4);
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    samples++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 28) coloured++;
    const luma = (r * 299 + g * 587 + b * 114) / 1000;
    if (luma < 60 || luma > 200) extreme++;
  }
  if (samples === 0) return false;
  // Mostly near-black or near-white, and almost no colour.
  return extreme / samples > 0.92 && coloured / samples < 0.02;
}

/** Caps the long edge so a 48MP phone photo does not become a 40MB score. */
const MAX_EDGE = 2600;

async function toPdfPage(file: File): Promise<PdfImagePage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      isHeic(file)
        ? 'HEIC images can only be read by Safari. Convert it to JPEG or PNG first.'
        : 'This image could not be decoded.',
    );
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error('This browser could not prepare the image.');
    // Paper white behind anything transparent — a PNG with an alpha channel
    // would otherwise composite to black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    const pixels = ctx.getImageData(0, 0, width, height);
    if (isLineArt(pixels.data)) {
      // Threshold at mid grey; the image is already essentially two-tone.
      const bw = new ImageData(width, height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const luma =
          (pixels.data[i] * 299 + pixels.data[i + 1] * 587 + pixels.data[i + 2] * 114) / 1000;
        const v = luma < 128 ? 0 : 255;
        bw.data[i] = v;
        bw.data[i + 1] = v;
        bw.data[i + 2] = v;
        bw.data[i + 3] = 255;
      }
      const packed = packOneBit(bw);
      return {
        kind: 'bitonal',
        width: packed.width,
        height: packed.height,
        data: packed.bytes,
      };
    }

    return {
      kind: 'jpeg',
      width,
      height,
      data: await canvasToJpegBytes(canvas, 0.9),
    };
  } finally {
    bitmap.close();
  }
}

export interface ImageConversionProgress {
  done: number;
  total: number;
  currentName: string;
}

/**
 * Converts one or more images into a single PDF, one image per page, in the
 * given order.
 */
export async function imageFilesToPdf(
  files: File[],
  meta: { title?: string; author?: string } = {},
  onProgress?: (p: ImageConversionProgress) => void,
): Promise<Blob> {
  if (files.length === 0) throw new Error('No images to convert.');
  const pages: PdfImagePage[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.({ done: index, total: files.length, currentName: file.name });
    pages.push(await toPdfPage(file));
  }
  onProgress?.({ done: files.length, total: files.length, currentName: '' });
  return imagesToPdf(pages, meta);
}

/** "page-03.png" -> "page 03"; used when naming a score made from images. */
export function titleFromImageNames(files: File[]): string {
  if (files.length === 1) {
    return files[0].name.replace(SUPPORTED_EXTENSIONS, '').replace(/[_-]+/g, ' ').trim();
  }
  // Several pages: strip a trailing page number from the first name, so
  // "prelude-1.png … prelude-4.png" becomes "prelude".
  const first = files[0].name.replace(SUPPORTED_EXTENSIONS, '');
  const stem = first.replace(/[\s._-]*\d+$/, '').replace(/[_-]+/g, ' ').trim();
  return stem || 'Scanned pages';
}

/**
 * Whether a set of images looks like consecutive pages of one document, used to
 * pick the default when asking how to import them.
 */
export function looksLikeOnePiece(files: File[]): boolean {
  if (files.length < 2) return false;
  const stems = files.map((f) =>
    f.name.replace(SUPPORTED_EXTENSIONS, '').replace(/[\s._-]*\d+$/, '').toLowerCase().trim(),
  );
  const numbered = files.every((f) => /\d+\s*$/.test(f.name.replace(SUPPORTED_EXTENSIONS, '')));
  return numbered && new Set(stems).size === 1;
}
