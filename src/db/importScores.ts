import { db, newId } from './db';
import { provisionalHash, sha256 } from './contentHash';
import { ensurePersistenceAfterFirstImport } from '../pwa/storage';
import {
  imageFilesToPdf,
  isHeic,
  isImageByName,
  isSupportedImage,
  looksLikeOnePiece,
  naturalSort,
  titleFromImageNames,
} from './importImages';
import { detectCrop, renderThumbnail } from '../pdf/analyze';
import { loadDocumentFromData } from '../pdf/pdfjs';
import type { CropInsets, Score } from '../types';
import { NO_CROP } from '../types';

export interface ImportProgress {
  done: number;
  total: number;
  currentName: string;
}

export interface ImportResult {
  imported: Score[];
  failures: { name: string; reason: string }[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

function looksLikePdf(bytes: Uint8Array): boolean {
  // Some producers put junk before the header, so scan the first KB.
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === PDF_MAGIC[0] &&
      bytes[i + 1] === PDF_MAGIC[1] &&
      bytes[i + 2] === PDF_MAGIC[2] &&
      bytes[i + 3] === PDF_MAGIC[3]
    ) {
      return true;
    }
  }
  return false;
}

/** "Bach_-_Prelude_No1.pdf" -> "Bach - Prelude No1" */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ImportOverrides {
  title?: string;
  artist?: string;
  key?: string;
  tempo?: string;
  tags?: string[];
  crop?: CropInsets;
  /** Skip margin detection, e.g. when the caller already supplied a crop. */
  autoCrop?: boolean;
}

/** Reads one PDF into the library. Returns the stored metadata record. */
export async function importPdf(
  file: Blob,
  fileName: string,
  overrides: ImportOverrides = {},
): Promise<Score> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!looksLikePdf(bytes)) {
    throw new Error('Not a PDF file');
  }

  // From here on `buffer`/`bytes` belong to pdf.js and must not be read again;
  // the original Blob is what gets stored.
  const doc = await loadDocumentFromData(buffer);
  try {
    const pageCount = doc.numPages;

    let title = overrides.title;
    let artist = overrides.artist;
    if (title === undefined || artist === undefined) {
      try {
        const meta = await doc.getMetadata();
        const info = (meta.info ?? {}) as { Title?: string; Author?: string };
        const embeddedTitle = info.Title?.trim();
        const embeddedAuthor = info.Author?.trim();
        if (title === undefined && embeddedTitle) title = embeddedTitle;
        if (artist === undefined && embeddedAuthor) artist = embeddedAuthor;
      } catch {
        // Metadata is optional; fall through to the filename.
      }
    }
    title = title || titleFromFileName(fileName) || 'Untitled score';
    artist = artist ?? '';

    const thumbnail = await renderThumbnail(doc).catch(() => '');

    let crop = overrides.crop ?? NO_CROP;
    if (!overrides.crop && overrides.autoCrop !== false) {
      // Scanned scores are mostly white border. Trimming on import is what makes
      // the first performance-view open look right without any fiddling.
      crop = await detectCrop(doc).catch(() => NO_CROP);
    }

    // Hashed from the blob, not the buffer handed to pdf.js — that one has
    // been transferred to the worker and detached by now.
    const id = newId();
    const contentHash = await sha256(file).catch((err: unknown) => {
      // Web Crypto needs a secure context. Carry on locally with a provisional
      // hash; backfillContentHashes() will upgrade it if that changes.
      console.warn('[sound-garden] could not hash score content', err);
      return provisionalHash(id);
    });

    const score: Score = {
      id,
      contentHash,
      title,
      artist,
      key: overrides.key ?? '',
      tempo: overrides.tempo ?? '',
      tags: overrides.tags ?? [],
      pageCount,
      dateAdded: Date.now(),
      fileName,
      fileSize: file.size,
      crop,
    };

    await db.transaction('rw', db.scores, db.files, db.thumbs, async () => {
      await db.scores.put(score);
      await db.files.put({ id: score.id, blob: file });
      if (thumbnail) await db.thumbs.put({ id: score.id, dataUrl: thumbnail });
    });

    // Browsers weigh a persistence request against how invested the user looks,
    // so ask once there is actually a library to protect rather than on launch.
    void ensurePersistenceAfterFirstImport().catch(() => undefined);

    return score;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** How a batch of images should become scores. */
export type ImageGrouping =
  /** Every image is a page of one score, ordered by filename. */
  | 'one-score'
  /** Each image becomes a score of its own. */
  | 'separate';

/** Splits a dropped batch into the things this app can and cannot read. */
export function partitionFiles(files: File[]): {
  pdfs: File[];
  images: File[];
  unsupported: { name: string; reason: string }[];
} {
  const pdfs: File[] = [];
  const images: File[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (isPdf(file)) pdfs.push(file);
    else if (isSupportedImage(file)) images.push(file);
    else if (isHeic(file)) {
      unsupported.push({
        name: file.name,
        reason: 'HEIC needs Safari — convert it to JPEG or PNG first',
      });
    } else if (isImageByName(file)) {
      unsupported.push({ name: file.name, reason: 'This image format cannot be read' });
    } else {
      unsupported.push({ name: file.name, reason: 'Not a PDF or an image' });
    }
  }
  return { pdfs, images, unsupported };
}

/** Whether a batch should default to being treated as pages of one score. */
export function suggestGrouping(images: File[]): ImageGrouping {
  return looksLikeOnePiece(images) ? 'one-score' : 'separate';
}

/** Imports a batch of PDFs and images, collecting per-file failures. */
export async function importFiles(
  files: File[],
  options: { grouping?: ImageGrouping } = {},
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const { pdfs, images, unsupported } = partitionFiles(files);
  const imported: Score[] = [];
  const failures: { name: string; reason: string }[] = [...unsupported];

  const grouping = options.grouping ?? suggestGrouping(images);
  // Each PDF is one unit of work; images are one unit each too, plus the
  // conversion, which is the slow part.
  const total = pdfs.length + images.length;
  let done = 0;

  for (const file of pdfs) {
    onProgress?.({ done, total, currentName: file.name });
    try {
      imported.push(await importPdf(file, file.name));
    } catch (err) {
      failures.push({
        name: file.name,
        reason: err instanceof Error ? err.message : 'Could not read this file',
      });
    }
    done++;
  }

  if (images.length > 0) {
    // Pages of one piece arrive in whatever order the picker handed them over,
    // so sort numerically: page2 must come before page10.
    const batches =
      grouping === 'one-score' ? [naturalSort(images)] : naturalSort(images).map((f) => [f]);

    for (const batch of batches) {
      const title = titleFromImageNames(batch);
      onProgress?.({ done, total, currentName: batch[0].name });
      try {
        const pdf = await imageFilesToPdf(batch, { title }, (p) => {
          onProgress?.({ done: done + p.done, total, currentName: p.currentName });
        });
        imported.push(
          await importPdf(pdf, `${title}.pdf`, {
            title,
            // Corners were never placed by hand here, so let the usual margin
            // detection run as it would for any imported PDF.
          }),
        );
      } catch (err) {
        failures.push({
          name: batch.length === 1 ? batch[0].name : `${batch.length} images`,
          reason: err instanceof Error ? err.message : 'Could not convert these images',
        });
      }
      done += batch.length;
    }
  }

  onProgress?.({ done: total, total, currentName: '' });
  return { imported, failures };
}

/** @deprecated Use importFiles, which also accepts images. */
export const importPdfFiles = importFiles;

/** Collects dropped files, walking directories when the browser exposes them. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) =>
      'webkitGetAsEntry' in item
        ? (item as DataTransferItem & { webkitGetAsEntry(): FileSystemEntry | null }).webkitGetAsEntry()
        : null,
    );

  if (entries.every((e) => e === null)) {
    return Array.from(dt.files ?? []);
  }

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry | null): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 at a time; keep going until it is empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => {
          reader.readEntries(resolve, () => resolve([]));
        });
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };

  for (const entry of entries) await walk(entry);
  return out;
}
