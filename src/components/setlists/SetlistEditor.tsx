import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { db } from '../../db/db';
import { hrefFor } from '../../state/router';
import { useSettings } from '../../state/SettingsProvider';
import type { Score } from '../../types';
import { Button, EmptyState, IconButton, Spinner, TextField, cx } from '../ui/controls';
import { Modal } from '../ui/Modal';
import { ThumbnailImage } from '../library/ScoreCard';
import { filterAndSort, useScores, useThumbnails } from '../library/useLibrary';

/** One draggable row. Also carries up/down buttons — dragging on a stand is fiddly. */
function SortableScoreRow({
  id,
  position,
  total,
  score,
  thumbnail,
  invert,
  onRemove,
  onMove,
  onPlayFrom,
}: {
  id: string;
  position: number;
  total: number;
  score: Score;
  thumbnail?: string;
  invert: boolean;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onPlayFrom: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        'flex items-center gap-2 rounded-xl border-2 bg-white p-2 dark:bg-ink-850',
        isDragging
          ? 'z-10 border-moss-500 shadow-2xl'
          : 'border-ink-300 dark:border-ink-700',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Reorder ${score.title}`}
        className="flex h-14 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-2xl text-ink-600 hover:bg-ink-200 active:cursor-grabbing dark:text-ink-300 dark:hover:bg-ink-700"
        {...attributes}
        {...listeners}
      >
        <span aria-hidden>⠿</span>
      </button>

      <span className="w-8 shrink-0 text-center text-xl font-bold tabular-nums text-ink-600 dark:text-ink-300">
        {position + 1}
      </span>

      <ThumbnailImage
        thumbnail={thumbnail}
        title={score.title}
        invert={invert}
        className="h-16 w-[2.85rem] shrink-0 rounded border border-ink-300 object-cover dark:border-ink-700"
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-lg font-bold">{score.title}</p>
        <p className="truncate text-base text-ink-700 dark:text-ink-200">
          {[score.artist, `${score.pageCount} ${score.pageCount === 1 ? 'page' : 'pages'}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton label="Move up" disabled={position === 0} onClick={() => onMove(-1)}>
          <span aria-hidden>↑</span>
        </IconButton>
        <IconButton
          label="Move down"
          disabled={position === total - 1}
          onClick={() => onMove(1)}
        >
          <span aria-hidden>↓</span>
        </IconButton>
        <Button onClick={onPlayFrom}>Play from here</Button>
        <IconButton label={`Remove ${score.title}`} variant="danger" onClick={onRemove}>
          <span aria-hidden>✕</span>
        </IconButton>
      </div>
    </li>
  );
}

export default function SetlistEditor({ setlistId }: { setlistId: string }) {
  const setlist = useLiveQuery(
    async () => (await db.setlists.get(setlistId)) ?? null,
    [setlistId],
  );
  const allScores = useScores();
  const thumbs = useThumbnails();
  const { settings } = useSettings();

  const [picking, setPicking] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

  const sensors = useSensors(
    // A small drag threshold so tapping the buttons inside a row still works.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = useMemo(
    () => new Map((allScores ?? []).map((score) => [score.id, score])),
    [allScores],
  );

  const items = useMemo(
    () =>
      (setlist?.scoreIds ?? [])
        .map((id) => byId.get(id))
        .filter((score): score is Score => score !== undefined),
    [setlist, byId],
  );

  const pickerResults = useMemo(
    () => (allScores ? filterAndSort(allScores, pickerQuery, null, 'title') : []),
    [allScores, pickerQuery],
  );

  const persist = async (scoreIds: string[]) => {
    await db.setlists.update(setlistId, { scoreIds, updatedAt: Date.now() });
  };

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !setlist) return;
    const ids = items.map((score) => score.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    await persist(arrayMove(ids, from, to));
  };

  const move = async (index: number, delta: number) => {
    const ids = items.map((score) => score.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    await persist(arrayMove(ids, index, to));
  };

  if (setlist === undefined || allScores === undefined) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-8 w-8 text-moss-500" />
      </div>
    );
  }

  if (setlist === null) {
    return (
      <EmptyState
        title="Setlist not found"
        body="It may have been deleted on this device."
        action={
          <Button
            size="lg"
            variant="primary"
            onClick={() => {
              window.location.hash = hrefFor({ name: 'setlists' });
            }}
          >
            All setlists
          </Button>
        }
      />
    );
  }

  const totalPages = items.reduce((sum, score) => sum + score.pageCount, 0);
  const invert = settings.darkMode && settings.invertScores;

  return (
    <div>
      <a
        href={hrefFor({ name: 'setlists' })}
        className="inline-block rounded text-lg font-semibold text-moss-500 hover:underline"
      >
        ‹ All setlists
      </a>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          {renaming === null ? (
            <h1 className="truncate text-3xl font-bold tracking-tight">{setlist.name}</h1>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const next = renaming.trim();
                if (next) await db.setlists.update(setlistId, { name: next, updatedAt: Date.now() });
                setRenaming(null);
              }}
            >
              <TextField
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                aria-label="Setlist name"
                className="min-h-[3.25rem] text-xl font-bold"
                autoFocus
              />
              <Button type="submit" size="lg" variant="primary">
                Save
              </Button>
            </form>
          )}
          <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
            {items.length} {items.length === 1 ? 'score' : 'scores'} · {totalPages} pages
          </p>
        </div>

        {renaming === null ? (
          <Button size="lg" onClick={() => setRenaming(setlist.name)}>
            Rename
          </Button>
        ) : null}
        <Button size="lg" onClick={() => setPicking(true)}>
          Add scores
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={items.length === 0}
          onClick={() => {
            window.location.hash = hrefFor({ name: 'perform', setlistId, index: 0 });
          }}
        >
          Play set
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="This setlist is empty"
          body="Add scores from your library, then drag them into running order."
          action={
            <Button size="lg" variant="primary" onClick={() => setPicking(true)}>
              Add scores
            </Button>
          }
        />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={items.map((score) => score.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="mt-5 flex flex-col gap-2">
              {items.map((score, position) => (
                <SortableScoreRow
                  key={score.id}
                  id={score.id}
                  position={position}
                  total={items.length}
                  score={score}
                  thumbnail={thumbs.get(score.id)}
                  invert={invert}
                  onMove={(delta) => void move(position, delta)}
                  onRemove={() =>
                    void persist(items.filter((s) => s.id !== score.id).map((s) => s.id))
                  }
                  onPlayFrom={() => {
                    window.location.hash = hrefFor({
                      name: 'perform',
                      setlistId,
                      index: position,
                    });
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <Modal
        open={picking}
        onClose={() => {
          setPicking(false);
          setPickerQuery('');
        }}
        wide
        title="Add scores"
        footer={
          <Button
            size="lg"
            variant="primary"
            onClick={() => {
              setPicking(false);
              setPickerQuery('');
            }}
          >
            Done
          </Button>
        }
      >
        <TextField
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          placeholder="Search your library"
          aria-label="Search your library"
          className="mb-4 min-h-[3.25rem] text-lg"
          autoFocus
        />
        {pickerResults.length === 0 ? (
          <p className="py-6 text-center text-lg text-ink-700 dark:text-ink-200">
            Nothing matches.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pickerResults.map((score) => {
              const already = setlist.scoreIds.includes(score.id);
              return (
                <li key={score.id}>
                  <button
                    type="button"
                    onClick={() => void persist([...setlist.scoreIds, score.id])}
                    disabled={already}
                    className={cx(
                      'flex min-h-[3.5rem] w-full items-center gap-3 rounded-xl border-2 p-2 text-left transition-colors',
                      already
                        ? 'cursor-not-allowed border-moss-500 bg-moss-500/10 opacity-70'
                        : 'border-ink-400 hover:border-ink-600 dark:border-ink-600 dark:hover:border-ink-400',
                    )}
                  >
                    <ThumbnailImage
                      thumbnail={thumbs.get(score.id)}
                      title={score.title}
                      invert={invert}
                      className="h-14 w-10 shrink-0 rounded border border-ink-300 object-cover dark:border-ink-700"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-lg font-semibold">{score.title}</span>
                      <span className="block truncate text-base text-ink-600 dark:text-ink-300">
                        {score.artist || 'Unknown artist'}
                      </span>
                    </span>
                    <span className="shrink-0 pr-2 font-bold text-moss-500">
                      {already ? 'In set' : 'Add'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
    </div>
  );
}
