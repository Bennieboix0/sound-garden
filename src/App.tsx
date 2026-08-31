import { useEffect, useState } from 'react';
import { SettingsProvider } from './state/SettingsProvider';
import { hrefFor, useRoute, type Route } from './state/router';
import { seedLibraryIfNeeded } from './db/seed';
import LibraryView from './components/library/LibraryView';
import SetlistsView from './components/setlists/SetlistsView';
import SetlistEditor from './components/setlists/SetlistEditor';
import SettingsView from './components/settings/SettingsView';
import PerformanceRoute from './components/performance/PerformanceRoute';
import { cx } from './components/ui/controls';

const TABS: { route: Route; label: string }[] = [
  { route: { name: 'library' }, label: 'Library' },
  { route: { name: 'setlists' }, label: 'Setlists' },
  { route: { name: 'settings' }, label: 'Settings' },
];

function Chrome({ route, banner }: { route: Route; banner?: string | null }) {
  const active = route.name === 'setlist' ? 'setlists' : route.name;

  return (
    <div className="flex h-full flex-col">
      {banner ? (
        <div
          role="status"
          className="shrink-0 bg-amber-400 px-4 py-2 text-center font-semibold text-ink-950"
        >
          {banner}
        </div>
      ) : null}
      <header className="shrink-0 border-b-2 border-ink-300 bg-white pad-safe-top dark:border-ink-700 dark:bg-ink-900">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pb-3">
          <a
            href={hrefFor({ name: 'library' })}
            className="mr-1 flex items-center gap-2 rounded-lg text-xl font-bold tracking-tight"
          >
            <span aria-hidden className="text-moss-500">
              ❍
            </span>
            <span className="hidden sm:inline">Sound Garden</span>
          </a>
          <nav className="flex flex-1 gap-1" aria-label="Main">
            {TABS.map((tab) => (
              <a
                key={tab.label}
                href={hrefFor(tab.route)}
                aria-current={active === tab.route.name ? 'page' : undefined}
                className={cx(
                  'inline-flex min-h-[2.75rem] items-center rounded-xl px-4 text-lg no-select transition-colors',
                  active === tab.route.name
                    ? 'bg-moss-500 font-semibold text-white'
                    : 'font-medium text-ink-800 hover:bg-ink-200 dark:text-ink-200 dark:hover:bg-ink-800',
                )}
              >
                {tab.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-5 pad-safe-bottom">
          {route.name === 'library' ? <LibraryView /> : null}
          {route.name === 'setlists' ? <SetlistsView /> : null}
          {route.name === 'setlist' ? <SetlistEditor setlistId={route.id} /> : null}
          {route.name === 'settings' ? <SettingsView /> : null}
        </div>
      </main>
    </div>
  );
}

function Bootstrap() {
  const route = useRoute();
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    seedLibraryIfNeeded().catch((err: unknown) => {
      console.error('[sound-garden] seeding failed', err);
      setSeedError('Could not load the bundled demo scores. Import your own PDFs to get started.');
    });
  }, []);

  // The performance view owns the whole screen — no app chrome at all.
  if (route.name === 'play' || route.name === 'perform') {
    return <PerformanceRoute route={route} />;
  }

  return <Chrome route={route} banner={seedError} />;
}

export default function App() {
  return (
    <SettingsProvider>
      <Bootstrap />
    </SettingsProvider>
  );
}
