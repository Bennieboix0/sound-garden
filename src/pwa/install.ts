import { useCallback, useEffect, useState } from 'react';

/**
 * Chrome's install prompt event. Not in lib.dom, because it is not a standard.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captured as early as possible — the event fires once, often before React has
 * mounted, and is not re-dispatched. Missing it means never being able to offer
 * an install button at all.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppressing the browser's own banner is what lets us choose the moment:
    // never over a score, and never on a first run.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

export type Platform = 'ios-safari' | 'ios-other' | 'android' | 'desktop' | 'unknown';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so touch points are the tell.
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    // Every iOS browser is WebKit underneath, but only Safari can install a web
    // app. CriOS/FxiOS/EdgiOS identify the wrappers that cannot.
    const isRealSafari = !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/.test(ua);
    return isRealSafari ? 'ios-safari' : 'ios-other';
  }
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** True when running as an installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayModes = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];
  if (displayModes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)) {
    return true;
  }
  // iOS Safari does not support the display-mode query and uses this instead.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export interface InstallState {
  /** Chrome/Edge/Android have handed us a prompt we can fire. */
  canPrompt: boolean;
  /** Already running as an installed app; hide every piece of install UI. */
  installed: boolean;
  platform: Platform;
  /** Fires the browser prompt. Resolves to whether the user accepted. */
  promptInstall: () => Promise<boolean>;
}

export function useInstall(): InstallState {
  const [canPrompt, setCanPrompt] = useState(deferredPrompt !== null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const update = () => {
      setCanPrompt(deferredPrompt !== null);
      setInstalled(isStandalone());
    };
    listeners.add(update);
    update();

    // Installing from a browser tab flips display-mode without a reload.
    const query = window.matchMedia('(display-mode: standalone)');
    query.addEventListener('change', update);

    return () => {
      listeners.delete(update);
      query.removeEventListener('change', update);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const event = deferredPrompt;
    if (!event) return false;
    // The prompt is single-use; drop it whatever the answer.
    deferredPrompt = null;
    notify();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      return outcome === 'accepted';
    } catch {
      return false;
    }
  }, []);

  return { canPrompt, installed, platform: detectPlatform(), promptInstall };
}
