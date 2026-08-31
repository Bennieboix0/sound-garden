import { db, getSettings, saveSettings } from './db';
import { importPdf } from './importScores';

/** Bump this when the bundled demo scores change, to re-seed existing installs. */
export const SEED_VERSION = 1;

interface SeedEntry {
  file: string;
  title: string;
  artist: string;
  key: string;
  tempo: string;
  tags: string[];
}

interface SeedIndex {
  version: number;
  scores: SeedEntry[];
}

function seedUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/seed/${path}`;
}

/**
 * Guards against two seed runs overlapping. React strict mode double-invokes
 * effects in development, and both passes would read `seedVersion` as 0 before
 * either had written it back — importing every demo score twice.
 */
let inFlight: Promise<number> | null = null;

/**
 * Loads the bundled public-domain scores on first run so the app demos with no
 * setup. Skipped entirely once the user has a library of their own.
 */
export function seedLibraryIfNeeded(): Promise<number> {
  inFlight ??= runSeed().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSeed(): Promise<number> {
  const settings = await getSettings();
  if (settings.seedVersion >= SEED_VERSION) return 0;

  const existing = await db.scores.count();
  if (existing > 0) {
    // Someone already has a library — do not push demo content into it.
    await saveSettings({ seedVersion: SEED_VERSION });
    return 0;
  }

  let index: SeedIndex;
  try {
    const res = await fetch(seedUrl('index.json'));
    if (!res.ok) throw new Error(`seed index ${res.status}`);
    index = (await res.json()) as SeedIndex;
  } catch (err) {
    console.warn('[sound-garden] no seed library available', err);
    await saveSettings({ seedVersion: SEED_VERSION });
    return 0;
  }

  let added = 0;
  for (const entry of index.scores) {
    try {
      const res = await fetch(seedUrl(entry.file));
      if (!res.ok) throw new Error(`${entry.file} ${res.status}`);
      const blob = await res.blob();
      await importPdf(blob, entry.file, {
        title: entry.title,
        artist: entry.artist,
        key: entry.key,
        tempo: entry.tempo,
        tags: entry.tags,
      });
      added++;
    } catch (err) {
      console.warn('[sound-garden] failed to seed', entry.file, err);
    }
  }

  await saveSettings({ seedVersion: SEED_VERSION });
  return added;
}
