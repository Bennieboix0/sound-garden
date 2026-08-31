import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { annotationId, type PageAnnotation, type Stroke } from '../types';

export function usePageStrokes(scoreId: string | undefined, pageNumber: number): Stroke[] {
  const record = useLiveQuery(
    async () => (scoreId ? ((await db.annotations.get(annotationId(scoreId, pageNumber))) ?? null) : null),
    [scoreId, pageNumber],
  );
  return record?.strokes ?? [];
}

/** True if the score has any markings at all, for a badge in the library. */
export function useAnnotatedScoreIds(): Set<string> {
  const rows = useLiveQuery(async () => {
    const all = await db.annotations.toArray();
    return all.filter((row) => row.strokes.length > 0).map((row) => row.scoreId);
  }, []);
  return new Set(rows ?? []);
}

async function update(
  scoreId: string,
  pageNumber: number,
  change: (strokes: Stroke[]) => Stroke[],
): Promise<void> {
  const id = annotationId(scoreId, pageNumber);
  await db.transaction('rw', db.annotations, async () => {
    const existing = await db.annotations.get(id);
    const strokes = change(existing?.strokes ?? []);
    if (strokes.length === 0) {
      // Do not leave empty records lying around; absence means "unmarked".
      if (existing) await db.annotations.delete(id);
      return;
    }
    const record: PageAnnotation = {
      id,
      scoreId,
      pageNumber,
      strokes,
      updatedAt: Date.now(),
    };
    await db.annotations.put(record);
  });
}

export function addStroke(scoreId: string, pageNumber: number, stroke: Stroke): Promise<void> {
  return update(scoreId, pageNumber, (strokes) => [...strokes, stroke]);
}

/** Removes the most recent stroke and hands it back, so it can be redone. */
export async function popStroke(scoreId: string, pageNumber: number): Promise<Stroke | null> {
  const id = annotationId(scoreId, pageNumber);
  let removed: Stroke | null = null;
  await update(scoreId, pageNumber, (strokes) => {
    if (strokes.length === 0) return strokes;
    removed = strokes[strokes.length - 1];
    return strokes.slice(0, -1);
  });
  void id;
  return removed;
}

export function clearPage(scoreId: string, pageNumber: number): Promise<void> {
  return update(scoreId, pageNumber, () => []);
}

export async function clearScore(scoreId: string): Promise<void> {
  await db.annotations.where('scoreId').equals(scoreId).delete();
}

export async function countStrokesForScore(scoreId: string): Promise<number> {
  const rows = await db.annotations.where('scoreId').equals(scoreId).toArray();
  return rows.reduce((sum, row) => sum + row.strokes.length, 0);
}
