import { useRef, useState } from 'react';
import {
  backupFileName,
  exportLibrary,
  importLibrary,
  type BackupProgress,
  type RestoreMode,
} from '../../db/backup';
import { Button, Spinner } from '../ui/controls';
import { ConfirmDialog } from '../ui/Modal';

export default function BackupPanel() {
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingReplace, setPendingReplace] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modeRef = useRef<RestoreMode>('merge');

  const runExport = async () => {
    setError(null);
    setMessage(null);
    setProgress({ done: 0, total: 1, label: 'Starting' });
    try {
      const blob = await exportLibrary(setProgress);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a moment to start the download before revoking.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage(`Backup saved (${(blob.size / (1024 * 1024)).toFixed(1)} MB).`);
    } catch (err) {
      console.error('[sound-garden] export failed', err);
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setProgress(null);
    }
  };

  const runImport = async (file: File, mode: RestoreMode) => {
    setError(null);
    setMessage(null);
    setProgress({ done: 0, total: 1, label: 'Reading' });
    try {
      const summary = await importLibrary(file, mode, setProgress);
      setMessage(
        `Restored ${summary.scores} score${summary.scores === 1 ? '' : 's'} and ${
          summary.setlists
        } setlist${summary.setlists === 1 ? '' : 's'}${
          summary.skipped > 0 ? `, skipped ${summary.skipped} with missing PDFs` : ''
        }.`,
      );
    } catch (err) {
      console.error('[sound-garden] import failed', err);
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">Backup</h2>
      <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
        Everything lives on this device only. A backup zip holds every PDF, all metadata, your
        setlists and these settings — keep one somewhere safe before a gig.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (modeRef.current === 'replace') setPendingReplace(file);
          else void runImport(file, 'merge');
        }}
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <Button size="lg" variant="primary" onClick={() => void runExport()} disabled={progress !== null}>
          Export library
        </Button>
        <Button
          size="lg"
          disabled={progress !== null}
          onClick={() => {
            modeRef.current = 'merge';
            fileInput.current?.click();
          }}
        >
          Import (merge)
        </Button>
        <Button
          size="lg"
          variant="danger"
          disabled={progress !== null}
          onClick={() => {
            modeRef.current = 'replace';
            fileInput.current?.click();
          }}
        >
          Import (replace all)
        </Button>
      </div>

      {progress ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3">
          <Spinner className="text-moss-500" />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {progress.total > 1
              ? `${progress.done} of ${progress.total} — ${progress.label}`
              : progress.label}
          </span>
        </div>
      ) : null}

      {message ? (
        <p className="mt-4 rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3 font-semibold">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-xl border-2 border-red-500 bg-red-500/10 px-4 py-3 font-semibold">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingReplace !== null}
        title="Replace your whole library?"
        body="Every score, thumbnail and setlist on this device will be deleted and replaced with the contents of the backup. This cannot be undone."
        confirmLabel="Replace everything"
        onCancel={() => setPendingReplace(null)}
        onConfirm={() => {
          const file = pendingReplace;
          setPendingReplace(null);
          if (file) void runImport(file, 'replace');
        }}
      />
    </section>
  );
}
