import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEFAULT_SETTINGS, db, saveSettings } from '../db/db';
import type { Settings } from '../types';

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** True until the stored settings have been read at least once. */
  loading: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const stored = useLiveQuery(() => db.settings.get('settings'), []);
  const loading = stored === undefined;

  const settings = useMemo<Settings>(
    () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}), id: 'settings' }),
    [stored],
  );

  const update = useCallback((patch: Partial<Settings>) => {
    void saveSettings(patch).catch((err) => {
      console.error('[sound-garden] could not save settings', err);
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', settings.darkMode);
    // Both media-query variants are overwritten: the app's dark mode is a user
    // setting independent of the OS preference, so whichever one the browser
    // matches has to carry the app's actual colour. ink-900 / ink-100.
    const colour = settings.darkMode ? '#0b0d0c' : '#eef1ef';
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', colour);
    }
  }, [settings.darkMode]);

  const value = useMemo(
    () => ({ settings, update, loading }),
    [settings, update, loading],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
