import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
  released: boolean;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * Holds the screen awake while the performance view is open.
 *
 * A display that dims two bars into a tune is the single worst failure mode for
 * a stand-mounted reader, and the OS has no way to know a musician is looking
 * at it. Silently does nothing where the API is unavailable.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const next = await wakeLock.request('screen');
        if (cancelled) {
          await next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
      } catch {
        // Denied, or the tab is not visible. Not worth surfacing.
      }
    };

    // The OS drops the lock whenever the tab is backgrounded, so re-take it.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}
