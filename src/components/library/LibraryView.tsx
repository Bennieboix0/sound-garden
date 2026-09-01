import { useCallback, useMemo, useRef, useState } from 'react';
import { deleteScore } from '../../db/db';
import { closeScoreDocument } from '../../pdf/pdfjs';
import {
  filesFromDataTransfer,
  importPdfFiles,
  type ImportProgress,
} from '../../db/importScores';
import { useSettings } from '../../state/SettingsProvider';
import type { LibraryLayout, Score } from '../../types';
import { Button, EmptyState, SegmentedControl, Spinner, TextField, cx } from '../ui/controls';
import { ConfirmDialog } from '../ui/Modal';
import MetadataDialog from './MetadataDialog';
import AddToSetlistDialog from './AddToSetlistDialog';
import ScoreCard from './ScoreCard';
import ScoreRow from './ScoreRow';
import ScannerView from '../scan/ScannerView';
import SyncIndicator from './SyncIndicator';
import { filterAndSort, useScores, useTagCounts, useThumbnails, type SortKey } from './useLibrary';

const LAYOUT_KEY = 'sound-garden:layout';
const SORT_KEY = 'sound-garden:sort';

function readStored<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const value = localStorage.getItem(key);
    return value && (allowed as string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function LibraryView() {
  const scores = useScores();
  const thumbs = useThumbnails();
  const tagCounts = useTagCounts(scores);
  const { settings } = useSettings();

  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [layout, setLayout] = useState<LibraryLayout>(() =>
    readStored<LibraryLayout>(LAYOUT_KEY, 'grid', ['grid', 'list']),
  );
  const [sort, setSort] = useState<SortKey>(() =>
    readStored<SortKey>(SORT_KEY, 'recent', ['recent', 'title', 'artist']),
  );

  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<Score | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Score | null>(null);
  const [addingToSetlist, setAddingToSetlist] = useState<Score | null>(null);
  const [scanning, setScanning] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => (scores ? filterAndSort(scores, query, tag, sort) : []),
    [scores, query, tag, sort],
  );

  const persistLayout = (next: LibraryLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* private browsing — the preference just will not stick */
    }
  };

  const persistSort = (next: SortKey) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* as above */
    }
  };

  const runImport = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setNotice(null);
    setProgress({ done: 0, total: files.length, currentName: files[0]?.name ?? '' });
    try {
      const result = await importPdfFiles(files, setProgress);
      const parts: string[] = [];
      if (result.imported.length > 0) {
        parts.push(
          `Added ${result.imported.length} score${result.imported.length === 1 ? '' : 's'}.`,
        );
      }
      if (result.failures.length > 0) {
        parts.push(
          `Skipped ${result.failures.length}: ${result.failures
            .slice(0, 3)
            .map((f) => f.name)
            .join(', ')}${result.failures.length > 3 ? '…' : ''}`,
        );
      }
      setNotice(parts.join(' ') || 'Nothing to import.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setProgress(null);
    }
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = await filesFromDataTransfer(event.dataTransfer);
      await runImport(files);
    },
    [runImport],
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await closeScoreDocument(id);
    await deleteScore(id);
  };

  const loading = scores === undefined;

  return (
    <div
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      className="relative min-h-[60vh]"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-3xl font-bold tracking-tight">Library</h1>
          <SyncIndicator />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={async (event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            await runImport(files);
          }}
        />
        <Button size="lg" onClick={() => setScanning(true)}>
          Scan pages
        </Button>
        <Button variant="primary" size="lg" onClick={() => fileInput.current?.click()}>
          Import PDFs
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[14rem] flex-1">
          <TextField
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, artist or tag"
            aria-label="Search the library"
            className="min-h-[3.25rem] text-lg"
          />
        </div>
        <SegmentedControl<SortKey>
          ariaLabel="Sort by"
          value={sort}
          onChange={persistSort}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'title', label: 'Title' },
            { value: 'artist', label: 'Artist' },
          ]}
        />
        <SegmentedControl<LibraryLayout>
          ariaLabel="Layout"
          value={layout}
          onChange={persistLayout}
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'list', label: 'List' },
          ]}
        />
      </div>

      {tagCounts.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
          {tagCounts.map(([name, count]) => {
            const active = tag === name;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={active}
                onClick={() => setTag(active ? null : name)}
                className={cx(
                  'min-h-[2.5rem] rounded-full border-2 px-4 text-base font-semibold no-select transition-colors',
                  active
                    ? 'border-moss-500 bg-moss-500 text-white'
                    : 'border-ink-400 text-ink-800 hover:border-ink-600 dark:border-ink-600 dark:text-ink-200 dark:hover:border-ink-400',
                )}
              >
                {name}
                <span className={cx('ml-2', active ? 'text-white/80' : 'text-ink-600 dark:text-ink-300')}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {progress ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3">
          <Spinner className="text-moss-500" />
          <span className="font-semibold">
            Importing {progress.done + 1} of {progress.total}
            {progress.currentName ? ` — ${progress.currentName}` : ''}
          </span>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border-2 border-ink-400 px-4 py-3 dark:border-ink-600">
          <span className="font-semibold">{notice}</span>
          <Button variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-8 w-8 text-moss-500" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={scores.length === 0 ? 'Your library is empty' : 'Nothing matches'}
          body={
            scores.length === 0
              ? 'Drop PDFs anywhere on this page, use Import PDFs, or photograph paper copies with Scan pages.'
              : 'Try a different search, or clear the tag filter.'
          }
          action={
            scores.length === 0 ? (
              <Button variant="primary" size="lg" onClick={() => fileInput.current?.click()}>
                Import PDFs
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => {
                  setQuery('');
                  setTag(null);
                }}
              >
                Clear filters
              </Button>
            )
          }
        />
      ) : layout === 'grid' ? (
        <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((score) => (
            <ScoreCard
              key={score.id}
              score={score}
              thumbnail={thumbs.get(score.id)}
              invert={settings.darkMode && settings.invertScores}
              onEdit={() => setEditing(score)}
              onDelete={() => setPendingDelete(score)}
              onAddToSetlist={() => setAddingToSetlist(score)}
            />
          ))}
        </ul>
      ) : (
        <ul className="mt-5 flex flex-col gap-2">
          {visible.map((score) => (
            <ScoreRow
              key={score.id}
              score={score}
              thumbnail={thumbs.get(score.id)}
              invert={settings.darkMode && settings.invertScores}
              onEdit={() => setEditing(score)}
              onDelete={() => setPendingDelete(score)}
              onAddToSetlist={() => setAddingToSetlist(score)}
            />
          ))}
        </ul>
      )}

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-950/80 p-8">
          <div className="rounded-2xl border-4 border-dashed border-moss-400 px-10 py-12 text-center">
            <p className="text-3xl font-bold text-white">Drop PDFs to import</p>
            <p className="mt-2 text-lg text-ink-200">Folders work too.</p>
          </div>
        </div>
      ) : null}

      {scanning ? <ScannerView onClose={() => setScanning(false)} /> : null}

      <MetadataDialog score={editing} onClose={() => setEditing(null)} />
      <AddToSetlistDialog score={addingToSetlist} onClose={() => setAddingToSetlist(null)} />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this score?"
        body={`"${pendingDelete?.title ?? ''}" and its PDF will be removed from this device, and taken out of any setlists. This cannot be undone.`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
