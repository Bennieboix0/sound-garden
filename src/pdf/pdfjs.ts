import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { db } from '../db/db';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js does not re-export its proxy classes from the package root, so derive
// the types from getDocument rather than reaching into internal paths.
type LoadingTask = ReturnType<typeof pdfjsLib.getDocument>;
export type PDFDocumentProxy = Awaited<LoadingTask['promise']>;
export type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

export { pdfjsLib };

/**
 * Consumes `data` — pdf.js transfers the buffer to its worker, which detaches
 * it. Callers must not read from the buffer after calling this.
 */
export async function loadDocumentFromData(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
}

const MAX_OPEN_DOCUMENTS = 4;

const openDocuments = new Map<string, Promise<PDFDocumentProxy>>();
const useOrder: string[] = [];

function touch(scoreId: string) {
  const at = useOrder.indexOf(scoreId);
  if (at !== -1) useOrder.splice(at, 1);
  useOrder.push(scoreId);
}

async function evictIfNeeded() {
  while (useOrder.length > MAX_OPEN_DOCUMENTS) {
    const victim = useOrder.shift();
    if (!victim) break;
    const pending = openDocuments.get(victim);
    openDocuments.delete(victim);
    if (!pending) continue;
    try {
      const doc = await pending;
      await doc.destroy();
    } catch {
      // A document that failed to load has nothing to tear down.
    }
  }
}

/**
 * Opens a score's PDF, keeping a small pool of parsed documents alive. During
 * setlist playback this is what lets the first page of the *next* score be
 * rendered before the current score runs out of pages.
 */
export function openScoreDocument(scoreId: string): Promise<PDFDocumentProxy> {
  const existing = openDocuments.get(scoreId);
  if (existing) {
    touch(scoreId);
    return existing;
  }

  const loading = (async () => {
    const record = await db.files.get(scoreId);
    if (!record) throw new Error(`No PDF stored for score ${scoreId}`);
    const buffer = await record.blob.arrayBuffer();
    return loadDocumentFromData(buffer);
  })();

  openDocuments.set(scoreId, loading);
  touch(scoreId);
  void evictIfNeeded();

  loading.catch(() => {
    // Do not cache a rejected load; a retry should get a fresh attempt.
    if (openDocuments.get(scoreId) === loading) {
      openDocuments.delete(scoreId);
      const at = useOrder.indexOf(scoreId);
      if (at !== -1) useOrder.splice(at, 1);
    }
  });

  return loading;
}

/** Drops a document from the pool, e.g. after its score is deleted or re-cropped. */
export async function closeScoreDocument(scoreId: string): Promise<void> {
  const pending = openDocuments.get(scoreId);
  openDocuments.delete(scoreId);
  const at = useOrder.indexOf(scoreId);
  if (at !== -1) useOrder.splice(at, 1);
  if (!pending) return;
  try {
    const doc = await pending;
    await doc.destroy();
  } catch {
    /* nothing to destroy */
  }
}
