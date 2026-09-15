import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { removeEnsembleStrokes } from '../db/annotations';
import { strokeFromWire, strokeToWire } from './engine';
import { isSyncConfigured } from './flags';
import { getTransport } from './useSync';
import type { Assignment, Ensemble, EnsembleMember, StrokeRecord } from '../types';

/**
 * Derives a stable id for a published copy of a stroke.
 *
 * Publishing used to mint a fresh uuid every time, which meant a director who
 * corrected a bowing and published again left *both* versions on every
 * student's page. Deriving the id from the ensemble and the source stroke makes
 * a re-publish overwrite the previous copy instead of stacking on it.
 */
async function publishedStrokeId(ensembleId: string, sourceId: string): Promise<string> {
  const data = new TextEncoder().encode(`${ensembleId}:${sourceId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const bytes = digest.slice(0, 16);
  // Shape it as a v5-style uuid so the uuid column accepts it.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Local mirror of ensemble membership, plus the actions a director or member
 * can take.
 *
 * Everything is written to Dexie first so the roster, assignments and published
 * markings are all readable with no network — a rehearsal room is exactly where
 * the signal is worst.
 */

export function useEnsembles(): Ensemble[] {
  return useLiveQuery(() => db.ensembles.toArray(), [], [] as Ensemble[]);
}

export function useEnsembleMembers(ensembleId: string | null): EnsembleMember[] {
  return useLiveQuery(
    async () =>
      ensembleId ? db.ensembleMembers.where('ensembleId').equals(ensembleId).toArray() : [],
    [ensembleId],
    [] as EnsembleMember[],
  );
}

export function useAssignments(): Assignment[] {
  return useLiveQuery(() => db.assignments.toArray(), [], [] as Assignment[]);
}

export interface EnsembleActions {
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createEnsemble: (name: string, directorName: string) => Promise<void>;
  joinEnsemble: (code: string, displayName: string) => Promise<boolean>;
  rotateCode: (ensembleId: string) => Promise<void>;
  leave: (ensembleId: string) => Promise<void>;
  remove: (ensembleId: string) => Promise<void>;
  publish: (ensembleId: string, contentHash: string) => Promise<number>;
  saveAssignment: (assignment: Assignment) => Promise<void>;
  deleteAssignment: (id: string) => Promise<void>;
  setDone: (id: string, done: boolean) => Promise<void>;
}

/**
 * One refresh at a time, shared across every component using the hook.
 *
 * EnsemblesView mounts several of them at once (the page, each card, the
 * assignment editor), and each used to fire its own full refresh — clearing and
 * rewriting the same tables concurrently for no benefit.
 */
let inFlightRefresh: Promise<void> | null = null;

export function useEnsembleActions(): EnsembleActions {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const transport = getTransport();
    if (!transport || !isSyncConfigured()) return;
    if (inFlightRefresh) {
      // Someone else is already doing exactly this; wait on their result.
      setRefreshing(true);
      try {
        await inFlightRefresh;
      } finally {
        setRefreshing(false);
      }
      return;
    }
    setRefreshing(true);
    setError(null);
    const run = (async () => {
      const [{ ensembles, members }, assignments] = await Promise.all([
        transport.listEnsembles(),
        transport.listAssignments(),
      ]);

      await db.transaction(
        'rw',
        [db.ensembles, db.ensembleMembers, db.assignments],
        async () => {
          // Replace wholesale: the server is authoritative for membership, and
          // a group you were removed from must actually disappear.
          await db.ensembles.clear();
          await db.ensembleMembers.clear();
          await db.assignments.clear();
          await db.ensembles.bulkPut(ensembles);
          await db.ensembleMembers.bulkPut(members);
          await db.assignments.bulkPut(assignments);
        },
      );

      // Pull each ensemble's published markings.
      //
      // The server is authoritative for a published layer, so this is a full
      // reconcile rather than a merge: anything held locally for this ensemble
      // that the server no longer has must go. Without that sweep a marking the
      // director withdrew stayed on the student's page forever, because a row
      // that has been deleted simply stops appearing in the results.
      for (const ensemble of ensembles) {
        const wire = await transport.pullEnsembleStrokes(ensemble.id, 0);
        const records: StrokeRecord[] = wire.map((row) => ({
          ...strokeFromWire(row, null),
          layer: 'ensemble' as const,
          ensembleId: ensemble.id,
        }));
        const live = records.filter((r) => r.deletedAt === undefined);
        const keep = new Set(live.map((r) => r.id));

        const heldLocally = await db.strokes.where('ensembleId').equals(ensemble.id).primaryKeys();
        const stale = heldLocally.filter((id) => !keep.has(id as string));

        await db.transaction('rw', db.strokes, async () => {
          if (stale.length > 0) await db.strokes.bulkDelete(stale);
          if (live.length > 0) await db.strokes.bulkPut(live);
        });
      }
    })();
    inFlightRefresh = run;
    try {
      await run;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
      inFlightRefresh = null;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const wrap = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work.');
        throw err;
      }
    },
    [refresh],
  );

  return {
    refreshing,
    error,
    refresh,

    createEnsemble: (name, directorName) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.createEnsemble(name, directorName);
      }),

    joinEnsemble: async (code, displayName) => {
      setError(null);
      const transport = getTransport();
      if (!transport) {
        setError('This build has no sync server configured.');
        return false;
      }

      const name = displayName.trim();
      const tidyCode = code.trim().toUpperCase();

      try {
        // A student joining for the first time has no account at all, and
        // join_ensemble refuses an anonymous caller — auth.uid() would be null.
        // Sign in first, with the display name and nothing else: no email, no
        // password, just a token held on this device.
        if (!(await transport.currentUser())) {
          await transport.signInAnonymously(name);
        }

        const id = await transport.joinEnsemble(tidyCode, name);
        if (!id) {
          setError('That code did not match a group. Check it with your director.');
          return false;
        }
        await refresh();
        return true;
      } catch (err) {
        console.error('[sound-garden] join failed', err);
        const message = err instanceof Error ? err.message : String(err);
        setError(
          /anonymous|signup|disabled/i.test(message)
            ? 'This server is not accepting new member accounts. Ask your director to enable anonymous sign-in.'
            : `Could not join: ${message}`,
        );
        return false;
      }
    },

    rotateCode: (ensembleId) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.rotateJoinCode(ensembleId);
      }),

    leave: (ensembleId) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.leaveEnsemble(ensembleId);
        // Their markings go with the membership, locally as well as on the
        // server. Your own personal layer is untouched.
        await removeEnsembleStrokes(ensembleId);
      }),

    remove: (ensembleId) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.deleteEnsemble(ensembleId);
        await removeEnsembleStrokes(ensembleId);
      }),

    /**
     * Publishes this device's personal markings for a score to the ensemble.
     *
     * A replacement, not an addition: whatever the director currently has for
     * this score becomes exactly what the group sees. Publishing twice is
     * therefore harmless, and removing a marking and publishing again actually
     * withdraws it — which is the only way a director can take something back.
     */
    publish: async (ensembleId, contentHash) => {
      const transport = getTransport();
      if (!transport) throw new Error('Sync is not configured');
      const all = await db.strokes.where('contentHash').equals(contentHash).toArray();
      const mine = all.filter((s) => s.deletedAt === undefined && !s.ensembleId);

      const copies = await Promise.all(
        mine.map(async (s) => ({
          ...strokeToWire({ ...s, id: await publishedStrokeId(ensembleId, s.id) }),
          layer: 'ensemble' as const,
          ensembleId,
        })),
      );

      if (copies.length > 0) await transport.publishEnsembleStrokes(ensembleId, copies);
      // Sweep away anything published earlier that is no longer among them.
      await transport.withdrawEnsembleStrokes(
        ensembleId,
        contentHash,
        copies.map((c) => c.id),
      );
      await refresh();
      return copies.length;
    },

    saveAssignment: (assignment) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.upsertAssignment(assignment);
      }),

    deleteAssignment: (id) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.deleteAssignment(id);
      }),

    setDone: (id, done) =>
      wrap(async () => {
        const transport = getTransport();
        if (!transport) throw new Error('Sync is not configured');
        await transport.setAssignmentDone(id, done);
      }),
  };
}
