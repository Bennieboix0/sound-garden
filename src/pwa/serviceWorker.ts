import { useEffect, useState } from 'react';

/**
 * Service worker registration, done by hand.
 *
 * vite-plugin-pwa's own `autoUpdate` registration reloads the page the instant
 * a new build activates. That is exactly wrong here: a musician two pages into
 * a piece would have the score vanish and come back at page one. So
 * `injectRegister` is off in vite.config.ts and this takes over.
 *
 * The new worker still installs and activates immediately (skipWaiting), so the
 * update is genuinely in place — the running page simply keeps its current code
 * until it is next launched, or until the user chooses to apply it from
 * Settings. Nothing here ever reloads on its own.
 */

/** How often to look for a new build while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let updateReady = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        const watch = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            // A worker reaching "installed" while another already controls the
            // page means this is an update rather than a first install.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              updateReady = true;
              notify();
            }
          });
        };

        watch(registration.installing);
        registration.addEventListener('updatefound', () => watch(registration.installing));

        // Long-running sessions are normal here — a stand-mounted tablet may
        // stay open all day — so poll rather than relying on navigation.
        window.setInterval(() => {
          void registration.update().catch(() => undefined);
        }, UPDATE_CHECK_INTERVAL_MS);
      })
      .catch((err: unknown) => {
        console.warn('[sound-garden] service worker registration failed', err);
      });
  });
}

/**
 * Whether a newer build is installed and waiting for the next launch.
 * Deliberately not surfaced anywhere in the performance view.
 */
export function useUpdateReady(): boolean {
  const [ready, setReady] = useState(updateReady);
  useEffect(() => {
    const update = () => setReady(updateReady);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return ready;
}

/** Applies a waiting update. Only ever called from Settings, never automatically. */
export function applyUpdate(): void {
  window.location.reload();
}

/** Build identity, so a bug report can say which version it came from. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
