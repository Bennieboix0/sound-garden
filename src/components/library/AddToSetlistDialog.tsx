import { useState } from 'react';
import { db, newId } from '../../db/db';
import type { Score } from '../../types';
import { Button, TextField, cx } from '../ui/controls';
import { Modal } from '../ui/Modal';
import { useSetlists } from './useLibrary';

export default function AddToSetlistDialog({
  score,
  onClose,
}: {
  score: Score | null;
  onClose: () => void;
}) {
  const setlists = useSetlists();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  const addTo = async (setlistId: string) => {
    if (!score) return;
    setBusy(true);
    try {
      const setlist = await db.setlists.get(setlistId);
      if (!setlist) return;
      // Appending a duplicate is legitimate — a tune can recur in a set — but
      // it is much more often a mis-tap, so say so rather than silently adding.
      if (setlist.scoreIds.includes(score.id)) {
        setAdded(`Already in "${setlist.name}".`);
        return;
      }
      await db.setlists.update(setlistId, {
        scoreIds: [...setlist.scoreIds, score.id],
        updatedAt: Date.now(),
      });
      setAdded(`Added to "${setlist.name}".`);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (!score) return;
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const now = Date.now();
      await db.setlists.add({
        id: newId(),
        name,
        scoreIds: [score.id],
        createdAt: now,
        updatedAt: now,
      });
      setNewName('');
      setAdded(`Created "${name}" with this score.`);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setAdded(null);
    setNewName('');
    onClose();
  };

  return (
    <Modal
      open={score !== null}
      onClose={close}
      title={`Add "${score?.title ?? ''}" to a setlist`}
      footer={
        <Button size="lg" variant="primary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {added ? (
          <p className="rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3 font-semibold">
            {added}
          </p>
        ) : null}

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createAndAdd();
          }}
        >
          <TextField
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New setlist name"
            aria-label="New setlist name"
            className="min-h-[3.25rem] text-lg"
          />
          <Button type="submit" size="lg" variant="primary" disabled={busy || !newName.trim()}>
            Create
          </Button>
        </form>

        {setlists === undefined ? null : setlists.length === 0 ? (
          <p className="text-lg text-ink-700 dark:text-ink-200">
            No setlists yet. Create one above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {setlists.map((setlist) => {
              const contains = score ? setlist.scoreIds.includes(score.id) : false;
              return (
                <li key={setlist.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addTo(setlist.id)}
                    className={cx(
                      'flex min-h-[3.5rem] w-full items-center justify-between gap-3 rounded-xl border-2 px-4 text-left transition-colors',
                      'disabled:opacity-50',
                      contains
                        ? 'border-moss-500 bg-moss-500/10'
                        : 'border-ink-400 hover:border-ink-600 dark:border-ink-600 dark:hover:border-ink-400',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-lg font-semibold">{setlist.name}</span>
                      <span className="block text-sm text-ink-600 dark:text-ink-300">
                        {setlist.scoreIds.length}{' '}
                        {setlist.scoreIds.length === 1 ? 'score' : 'scores'}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold text-moss-500">
                      {contains ? 'In set' : 'Add'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
