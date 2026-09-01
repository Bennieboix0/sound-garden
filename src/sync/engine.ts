import { isProvisionalHash } from '../db/contentHash';
import type { Score, Setlist, StrokeRecord } from '../types';
import type { WireScorePrefs, WireSetlist, WireStroke } from './transport';

/**
 * The merge rules, as pure functions.
 *
 * Kept free of Dexie, React and the network so the conflict behaviour can be
 * tested directly — two simulated devices and a fake server are enough to prove
 * the interesting cases, and none of them need a Supabase project.
 */

/** A real SHA-256 hash. Provisional `local:` ids must never be uploaded. */
export function isSyncableHash(hash: string): boolean {
  return !isProvisionalHash(hash) && /^[0-9a-f]{64}$/.test(hash);
}

export function strokeToWire(record: StrokeRecord): WireStroke {
  return {
    id: record.id,
    contentHash: record.contentHash,
    pageNumber: record.pageNumber,
    layer: record.layer,
    tool: record.tool,
    color: record.color,
    width: record.width,
    points: record.points,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt ?? null,
  };
}

export function strokeFromWire(wire: WireStroke, authorId: string | null): StrokeRecord {
  const record: StrokeRecord = {
    id: wire.id,
    contentHash: wire.contentHash,
    pageNumber: wire.pageNumber,
    layer: wire.layer,
    authorId,
    tool: wire.tool,
    color: wire.color,
    width: wire.width,
    points: wire.points,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  };
  // Absent rather than null, to keep the row out of the deletedAt index.
  if (wire.deletedAt !== null) record.deletedAt = wire.deletedAt;
  return record;
}

/**
 * Last-write-wins on updatedAt, per stroke id.
 *
 * Strokes are small, immutable once drawn, and independent — two people
 * marking the same bar produce two strokes, not one contested stroke. So there
 * is nothing to merge and a timestamp comparison is genuinely sufficient.
 *
 * Ties keep the local row. A tie means the same logical write reached both
 * sides, so either answer is correct, and preferring local avoids a pointless
 * write.
 */
export function resolveStroke(
  local: StrokeRecord | undefined,
  remote: StrokeRecord,
): StrokeRecord | null {
  if (!local) return remote;
  if (remote.updatedAt > local.updatedAt) return remote;
  return null;
}

/** Which local strokes are eligible to be pushed. */
export function pushableStrokes(records: StrokeRecord[]): WireStroke[] {
  return records
    .filter((record) => isSyncableHash(record.contentHash))
    // Ensemble strokes are published by a director through a different path;
    // a member must never push them back up as their own.
    .filter((record) => record.layer === 'personal')
    .map(strokeToWire);
}

export function setlistToWire(
  setlist: Setlist,
  titleFor: (scoreId: string) => { contentHash: string; title: string } | null,
): WireSetlist | null {
  const items = setlist.scoreIds
    .map(titleFor)
    .filter((item): item is { contentHash: string; title: string } => item !== null)
    .filter((item) => isSyncableHash(item.contentHash));

  return {
    id: setlist.id,
    name: setlist.name,
    items,
    createdAt: setlist.createdAt,
    updatedAt: setlist.updatedAt,
    deletedAt: null,
  };
}

export function scorePrefsToWire(score: Score): WireScorePrefs | null {
  if (!isSyncableHash(score.contentHash)) return null;
  return {
    contentHash: score.contentHash,
    title: score.title || null,
    artist: score.artist || null,
    crop: score.crop ?? null,
    fitMode: score.fitMode ?? null,
    spread: score.spread ?? null,
    // Scores have no updatedAt of their own; dateAdded is the best available
    // stamp and is stable, so a re-import does not clobber a newer edit.
    updatedAt: score.dateAdded,
  };
}

export interface StrokeMergeSummary {
  applied: number;
  skippedOlder: number;
}

/**
 * Decides what a pull should write locally. Returns the rows to put, so the
 * caller can commit them in a single transaction.
 */
export function mergeStrokes(
  localById: Map<string, StrokeRecord>,
  remote: WireStroke[],
  authorId: string | null,
): { toWrite: StrokeRecord[]; summary: StrokeMergeSummary } {
  const toWrite: StrokeRecord[] = [];
  const summary: StrokeMergeSummary = { applied: 0, skippedOlder: 0 };

  for (const wire of remote) {
    const incoming = strokeFromWire(wire, authorId);
    const winner = resolveStroke(localById.get(wire.id), incoming);
    if (winner) {
      toWrite.push(winner);
      summary.applied++;
    } else {
      summary.skippedOlder++;
    }
  }
  return { toWrite, summary };
}
