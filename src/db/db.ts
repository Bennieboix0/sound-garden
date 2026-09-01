import Dexie, { type Table } from 'dexie';
import type {
  Assignment,
  Ensemble,
  EnsembleMember,
  PageAnnotation,
  Score,
  ScoreFile,
  Setlist,
  Settings,
  StrokeRecord,
  SyncQueueEntry,
  Thumbnail,
} from '../types';
import { provisionalHash } from './contentHash';

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  pedalBindings: [
    // The four combinations that cover essentially every Bluetooth page turner
    // on the market (AirTurn, PageFlip, Donner, iRig BlueTurn, Coda).
    { code: 'PageDown', key: 'PageDown', action: 'next' },
    { code: 'PageUp', key: 'PageUp', action: 'prev' },
    { code: 'ArrowDown', key: 'ArrowDown', action: 'next' },
    { code: 'ArrowUp', key: 'ArrowUp', action: 'prev' },
    { code: 'ArrowRight', key: 'ArrowRight', action: 'next' },
    { code: 'ArrowLeft', key: 'ArrowLeft', action: 'prev' },
    { code: 'Space', key: ' ', action: 'next' },
  ],
  debounceMs: 350,
  darkMode: true,
  invertScores: false,
  pageAnimation: true,
  tapZones: true,
  defaultFitMode: 'width',
  defaultSpread: false,
  keepScreenAwake: true,
  seedVersion: 0,
};

export class SoundGardenDB extends Dexie {
  scores!: Table<Score, string>;
  files!: Table<ScoreFile, string>;
  thumbs!: Table<Thumbnail, string>;
  setlists!: Table<Setlist, string>;
  settings!: Table<Settings, string>;
  /** Legacy page-keyed annotations. Read only by the v3 upgrade. */
  annotations!: Table<PageAnnotation, string>;
  strokes!: Table<StrokeRecord, string>;
  syncQueue!: Table<SyncQueueEntry, number>;
  ensembles!: Table<Ensemble, string>;
  ensembleMembers!: Table<EnsembleMember, [string, string]>;
  assignments!: Table<Assignment, string>;

  constructor() {
    super('sound-garden');
    this.version(1).stores({
      // `*tags` is a multi-entry index, which is what makes tag filtering cheap.
      scores: 'id, title, artist, dateAdded, *tags',
      files: 'id',
      thumbs: 'id',
      setlists: 'id, name, updatedAt',
      settings: 'id',
    });
    // v2 adds annotations. Dexie carries the existing stores forward untouched,
    // so an existing library upgrades in place with nothing to migrate.
    this.version(2).stores({
      annotations: 'id, scoreId',
    });

    // v3 makes local data syncable: scores gain a content hash, and page-keyed
    // stroke arrays become individually addressable stroke rows.
    this.version(3)
      .stores({
        scores: 'id, title, artist, dateAdded, contentHash, *tags',
        strokes: 'id, contentHash, [contentHash+pageNumber], updatedAt, deletedAt',
        syncQueue: '++seq, [entity+entityId], queuedAt',
      })
      .upgrade(async (tx) => {
        // Everything in here must be pure IndexedDB work. Awaiting anything
        // else — crypto.subtle in particular — lets the versionchange
        // transaction auto-close mid-migration and the upgrade fails. Real
        // hashes are computed afterwards by backfillContentHashes().
        const scores = await tx.table<Score>('scores').toArray();
        const hashByScoreId = new Map<string, string>();
        for (const score of scores) {
          const hash = score.contentHash || provisionalHash(score.id);
          hashByScoreId.set(score.id, hash);
          if (score.contentHash !== hash) {
            await tx.table<Score>('scores').update(score.id, { contentHash: hash });
          }
        }

        const legacy = await tx.table<PageAnnotation>('annotations').toArray();
        const strokes = tx.table<StrokeRecord>('strokes');
        for (const record of legacy) {
          const contentHash = hashByScoreId.get(record.scoreId);
          // A page of markings whose score is gone has nothing to key on.
          if (!contentHash) continue;
          const stamp = record.updatedAt || Date.now();
          for (const [index, stroke] of record.strokes.entries()) {
            await strokes.add({
              ...stroke,
              // Order within a page was previously array position; preserve it
              // as createdAt so strokes keep stacking in the same order.
              id: crypto.randomUUID(),
              contentHash,
              pageNumber: record.pageNumber,
              layer: 'personal',
              authorId: null,
              createdAt: stamp + index,
              updatedAt: stamp + index,
            });
          }
        }
      });

    // Dropped separately from v3 so the upgrade above can still read it.
    this.version(4).stores({ annotations: null });

    // v5 adds ensembles, and scopes ensemble strokes to the group that
    // published them. Existing strokes are all personal, so there is nothing to
    // migrate — only the new index to build.
    this.version(5).stores({
      strokes: 'id, contentHash, [contentHash+pageNumber], updatedAt, deletedAt, ensembleId',
      ensembles: 'id, ownerId, updatedAt',
      ensembleMembers: '[ensembleId+userId], ensembleId, userId',
      assignments: 'id, ensembleId, memberId, dueDate, updatedAt',
    });
  }
}

export const db = new SoundGardenDB();

export async function getSettings(): Promise<Settings> {
  const stored = await db.settings.get('settings');
  // Merge so that settings added in a later release get their defaults.
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}), id: 'settings' };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch, id: 'settings' });
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deletes a score and everything attached to it, in one transaction.
 *
 * Markings are tombstoned rather than dropped, so the deletion is something
 * that can travel: a hard delete would simply be re-sent by the next device to
 * sync. Strokes are left alone entirely if another score still points at the
 * same content, which happens when the same PDF has been imported twice.
 */
export async function deleteScore(id: string): Promise<void> {
  const score = await db.scores.get(id);
  const sharesContent = score
    ? (await db.scores.where('contentHash').equals(score.contentHash).primaryKeys()).some(
        (other) => other !== id,
      )
    : true;

  // Array form: Dexie's typed overloads only reach five tables positionally.
  await db.transaction(
    'rw',
    [db.scores, db.files, db.thumbs, db.setlists, db.strokes, db.syncQueue],
    async () => {
      await db.scores.delete(id);
      await db.files.delete(id);
      await db.thumbs.delete(id);
      if (score && !sharesContent) {
        const now = Date.now();
        const strokes = await db.strokes.where('contentHash').equals(score.contentHash).toArray();
        for (const stroke of strokes) {
          if (stroke.deletedAt !== undefined) continue;
          await db.strokes.update(stroke.id, { deletedAt: now, updatedAt: now });
          await db.syncQueue.where('[entity+entityId]').equals(['stroke', stroke.id]).delete();
          await db.syncQueue.add({ entity: 'stroke', entityId: stroke.id, queuedAt: now });
        }
      }
      const affected = await db.setlists.filter((s) => s.scoreIds.includes(id)).toArray();
      for (const setlist of affected) {
        await db.setlists.put({
          ...setlist,
          scoreIds: setlist.scoreIds.filter((sid) => sid !== id),
          updatedAt: Date.now(),
        });
      }
    },
  );
}
