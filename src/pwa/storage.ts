import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../db/db';

/**
 * Storage durability.
 *
 * Losing a musician's library is the worst thing this app can do. Everything is
 * stored locally by design, and browsers — iOS most aggressively — may evict
 * that storage under pressure or after a long period of disuse. Asking for
 * persistent storage makes eviction far less likely; a backup is what makes it
 * survivable.
 */

export interface StorageStatus {
  /** null while unknown, e.g. where the API is unavailable. */
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  supported: boolean;
}

export async function readStorageStatus(): Promise<StorageStatus> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage) {
    return { persisted: null, usageBytes: null, quotaBytes: null, supported: false };
  }
  const [persisted, estimate] = await Promise.all([
    typeof storage.persisted === 'function' ? storage.persisted().catch(() => null) : null,
    typeof storage.estimate === 'function'
      ? storage.estimate().catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    supported: typeof storage.persist === 'function',
  };
}

/**
 * Asks the browser to keep this origin's storage.
 *
 * Called after the first import rather than on first launch: browsers weigh the
 * request against how much the user appears to care about the site, and an
 * empty library is not much of a case. The outcome is recorded so Settings can
 * be honest about it either way.
 */
export async function requestPersistence(): Promise<boolean | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      await saveSettings({ storagePersisted: true });
      return true;
    }
    const granted = await storage.persist();
    await saveSettings({ storagePersisted: granted });
    return granted;
  } catch {
    return null;
  }
}

/** Runs once, the first time the library stops being empty. */
export async function ensurePersistenceAfterFirstImport(): Promise<void> {
  const settings = await getSettings();
  if (settings.storagePersistAsked) return;
  await saveSettings({ storagePersistAsked: true });
  await requestPersistence();
}

export function useStorageStatus(): StorageStatus | null {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const refresh = useCallback(() => {
    void readStorageStatus().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);
  return status;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Nag threshold for backups: enough scores to be worth losing, and long enough. */
export const BACKUP_REMINDER_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const BACKUP_REMINDER_MIN_SCORES = 5;
