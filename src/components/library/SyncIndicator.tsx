import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { hrefFor } from '../../state/router';
import { SYNC_ENABLED, isSyncConfigured } from '../../sync/flags';
import { useSyncStatus } from '../../sync/useSync';
import { cx } from '../ui/controls';

/**
 * Markings the device holds for documents it has no file for.
 *
 * This is the visible consequence of never uploading PDFs: a second device can
 * receive everything *about* a score without receiving the score. Rather than
 * hide those rows, the library says how many there are, so the state is
 * explicable rather than mysterious — importing the matching PDF makes them
 * appear.
 */
export function useOrphanedMarkingCount(): number {
  const count = useLiveQuery(async () => {
    const [scores, strokes] = await Promise.all([db.scores.toArray(), db.strokes.toArray()]);
    const held = new Set(scores.map((score) => score.contentHash));
    const orphaned = new Set(
      strokes
        .filter((stroke) => stroke.deletedAt === undefined && !held.has(stroke.contentHash))
        .map((stroke) => stroke.contentHash),
    );
    return orphaned.size;
  }, []);
  return count ?? 0;
}

const STATE_LABEL: Record<string, string> = {
  syncing: 'Syncing…',
  offline: 'Offline',
  error: 'Sync problem',
  idle: 'Synced',
  'signed-out': '',
  disabled: '',
};

/**
 * A single quiet line in the library header. Deliberately absent from the
 * performance view, where nothing but the score belongs.
 */
export default function SyncIndicator() {
  const status = useSyncStatus();
  const orphaned = useOrphanedMarkingCount();

  if (!SYNC_ENABLED || !isSyncConfigured() || !status.user) {
    // Still worth mentioning orphaned markings on a local-only install: they
    // can arrive from a restored backup too.
    return orphaned > 0 ? <OrphanNote count={orphaned} /> : null;
  }

  const label = STATE_LABEL[status.state] ?? '';
  const tone =
    status.state === 'error'
      ? 'text-amber-500'
      : status.state === 'offline'
        ? 'text-ink-600 dark:text-ink-300'
        : 'text-moss-500';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
      {label ? (
        <span className={cx('font-semibold', tone)}>
          {label}
          {status.pendingChanges > 0 && status.state !== 'syncing'
            ? ` · ${status.pendingChanges} waiting`
            : ''}
        </span>
      ) : null}
      {orphaned > 0 ? <OrphanNote count={orphaned} inline /> : null}
    </div>
  );
}

function OrphanNote({ count, inline }: { count: number; inline?: boolean }) {
  return (
    <a
      href={hrefFor({ name: 'settings' })}
      className={cx(
        'font-semibold text-ink-700 underline decoration-dotted underline-offset-4 dark:text-ink-200',
        inline ? '' : 'mt-2 block text-base',
      )}
    >
      {count} {count === 1 ? 'score has' : 'scores have'} markings but no file on this device
    </a>
  );
}
