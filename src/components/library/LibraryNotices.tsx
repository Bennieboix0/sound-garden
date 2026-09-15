import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { useInstall } from '../../pwa/install';
import { BACKUP_REMINDER_AFTER_MS, BACKUP_REMINDER_MIN_SCORES } from '../../pwa/storage';
import { hrefFor } from '../../state/router';
import { useSettings } from '../../state/SettingsProvider';
import { Button } from '../ui/controls';

/**
 * The two things the library is allowed to nag about, and nothing else.
 *
 * Both are dismissible, both stay dismissed, and neither ever appears in the
 * performance view — a musician mid-piece has no use for either.
 */

/** Only after a couple of scores have been opened; never on a first run. */
const INSTALL_PROMPT_AFTER_OPENS = 2;

function Notice({
  children,
  onDismiss,
  action,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border-2 border-ink-400 px-4 py-3 dark:border-ink-600">
      <p className="mr-auto min-w-0 text-base font-semibold">{children}</p>
      {action}
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export default function LibraryNotices() {
  const { settings, update } = useSettings();
  const { canPrompt, installed, promptInstall } = useInstall();

  const scoreCount = useLiveQuery(() => db.scores.count(), [], 0);

  const showInstall =
    !installed &&
    canPrompt &&
    !settings.installBannerDismissed &&
    (settings.scoresOpened ?? 0) >= INSTALL_PROMPT_AFTER_OPENS;

  // A library worth losing, and long enough since it was last written out.
  const lastBackup = settings.lastBackupAt ?? 0;
  const dismissedAt = settings.backupReminderDismissedAt ?? 0;
  const showBackup =
    scoreCount >= BACKUP_REMINDER_MIN_SCORES &&
    Date.now() - lastBackup > BACKUP_REMINDER_AFTER_MS &&
    Date.now() - dismissedAt > BACKUP_REMINDER_AFTER_MS;

  return (
    <>
      {showInstall ? (
        <Notice
          onDismiss={() => update({ installBannerDismissed: true })}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void promptInstall().then((accepted) => {
                  if (accepted) update({ installBannerDismissed: true });
                });
              }}
            >
              Install
            </Button>
          }
        >
          Install Sound Garden to give the score the whole screen.
        </Notice>
      ) : null}

      {showBackup ? (
        <Notice
          onDismiss={() => update({ backupReminderDismissedAt: Date.now() })}
          action={
            <Button
              variant="primary"
              onClick={() => {
                window.location.hash = hrefFor({ name: 'settings' });
              }}
            >
              Back up
            </Button>
          }
        >
          {lastBackup === 0
            ? 'Your library has never been backed up. It lives only on this device.'
            : `Your last backup was ${Math.round((Date.now() - lastBackup) / 86400000)} days ago.`}
        </Notice>
      ) : null}
    </>
  );
}
