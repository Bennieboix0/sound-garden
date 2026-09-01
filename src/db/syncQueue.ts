import { db } from './db';
import { SYNC_ENABLED } from '../sync/flags';
import type { SyncEntity, SyncQueueEntry } from '../types';

/**
 * Records that a local entity has changed and needs pushing.
 *
 * Entries hold a reference, never a payload: the drain reads the entity's
 * current state at push time. That makes repeated edits to the same stroke
 * collapse into a single entry, so the queue is bounded by the number of
 * distinct changed entities rather than by how much the user has drawn.
 *
 * The auto-incremented `seq` is the monotonic local sequence number, so a
 * drain can process changes in the order they happened and record how far it
 * got.
 */
export async function enqueue(entity: SyncEntity, entityId: string): Promise<void> {
  // Nothing to push when sync is compiled out; do not accumulate rows that
  // will never be read.
  if (!SYNC_ENABLED) return;

  await db.transaction('rw', db.syncQueue, async () => {
    // Replace rather than append, so the entry also moves to the back of the
    // queue and reflects the most recent change time.
    await db.syncQueue.where('[entity+entityId]').equals([entity, entityId]).delete();
    await db.syncQueue.add({ entity, entityId, queuedAt: Date.now() });
  });
}

/** The oldest pending changes, in the order they were made. */
export function pending(limit = 500): Promise<SyncQueueEntry[]> {
  return db.syncQueue.orderBy('seq').limit(limit).toArray();
}

export function pendingCount(): Promise<number> {
  return db.syncQueue.count();
}

/** Clears entries once they have been accepted by the server. */
export async function acknowledge(seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  await db.syncQueue.bulkDelete(seqs);
}

/** Drops everything pending, e.g. on sign-out. */
export async function clearQueue(): Promise<void> {
  await db.syncQueue.clear();
}
