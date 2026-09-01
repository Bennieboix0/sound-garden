import { unzip, zip, strFromU8, strToU8, type Zippable } from 'fflate';
import { db, getSettings } from './db';
import { provisionalHash } from './contentHash';
import type { Score, Setlist, Settings, StrokeRecord } from '../types';
import { NO_CROP } from '../types';

const BACKUP_FORMAT = 'sound-garden-backup';
// v3 stores individually addressable strokes keyed by content hash.
// v1 and v2 archives still restore; their markings are simply absent.
const BACKUP_VERSION = 3;

interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  scores: Score[];
  setlists: Setlist[];
  settings: Omit<Settings, 'id'>;
  thumbs: Record<string, string>;
  /**
   * Absent in v1 backups (which predate annotations) and in v2 backups (which
   * stored page-keyed arrays under `annotations`). v2 archives are readable but
   * their markings cannot be re-keyed without the original files, so they are
   * dropped on restore rather than guessed at.
   */
  strokes?: StrokeRecord[];
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
  const [scores, setlists, thumbRows, strokes, settings] = await Promise.all([
    db.scores.toArray(),
    db.setlists.toArray(),
    db.thumbs.toArray(),
    db.strokes.toArray(),
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
    strokes,
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
      db.strokes,
      async () => {
        await Promise.all([
          db.scores.clear(),
          db.files.clear(),
          db.thumbs.clear(),
          db.setlists.clear(),
          db.strokes.clear(),
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
      contentHash: score.contentHash || provisionalHash(score.id),
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

  const restoredScores = await db.scores.toArray();
  const restoredIds = new Set(restoredScores.map((s) => s.id));

  // Markings are keyed by content, not by score row, so they restore even for
  // documents this device has no file for — which is exactly what makes a
  // backup portable between devices.
  for (const stroke of manifest.strokes ?? []) {
    if (!stroke.id || !stroke.contentHash) continue;
    const existing = await db.strokes.get(stroke.id);
    // Same last-write-wins rule the sync layer uses, so merging a backup into a
    // live library never resurrects something already deleted.
    if (existing && existing.updatedAt >= stroke.updatedAt) continue;
    await db.strokes.put(stroke);
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
