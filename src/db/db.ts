import Dexie, { type Table } from 'dexie';
import type {
  PageAnnotation,
  Score,
  ScoreFile,
  Setlist,
  Settings,
  Thumbnail,
} from '../types';

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
  annotations!: Table<PageAnnotation, string>;

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

/** Deletes a score and everything attached to it, in one transaction. */
export async function deleteScore(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.scores,
    db.files,
    db.thumbs,
    db.setlists,
    db.annotations,
    async () => {
      await db.scores.delete(id);
      await db.files.delete(id);
      await db.thumbs.delete(id);
      await db.annotations.where('scoreId').equals(id).delete();
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
