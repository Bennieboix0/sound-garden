import { useEffect, useState } from 'react';
import { syncClient, type SyncStatus } from './client';
import { SYNC_ENABLED, isSyncConfigured } from './flags';
import { SupabaseTransport } from './supabaseTransport';
import type { SyncTransport } from './transport';

/** undefined = not resolved yet; null = deliberately absent. */
let activeTransport: SyncTransport | null | undefined;
let initialised = false;

/**
 * The live transport, or null when sync is compiled out or unconfigured.
 *
 * Resolved on first use rather than inside a React effect. The performance view
 * needs a transport for live page follow, and it renders with no app chrome —
 * so nothing that mounts `useSyncStatus` is on screen. Tying transport creation
 * to that hook meant follow mode silently did nothing in the one view that
 * needs it.
 */
export function getTransport(): SyncTransport | null {
  if (activeTransport !== undefined) return activeTransport;
  // Checked first, and as a plain constant, so a build with sync disabled drops
  // the Supabase client entirely rather than merely never calling it.
  if (!SYNC_ENABLED || !isSyncConfigured()) {
    activeTransport = null;
    return activeTransport;
  }
  try {
    activeTransport = new SupabaseTransport();
  } catch (err) {
    console.warn('[sound-garden] sync transport unavailable', err);
    activeTransport = null;
  }
  return activeTransport;
}

/**
 * Boots the sync client once per page load and exposes its status.
 *
 * Everything here is inert when the feature is compiled out or no backend is
 * configured — the hook still returns a status, so callers never branch on
 * whether sync exists.
 */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(syncClient.getStatus());

  useEffect(() => {
    if (!initialised) {
      initialised = true;
      void syncClient.init(getTransport());
    }
    return syncClient.subscribe(setStatus);
  }, []);

  return status;
}

/**
 * Holds sync off while a score is open.
 *
 * A page turn is the one hard real-time requirement in this app; a network
 * round trip contending with it is never worth the freshness. Triggers that
 * arrive while suspended are replayed on the way out, not dropped.
 *
 * Live page follow is deliberately exempt: it is a fire-and-forget broadcast of
 * a position, not a data sync, and it never writes to the database.
 */
export function useSuspendSyncWhilePlaying(active: boolean): void {
  useEffect(() => {
    syncClient.setSuspended(active);
    return () => syncClient.setSuspended(false);
  }, [active]);
}
