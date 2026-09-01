import { db } from './db';
import { canHash, isProvisionalHash, sha256 } from './contentHash';
import { purgeTombstones } from './annotations';

export interface BackfillResult {
  hashed: number;
  strokesRekeyed: number;
  tombstonesPurged: number;
  failed: number;
}

/**
 * Computes real content hashes for scores the migration could only mark
 * provisionally, and moves their strokes across to match.
 *
 * This cannot happen inside the Dexie upgrade: awaiting crypto.subtle lets an
 * IndexedDB versionchange transaction auto-close, which would abort the
 * migration part-way. So the upgrade stamps `local:<id>` and this runs
 * afterwards, on ordinary transactions, where awaiting anything is safe.
 *
 * Runs at startup, is idempotent, and is safe to interrupt: each score is
 * committed with its own strokes in one transaction, so a refresh mid-way just
 * resumes with whatever is left.
 */
export async function backfillContentHashes(): Promise<BackfillResult> {
  const result: BackfillResult = {
    hashed: 0,
    strokesRekeyed: 0,
    tombstonesPurged: 0,
    failed: 0,
  };

  result.tombstonesPurged = await purgeTombstones().catch(() => 0);

  if (!canHash()) {
    // No Web Crypto (insecure context). Provisional hashes stay put; the app
    // is fully functional locally, it just cannot content-address yet.
    return result;
  }

  const scores = await db.scores.toArray();
  const pending = scores.filter((score) => !score.contentHash || isProvisionalHash(score.contentHash));

  for (const score of pending) {
    try {
      const file = await db.files.get(score.id);
      if (!file) {
        // Metadata with no blob: nothing to hash, and nothing that could ever
        // match another device. Leave it provisional.
        continue;
      }
      const realHash = await sha256(file.blob);
      const oldHash = score.contentHash;

      await db.transaction('rw', db.scores, db.strokes, async () => {
        await db.scores.update(score.id, { contentHash: realHash });
        if (!oldHash || oldHash === realHash) return;
        const strokes = await db.strokes.where('contentHash').equals(oldHash).toArray();
        for (const stroke of strokes) {
          await db.strokes.update(stroke.id, { contentHash: realHash });
        }
        result.strokesRekeyed += strokes.length;
      });

      result.hashed++;
    } catch (err) {
      console.warn('[sound-garden] could not hash score', score.id, err);
      result.failed++;
    }
  }

  return result;
}
