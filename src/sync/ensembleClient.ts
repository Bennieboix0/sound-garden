import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, newId } from '../db/db';
import { removeEnsembleStrokes } from '../db/annotations';
import { strokeFromWire, strokeToWire } from './engine';
import { isSyncConfigured } from './flags';
import { getTransport } from './useSync';
import type { Assignment, Ensemble, EnsembleMember, StrokeRecord } from '../types';

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

export function useEnsembleActions(): EnsembleActions {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const transport = getTransport();
    if (!transport || !isSyncConfigured()) return;
    setRefreshing(true);
    setError(null);
    try {
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
      for (const ensemble of ensembles) {
        const wire = await transport.pullEnsembleStrokes(ensemble.id, 0);
        const records: StrokeRecord[] = wire.map((row) => ({
          ...strokeFromWire(row, null),
          layer: 'ensemble' as const,
          ensembleId: ensemble.id,
        }));
        const live = records.filter((r) => r.deletedAt === undefined);
        const dead = records.filter((r) => r.deletedAt !== undefined).map((r) => r.id);
        if (live.length > 0) await db.strokes.bulkPut(live);
        if (dead.length > 0) await db.strokes.bulkDelete(dead);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
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
      if (!transport) throw new Error('Sync is not configured');
      const id = await transport.joinEnsemble(code.trim().toUpperCase(), displayName.trim());
      if (!id) {
        setError('That code did not match a group. Check it with your director.');
        return false;
      }
      await refresh();
      return true;
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

    /** Publishes this device's personal markings for a score to the ensemble. */
    publish: async (ensembleId, contentHash) => {
      const transport = getTransport();
      if (!transport) throw new Error('Sync is not configured');
      const all = await db.strokes.where('contentHash').equals(contentHash).toArray();
      const mine = all.filter((s) => s.deletedAt === undefined && !s.ensembleId);
      if (mine.length === 0) return 0;
      // Published copies get fresh ids, so the director keeps their own working
      // markings separate from what the group receives.
      const copies = mine.map((s) => ({
        ...strokeToWire({ ...s, id: newId() }),
        layer: 'ensemble' as const,
        ensembleId,
      }));
      await transport.publishEnsembleStrokes(ensembleId, copies);
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
