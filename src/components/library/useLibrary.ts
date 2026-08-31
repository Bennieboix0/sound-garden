import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Score } from '../../types';

export type SortKey = 'recent' | 'title' | 'artist';

export function useScores(): Score[] | undefined {
  return useLiveQuery(() => db.scores.toArray(), []);
}

export function useThumbnails(): Map<string, string> {
  const rows = useLiveQuery(() => db.thumbs.toArray(), []);
  return useMemo(() => new Map((rows ?? []).map((r) => [r.id, r.dataUrl])), [rows]);
}

export function useSetlists() {
  return useLiveQuery(() => db.setlists.orderBy('updatedAt').reverse().toArray(), []);
}

/** All tags in use, with how many scores carry each. */
export function useTagCounts(scores: Score[] | undefined) {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const score of scores ?? []) {
      for (const tag of score.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [scores]);
}

function normalise(value: string): string {
  // Fold accents so "Gymnopedie" finds "Gymnopédie".
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function filterAndSort(
  scores: Score[],
  query: string,
  tag: string | null,
  sort: SortKey,
): Score[] {
  const terms = normalise(query).split(/\s+/).filter(Boolean);

  const matched = scores.filter((score) => {
    if (tag && !score.tags.includes(tag)) return false;
    if (terms.length === 0) return true;
    const haystack = normalise(
      [score.title, score.artist, score.key, ...score.tags].join(' '),
    );
    // Every term must appear somewhere, so "bach prel" narrows as you type.
    return terms.every((term) => haystack.includes(term));
  });

  const sorted = [...matched];
  switch (sort) {
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'artist':
      sorted.sort(
        (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
      );
      break;
    case 'recent':
    default:
      sorted.sort((a, b) => b.dateAdded - a.dateAdded);
      break;
  }
  return sorted;
}

export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
