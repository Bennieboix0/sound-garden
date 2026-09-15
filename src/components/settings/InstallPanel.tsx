import { useState } from 'react';
import { useInstall } from '../../pwa/install';
import { APP_VERSION, applyUpdate, useUpdateReady } from '../../pwa/serviceWorker';
import { formatBytes, requestPersistence, useStorageStatus } from '../../pwa/storage';
import { useSettings } from '../../state/SettingsProvider';
import { Button } from '../ui/controls';

/** The iOS share glyph, drawn rather than named — nobody knows it by name. */
function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="inline-block h-6 w-6 align-text-bottom"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="the Share button"
    >
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

function InstallInstructions() {
  const { platform } = useInstall();

  if (platform === 'ios-safari') {
    return (
      <div className="rounded-xl border-2 border-ink-300 p-4 dark:border-ink-600">
        <p className="text-lg font-semibold">Add Sound Garden to your Home Screen</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-base text-ink-700 dark:text-ink-200">
          <li>
            {/* Both drawn and named: the glyph is what you look for, the word is
                what a screen reader reads out. */}
            Tap <ShareIcon /> <strong>Share</strong> at the bottom of Safari.
          </li>
          <li>
            Scroll down and choose <strong>Add to Home Screen</strong>.
          </li>
          <li>
            Tap <strong>Add</strong>.
          </li>
        </ol>
        <p className="mt-3 text-base text-ink-700 dark:text-ink-200">
          It then opens full screen with no browser bars, which is a good deal more of the page.
        </p>
      </div>
    );
  }

  if (platform === 'ios-other') {
    return (
      <p className="rounded-xl border-2 border-amber-400 bg-amber-400/10 px-4 py-3 text-base font-semibold">
        On iPhone and iPad, only Safari can install a web app — this is an Apple restriction, not a
        limitation of the app. Open Sound Garden in Safari and the option appears under the Share
        button.
      </p>
    );
  }

  return (
    <p className="text-base text-ink-700 dark:text-ink-200">
      Your browser has not offered an install option. Chrome, Edge and other Chromium browsers
      offer one; some others do not. Everything works the same either way.
    </p>
  );
}

export default function InstallPanel() {
  const { canPrompt, installed, promptInstall } = useInstall();
  const storage = useStorageStatus();
  const updateReady = useUpdateReady();
  const { settings, update } = useSettings();
  const [busy, setBusy] = useState(false);
  const [persistResult, setPersistResult] = useState<string | null>(null);

  const isIOS = useInstall().platform.startsWith('ios');
  const persistenceDenied = storage?.persisted === false;

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">App</h2>

      {installed ? (
        <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
          Running as an installed app.
        </p>
      ) : (
        <>
          <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
            Installing gives the score the whole screen and puts Sound Garden on your home screen
            or dock. It already works offline either way.
          </p>
          <div className="mt-4">
            {canPrompt ? (
              <Button
                size="lg"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void promptInstall().finally(() => setBusy(false));
                }}
              >
                Install Sound Garden
              </Button>
            ) : (
              <InstallInstructions />
            )}
          </div>
        </>
      )}

      <h3 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        Storage
      </h3>
      {storage === null ? null : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
                Kept by the browser
              </dt>
              <dd className="text-lg font-bold">
                {storage.persisted === null
                  ? 'Unknown'
                  : storage.persisted
                    ? 'Yes — persistent'
                    : 'Not guaranteed'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
                Used
              </dt>
              <dd className="text-lg font-bold">{formatBytes(storage.usageBytes)}</dd>
            </div>
          </dl>

          {persistenceDenied ? (
            <>
              <p className="mt-3 rounded-xl border-2 border-amber-400 bg-amber-400/10 px-4 py-3 text-base font-semibold">
                {isIOS
                  ? 'iOS can clear this app’s storage if the device runs low on space or the app goes unused for a long time. Export a backup and your library is safe either way.'
                  : 'The browser has not guaranteed to keep this app’s storage. Export a backup and your library is safe either way.'}
              </p>
              {storage.supported ? (
                <Button
                  className="mt-3"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void requestPersistence()
                      .then((granted) =>
                        setPersistResult(
                          granted === null
                            ? 'This browser does not offer persistent storage.'
                            : granted
                              ? 'Granted — the browser will keep your library.'
                              : 'The browser declined for now. It often grants this once the app has been used more, or after installing it.',
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Ask again
                </Button>
              ) : null}
              {persistResult ? (
                <p className="mt-2 text-base font-semibold">{persistResult}</p>
              ) : null}
            </>
          ) : null}
        </>
      )}

      <h3 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        Version
      </h3>
      <p className="mt-1 font-mono text-base">{APP_VERSION}</p>
      {updateReady ? (
        <>
          <p className="mt-2 text-base text-ink-700 dark:text-ink-200">
            A newer version is ready. It applies next time you open the app — or now, if you are
            not about to play.
          </p>
          <Button className="mt-2" variant="primary" onClick={applyUpdate}>
            Restart and update
          </Button>
        </>
      ) : (
        <p className="mt-1 text-base text-ink-700 dark:text-ink-200">Up to date.</p>
      )}

      {settings.installBannerDismissed && !installed ? (
        <p className="mt-4 text-sm text-ink-600 dark:text-ink-300">
          The install suggestion in the library is hidden.{' '}
          <button
            type="button"
            className="underline decoration-dotted underline-offset-4"
            onClick={() => update({ installBannerDismissed: false })}
          >
            Show it again
          </button>
        </p>
      ) : null}
    </section>
  );
}
