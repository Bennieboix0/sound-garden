import { db, getSettings, saveSettings } from '../db/db';
import { acknowledge, clearQueue, pending } from '../db/syncQueue';
import type { Score, Setlist, StrokeRecord } from '../types';
import { isSyncConfigured } from './flags';
import {
  mergeStrokes,
  pushableStrokes,
  scorePrefsToWire,
  setlistToWire,
} from './engine';
import type { AuthUser, PushPayload, SyncTransport } from './transport';

export type SyncState =
  | 'disabled'
  | 'signed-out'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error';

export interface SyncStatus {
  state: SyncState;
  user: AuthUser | null;
  lastSyncedAt: number | null;
  pendingChanges: number;
  message: string | null;
}

type Listener = (status: SyncStatus) => void;

/** Wait after the last annotation before pushing, so a busy hand is left alone. */
const IDLE_PUSH_DELAY_MS = 5000;

/**
 * Orchestrates sync. Owns *when*; the transport owns *how*.
 *
 * The one inviolable rule here: nothing runs while the performance view is
 * open. A page turn is the app's hardest real-time requirement, and a network
 * call contending with it — for the main thread, for IndexedDB write locks, or
 * simply by triggering a re-render — is not a trade worth making. Sync waits.
 */
export class SyncClient {
  private listeners = new Set<Listener>();
  private status: SyncStatus = {
    state: 'disabled',
    user: null,
    lastSyncedAt: null,
    pendingChanges: 0,
    message: null,
  };

  private transport: SyncTransport | null = null;
  private running = false;
  private suspended = false;
  private idleTimer: number | null = null;
  private queuedWhileSuspended = false;
  private detachAuth: (() => void) | null = null;

  async init(transport: SyncTransport | null): Promise<void> {
    if (!isSyncConfigured() || !transport) {
      this.update({ state: 'disabled' });
      return;
    }
    this.transport = transport;

    this.detachAuth?.();
    this.detachAuth = transport.onAuthChange((user) => {
      this.update({
        user,
        state: user ? 'idle' : 'signed-out',
        message: null,
      });
      if (user) void this.sync('sign-in');
    });

    const user = await transport.currentUser().catch(() => null);
    this.update({ user, state: user ? 'idle' : 'signed-out' });
    await this.refreshPendingCount();

    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisibility);

    if (user) void this.sync('startup');
  }

  dispose(): void {
    this.detachAuth?.();
    this.detachAuth = null;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Called when the performance view opens and closes. While suspended, every
   * trigger is remembered and replayed on resume rather than dropped.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (!suspended && this.queuedWhileSuspended) {
      this.queuedWhileSuspended = false;
      void this.sync('resume');
    }
  }

  /** Debounced trigger for "the user just drew something". */
  noteLocalChange(): void {
    void this.refreshPendingCount();
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.sync('idle');
    }, IDLE_PUSH_DELAY_MS);
  }

  private onOnline = () => void this.sync('online');
  private onOffline = () => this.update({ state: 'offline' });
  private onVisibility = () => {
    if (document.visibilityState === 'visible') void this.sync('foreground');
  };

  async signIn(email: string, password: string): Promise<void> {
    if (!this.transport) throw new Error('Sync is not configured');
    const user = await this.transport.signIn(email, password);
    this.update({ user, state: 'idle', message: null });
    await this.sync('sign-in');
  }

  async signUp(email: string, password: string, displayName: string): Promise<void> {
    if (!this.transport) throw new Error('Sync is not configured');
    const user = await this.transport.signUp(email, password, displayName);
    this.update({ user, state: 'idle', message: null });
    await this.sync('sign-up');
  }

  async signOut(): Promise<void> {
    if (!this.transport) return;
    await this.transport.signOut();
    // Local data stays: signing out is not a request to lose your markings.
    // The queue does go, because it describes a push to an account we have left.
    await clearQueue();
    await saveSettings({ syncCursor: 0 });
    this.update({ user: null, state: 'signed-out', pendingChanges: 0, message: null });
  }

  exportMyData(): Promise<unknown> {
    if (!this.transport) throw new Error('Sync is not configured');
    return this.transport.exportMyData();
  }

  async deleteMyServerData(): Promise<void> {
    if (!this.transport) throw new Error('Sync is not configured');
    await this.transport.deleteMyData();
    await clearQueue();
    await saveSettings({ syncCursor: 0 });
    await this.refreshPendingCount();
  }

  /** Runs a full push-then-pull cycle. Safe to call at any time. */
  async sync(reason: string): Promise<void> {
    if (!this.transport || !isSyncConfigured()) return;
    if (!this.status.user) return;
    if (this.running) return;

    if (this.suspended) {
      // Deliberately not an error: a page turn must never wait on a socket.
      this.queuedWhileSuspended = true;
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.update({ state: 'offline' });
      return;
    }

    this.running = true;
    this.update({ state: 'syncing', message: null });
    try {
      await this.pushLocal();
      await this.pullRemote();
      const now = Date.now();
      await saveSettings({ lastSyncedAt: now });
      this.update({ state: 'idle', lastSyncedAt: now, message: null });
    } catch (err) {
      console.warn('[sound-garden] sync failed', reason, err);
      this.update({
        state: navigator.onLine === false ? 'offline' : 'error',
        message: err instanceof Error ? err.message : 'Sync failed',
      });
    } finally {
      this.running = false;
      await this.refreshPendingCount();
    }
  }

  private async pushLocal(): Promise<void> {
    if (!this.transport) return;
    const queued = await pending();
    if (queued.length === 0) return;

    const strokeIds = queued.filter((q) => q.entity === 'stroke').map((q) => q.entityId);
    const setlistIds = queued.filter((q) => q.entity === 'setlist').map((q) => q.entityId);
    const prefHashes = queued.filter((q) => q.entity === 'scorePrefs').map((q) => q.entityId);

    const strokes = (await db.strokes.bulkGet(strokeIds)).filter(
      (row): row is StrokeRecord => row !== undefined,
    );
    const setlists = (await db.setlists.bulkGet(setlistIds)).filter(
      (row): row is Setlist => row !== undefined,
    );
    const scores = await db.scores.toArray();
    const scoreById = new Map(scores.map((s) => [s.id, s]));
    const scoreByHash = new Map(scores.map((s) => [s.contentHash, s]));

    const payload: PushPayload = {
      strokes: pushableStrokes(strokes),
      setlists: setlists
        .map((setlist) =>
          setlistToWire(setlist, (scoreId) => {
            const score = scoreById.get(scoreId);
            return score ? { contentHash: score.contentHash, title: score.title } : null;
          }),
        )
        .filter((row): row is NonNullable<typeof row> => row !== null),
      scorePrefs: prefHashes
        .map((hash) => scoreByHash.get(hash))
        .filter((score): score is Score => score !== undefined)
        .map(scorePrefsToWire)
        .filter((row): row is NonNullable<typeof row> => row !== null),
    };

    await this.transport.push(payload);
    // Only acknowledge once the server has taken it.
    await acknowledge(queued.map((q) => q.seq!).filter((seq) => typeof seq === 'number'));
  }

  private async pullRemote(): Promise<void> {
    if (!this.transport) return;
    const settings = await getSettings();
    const since = settings.syncCursor ?? 0;
    const result = await this.transport.pull(since);

    if (result.strokes.length > 0) {
      const ids = result.strokes.map((s) => s.id);
      const existing = await db.strokes.bulkGet(ids);
      const localById = new Map<string, StrokeRecord>();
      for (const row of existing) if (row) localById.set(row.id, row);

      const { toWrite } = mergeStrokes(localById, result.strokes, this.status.user?.id ?? null);
      if (toWrite.length > 0) await db.strokes.bulkPut(toWrite);
    }

    // Setlists and preferences are applied by contentHash where the device
    // holds a matching score; otherwise they are kept for later. Implemented in
    // applyRemoteMetadata to keep this method readable.
    await applyRemoteMetadata(result.setlists, result.scorePrefs);

    await saveSettings({ syncCursor: result.cursor });
  }

  private async refreshPendingCount(): Promise<void> {
    const count = await db.syncQueue.count().catch(() => 0);
    this.update({ pendingChanges: count });
  }

  private update(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}

/**
 * Applies incoming setlists and per-score preferences.
 *
 * Preferences attach to whichever local score carries the same content hash.
 * Setlists are stored with their remote item list intact so an entry can still
 * be shown — greyed, with its title — on a device that has no matching file.
 */
async function applyRemoteMetadata(
  setlists: Awaited<ReturnType<SyncTransport['pull']>>['setlists'],
  prefs: Awaited<ReturnType<SyncTransport['pull']>>['scorePrefs'],
): Promise<void> {
  const scores = await db.scores.toArray();
  const byHash = new Map(scores.map((s) => [s.contentHash, s]));

  for (const pref of prefs) {
    const score = byHash.get(pref.contentHash);
    if (!score) continue;
    // Preferences are last-write-wins too, on the same timestamp rule.
    if (pref.updatedAt <= score.dateAdded) continue;
    await db.scores.update(score.id, {
      ...(pref.crop ? { crop: pref.crop } : {}),
      ...(pref.fitMode ? { fitMode: pref.fitMode } : {}),
      ...(pref.spread !== null ? { spread: pref.spread } : {}),
    });
  }

  for (const remote of setlists) {
    const local = await db.setlists.get(remote.id);
    if (local && local.updatedAt >= remote.updatedAt) continue;
    if (remote.deletedAt !== null) {
      if (local) await db.setlists.delete(remote.id);
      continue;
    }
    await db.setlists.put({
      id: remote.id,
      name: remote.name,
      // Map back to local score ids where the file is present. Missing entries
      // are preserved in `remoteItems` so the editor can show the gap.
      scoreIds: remote.items
        .map((item) => byHash.get(item.contentHash)?.id)
        .filter((id): id is string => id !== undefined),
      remoteItems: remote.items,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
    });
  }
}

export const syncClient = new SyncClient();
