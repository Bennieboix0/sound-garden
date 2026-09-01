import { useLiveQuery } from 'dexie-react-hooks';
import { db, newId } from './db';
import { enqueue } from './syncQueue';
import type { Stroke, StrokeLayer, StrokeRecord } from '../types';

/** Tombstones are purged once they are older than this. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function isLive(stroke: StrokeRecord): boolean {
  return stroke.deletedAt === undefined;
}

/**
 * Later strokes draw on top. Ordering by creation rather than storage order
 * keeps the stack identical on every device, whatever order rows arrived in.
 */
function byDrawOrder(a: StrokeRecord, b: StrokeRecord): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function usePageStrokes(
  contentHash: string | undefined,
  pageNumber: number,
): StrokeRecord[] {
  const rows = useLiveQuery(
    async () => {
      if (!contentHash) return [];
      const all = await db.strokes
        .where('[contentHash+pageNumber]')
        .equals([contentHash, pageNumber])
        .toArray();
      return all.filter(isLive).sort(byDrawOrder);
    },
    [contentHash, pageNumber],
    [] as StrokeRecord[],
  );
  return rows;
}

/** Content hashes that have any live markings, for badging the library. */
export function useAnnotatedContentHashes(): Set<string> {
  const rows = useLiveQuery(async () => {
    const all = await db.strokes.toArray();
    return all.filter(isLive).map((row) => row.contentHash);
  }, []);
  return new Set(rows ?? []);
}

export async function countLiveStrokes(contentHash: string): Promise<number> {
  const rows = await db.strokes.where('contentHash').equals(contentHash).toArray();
  return rows.filter(isLive).length;
}

export interface AddStrokeOptions {
  layer?: StrokeLayer;
  authorId?: string | null;
}

export async function addStroke(
  contentHash: string,
  pageNumber: number,
  stroke: Stroke,
  options: AddStrokeOptions = {},
): Promise<StrokeRecord> {
  const now = Date.now();
  const record: StrokeRecord = {
    ...stroke,
    id: newId(),
    contentHash,
    pageNumber,
    layer: options.layer ?? 'personal',
    authorId: options.authorId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.strokes.put(record);
  await enqueue('stroke', record.id);
  return record;
}

/**
 * Marks a stroke deleted rather than removing the row.
 *
 * A hard delete cannot survive sync: the other device still holds the row and
 * would simply push it back on its next pull. The tombstone is the delete.
 */
export async function deleteStroke(id: string): Promise<void> {
  const existing = await db.strokes.get(id);
  if (!existing || !isLive(existing)) return;
  const now = Date.now();
  await db.strokes.update(id, { deletedAt: now, updatedAt: now });
  await enqueue('stroke', id);
}

/** Removes the most recently drawn live stroke on a page. Returns it, if any. */
export async function undoLastStroke(
  contentHash: string,
  pageNumber: number,
  layer: StrokeLayer = 'personal',
): Promise<StrokeRecord | null> {
  const all = await db.strokes
    .where('[contentHash+pageNumber]')
    .equals([contentHash, pageNumber])
    .toArray();
  const live = all.filter((row) => isLive(row) && row.layer === layer).sort(byDrawOrder);
  const last = live[live.length - 1];
  if (!last) return null;
  await deleteStroke(last.id);
  return last;
}

/** Tombstones every live stroke on a page in the given layer. */
export async function clearPage(
  contentHash: string,
  pageNumber: number,
  layer: StrokeLayer = 'personal',
): Promise<number> {
  const all = await db.strokes
    .where('[contentHash+pageNumber]')
    .equals([contentHash, pageNumber])
    .toArray();
  const live = all.filter((row) => isLive(row) && row.layer === layer);
  for (const stroke of live) await deleteStroke(stroke.id);
  return live.length;
}

/** Tombstones every live stroke for a document, across all its pages. */
export async function clearContent(
  contentHash: string,
  layer: StrokeLayer = 'personal',
): Promise<number> {
  const all = await db.strokes.where('contentHash').equals(contentHash).toArray();
  const live = all.filter((row) => isLive(row) && row.layer === layer);
  for (const stroke of live) await deleteStroke(stroke.id);
  return live.length;
}

/**
 * Drops tombstones that are old enough that no device could still be holding a
 * copy of the original. Ninety days is generous for a tablet left in a case
 * over a school holiday.
 */
export async function purgeTombstones(now = Date.now()): Promise<number> {
  const cutoff = now - TOMBSTONE_TTL_MS;
  // Only dead rows appear in the deletedAt index, so this scans nothing else.
  const stale = await db.strokes.where('deletedAt').below(cutoff).primaryKeys();
  if (stale.length === 0) return 0;
  await db.transaction('rw', [db.strokes, db.syncQueue], async () => {
    await db.strokes.bulkDelete(stale);
    // Drop any queue entries pointing at rows that no longer exist, so a drain
    // never has to reason about a missing entity.
    for (const id of stale) {
      await db.syncQueue.where('[entity+entityId]').equals(['stroke', id]).delete();
    }
  });
  return stale.length;
}
