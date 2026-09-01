import { useEffect, useState } from 'react';
import { syncClient, type SyncStatus } from './client';
import { isSyncConfigured } from './flags';
import { SupabaseTransport } from './supabaseTransport';

let initialised = false;

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
      const transport = isSyncConfigured()
        ? (() => {
            try {
              return new SupabaseTransport();
            } catch (err) {
              console.warn('[sound-garden] sync transport unavailable', err);
              return null;
            }
          })()
        : null;
      void syncClient.init(transport);
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
 */
export function useSuspendSyncWhilePlaying(active: boolean): void {
  useEffect(() => {
    syncClient.setSuspended(active);
    return () => syncClient.setSuspended(false);
  }, [active]);
}
