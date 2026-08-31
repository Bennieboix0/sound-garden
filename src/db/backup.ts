import { unzip, zip, strFromU8, strToU8, type Zippable } from 'fflate';
import { db, getSettings } from './db';
import type { PageAnnotation, Score, Setlist, Settings } from '../types';
import { NO_CROP } from '../types';

const BACKUP_FORMAT = 'sound-garden-backup';
// v2 adds annotations. v1 backups still restore — the field is optional.
const BACKUP_VERSION = 2;

interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  scores: Score[];
  setlists: Setlist[];
  settings: Omit<Settings, 'id'>;
  thumbs: Record<string, string>;
  /** Optional: absent in v1 backups, which predate annotations. */
  annotations?: PageAnnotation[];
}

function zipAsync(input: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(input, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function unzipAsync(input: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(input, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export interface BackupProgress {
  done: number;
  total: number;
  label: string;
}

/** Packs the entire library — PDFs, metadata, setlists and settings — into a zip. */
export async function exportLibrary(onProgress?: (p: BackupProgress) => void): Promise<Blob> {
  const [scores, setlists, thumbRows, annotations, settings] = await Promise.all([
    db.scores.toArray(),
    db.setlists.toArray(),
    db.thumbs.toArray(),
    db.annotations.toArray(),
    getSettings(),
  ]);

  const thumbs: Record<string, string> = {};
  for (const row of thumbRows) thumbs[row.id] = row.dataUrl;

  const { id: _id, ...settingsWithoutKey } = settings;
  void _id;

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    scores,
    setlists,
    settings: settingsWithoutKey,
    thumbs,
    annotations,
  };

  const entries: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  };

  for (const [index, score] of scores.entries()) {
    onProgress?.({ done: index, total: scores.length, label: score.title });
    const file = await db.files.get(score.id);
    if (!file) continue;
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    // PDFs carry their own compression; re-deflating them costs time for nothing.
    entries[`scores/${score.id}.pdf`] = [bytes, { level: 0 }];
  }

  onProgress?.({ done: scores.length, total: scores.length, label: 'Compressing' });
  const zipped = await zipAsync(entries);
  // Copy into a fresh buffer so the Blob does not alias fflate's memory.
  return new Blob([zipped.slice()], { type: 'application/zip' });
}

export interface RestoreSummary {
  scores: number;
  setlists: number;
  skipped: number;
}

export type RestoreMode = 'merge' | 'replace';

/** Restores a backup produced by exportLibrary. */
export async function importLibrary(
  file: Blob,
  mode: RestoreMode = 'merge',
  onProgress?: (p: BackupProgress) => void,
): Promise<RestoreSummary> {
  onProgress?.({ done: 0, total: 1, label: 'Reading backup' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contents = await unzipAsync(bytes);

  const manifestBytes = contents['manifest.json'];
  if (!manifestBytes) throw new Error('This zip is not a Sound Garden backup (no manifest.json).');

  const manifest = JSON.parse(strFromU8(manifestBytes)) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error('This zip is not a Sound Garden backup.');
  }
  if (manifest.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of Sound Garden.');
  }

  if (mode === 'replace') {
    await db.transaction(
      'rw',
      db.scores,
      db.files,
      db.thumbs,
      db.setlists,
      db.annotations,
      async () => {
        await Promise.all([
          db.scores.clear(),
          db.files.clear(),
          db.thumbs.clear(),
          db.setlists.clear(),
          db.annotations.clear(),
        ]);
      },
    );
  }

  let restored = 0;
  let skipped = 0;
  const total = manifest.scores.length;

  for (const [index, score] of manifest.scores.entries()) {
    onProgress?.({ done: index, total, label: score.title });
    const pdfBytes = contents[`scores/${score.id}.pdf`];
    if (!pdfBytes) {
      skipped++;
      continue;
    }
    const blob = new Blob([pdfBytes.slice()], { type: 'application/pdf' });
    // Older backups may predate fields added since; fill them in.
    const normalised: Score = {
      ...score,
      crop: score.crop ?? NO_CROP,
      tags: Array.isArray(score.tags) ? score.tags : [],
    };
    await db.transaction('rw', db.scores, db.files, db.thumbs, async () => {
      await db.scores.put(normalised);
      await db.files.put({ id: score.id, blob });
      const thumb = manifest.thumbs?.[score.id];
      if (thumb) await db.thumbs.put({ id: score.id, dataUrl: thumb });
    });
    restored++;
  }

  if (manifest.settings) {
    // Worth carrying across: a musician moving devices keeps the same pedal.
    // seedVersion stays local so the demo library is not re-imported.
    const local = await getSettings();
    await db.settings.put({
      ...local,
      ...manifest.settings,
      seedVersion: Math.max(local.seedVersion, manifest.settings.seedVersion ?? 0),
      id: 'settings',
    });
  }

  // Markings are restored only for scores that actually came across.
  const restoredIds = new Set((await db.scores.toArray()).map((s) => s.id));
  for (const annotation of manifest.annotations ?? []) {
    if (!restoredIds.has(annotation.scoreId)) continue;
    if (!annotation.strokes?.length) continue;
    await db.annotations.put(annotation);
  }

  const validIds = restoredIds;
  for (const setlist of manifest.setlists ?? []) {
    await db.setlists.put({
      ...setlist,
      // Drop references to scores that did not make it across.
      scoreIds: setlist.scoreIds.filter((id) => validIds.has(id)),
    });
  }

  onProgress?.({ done: total, total, label: 'Done' });
  return { scores: restored, setlists: (manifest.setlists ?? []).length, skipped };
}

export function backupFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `sound-garden-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}
