import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { useSettings } from '../../state/SettingsProvider';
import { wakeLockSupport } from '../../hooks/useWakeLock';
import type { FitMode } from '../../types';
import { SegmentedControl, Toggle } from '../ui/controls';
import BackupPanel from './BackupPanel';
import PedalSettings from './PedalSettings';
import SyncPanel from './SyncPanel';

function DisplaySettings() {
  const { settings, update } = useSettings();

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">Display</h2>

      <div className="mt-4 flex flex-col gap-3">
        <Toggle
          label="Dark mode"
          description="Dims the app itself. Kinder on the eyes in a dark room."
          checked={settings.darkMode}
          onChange={(value) => update({ darkMode: value })}
        />
        <Toggle
          label="Invert scores"
          description="White notes on black paper. Cuts the glare from a bright white page on a dark stage."
          checked={settings.invertScores}
          disabled={!settings.darkMode}
          onChange={(value) => update({ invertScores: value })}
        />
        <Toggle
          label="Page-turn animation"
          description="A brief slide as the page changes. The new page is already rendered either way, so this never slows a turn down."
          checked={settings.pageAnimation}
          onChange={(value) => update({ pageAnimation: value })}
        />
        <Toggle
          label="Keep the screen awake"
          description={
            wakeLockSupport() === 'supported'
              ? 'Stops the display dimming or sleeping while a score is open. Page turns come from a pedal, so the device may see no input for a whole piece.'
              : wakeLockSupport() === 'insecure'
                ? 'Unavailable: browsers only allow this over https (or on localhost). This page is on a plain http address.'
                : 'Unavailable: this browser has no Screen Wake Lock support. Try Chrome, Edge, Safari 16.4+, or Firefox 126+.'
          }
          checked={settings.keepScreenAwake}
          disabled={wakeLockSupport() !== 'supported'}
          onChange={(value) => update({ keepScreenAwake: value })}
        />
        <Toggle
          label="Tap zones"
          description="Tap the left or right third of the score to turn pages, the middle to show the controls. Off means a tap anywhere just shows the controls."
          checked={settings.tapZones}
          onChange={(value) => update({ tapZones: value })}
        />
      </div>

      <h3 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        Default layout
      </h3>
      <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
        Used for scores you have not set individually. Changing fit or spread while playing saves
        against that score alone.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <SegmentedControl<FitMode>
          ariaLabel="Default fit mode"
          size="lg"
          value={settings.defaultFitMode}
          onChange={(value) => update({ defaultFitMode: value })}
          options={[
            { value: 'width', label: 'Fit width' },
            { value: 'page', label: 'Fit page' },
          ]}
        />
        <SegmentedControl<'single' | 'spread'>
          ariaLabel="Default page layout"
          size="lg"
          value={settings.defaultSpread ? 'spread' : 'single'}
          onChange={(value) => update({ defaultSpread: value === 'spread' })}
          options={[
            { value: 'single', label: '1 page' },
            { value: 'spread', label: '2 pages' },
          ]}
        />
      </div>
    </section>
  );
}

function StorageSummary() {
  const stats = useLiveQuery(async () => {
    const [scores, setlists] = await Promise.all([db.scores.toArray(), db.setlists.count()]);
    const bytes = scores.reduce((sum, score) => sum + (score.fileSize || 0), 0);
    const pages = scores.reduce((sum, score) => sum + score.pageCount, 0);
    return { count: scores.length, bytes, pages, setlists };
  }, []);

  if (!stats) return null;

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">On this device</h2>
      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Scores', String(stats.count)],
          ['Pages', String(stats.pages)],
          ['Setlists', String(stats.setlists)],
          ['PDF data', `${(stats.bytes / (1024 * 1024)).toFixed(1)} MB`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
              {label}
            </dt>
            <dd className="text-2xl font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-base text-ink-700 dark:text-ink-200">
        Sound Garden has no accounts and no server. Nothing here has ever left this device.
      </p>
    </section>
  );
}

export default function SettingsView() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <PedalSettings />
      <DisplaySettings />
      <BackupPanel />
      <SyncPanel />
      <StorageSummary />
    </div>
  );
}
