import { useEffect, useState } from 'react';

interface WakeLockSentinelLike extends EventTarget {
  release(): Promise<void>;
  released: boolean;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export type WakeLockSupport =
  /** The browser exposes the API and we are allowed to use it. */
  | 'supported'
  /** The API exists but only in a secure context — http on a LAN address. */
  | 'insecure'
  /** No Screen Wake Lock API in this browser at all. */
  | 'unsupported';

export type WakeLockStatus = WakeLockSupport | 'active' | 'blocked' | 'idle';

function wakeLockApi(): WakeLockLike | null {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock ?? null;
}

/**
 * Whether this browser can keep the screen awake at all, independent of
 * whether a lock is currently held. Used by Settings to explain itself.
 */
export function wakeLockSupport(): WakeLockSupport {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (wakeLockApi()) return 'supported';
  // The API is hidden entirely outside a secure context, so an insecure page
  // cannot tell "missing" from "blocked" — infer it from the context instead.
  return window.isSecureContext ? 'unsupported' : 'insecure';
}

/**
 * Holds the screen awake while a score is open.
 *
 * A display that dims two bars into a tune is the worst failure mode this app
 * has, and the OS has no way to know a musician is staring at a page they are
 * not touching. Page turns come from a foot pedal, so there may be no input
 * for many minutes at a time.
 *
 * The lock is deliberately re-acquired rather than assumed to persist: the
 * platform drops it whenever the tab is hidden — switching apps, locking the
 * phone, even some notifications — and it does not come back on its own.
 */
export function useWakeLock(enabled: boolean): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>('idle');

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    const api = wakeLockApi();
    if (!api) {
      setStatus(wakeLockSupport());
      return;
    }

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const onRelease = () => {
      if (cancelled) return;
      // Drop the spent sentinel first — acquire() refuses to run while one is
      // still held, so leaving it in place would block every retry.
      sentinel = null;
      // Lost it. If we are still on screen, take it straight back.
      if (document.visibilityState === 'visible') void acquire();
      else setStatus('idle');
    };

    const acquire = async () => {
      if (cancelled || sentinel) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await api.request('screen');
        if (cancelled) {
          await next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
        next.addEventListener('release', onRelease);
        setStatus('active');
      } catch {
        // Typically a policy refusal (battery saver, or the tab lost focus
        // mid-request). Not fatal, and worth retrying on the next visibility change.
        if (!cancelled) setStatus('blocked');
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!sentinel || sentinel.released) {
        sentinel = null;
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      const held = sentinel;
      sentinel = null;
      if (held) {
        held.removeEventListener('release', onRelease);
        void held.release().catch(() => undefined);
      }
    };
  }, [enabled]);

  return status;
}
