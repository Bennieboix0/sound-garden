import { useState } from 'react';
import { db, newId } from '../../db/db';
import { hrefFor } from '../../state/router';
import type { Setlist } from '../../types';
import { Button, EmptyState, Spinner, TextField } from '../ui/controls';
import { ConfirmDialog } from '../ui/Modal';
import { useSetlists } from '../library/useLibrary';

export default function SetlistsView() {
  const setlists = useSetlists();
  const [name, setName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Setlist | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const now = Date.now();
    const id = newId();
    await db.setlists.add({ id, name: trimmed, scoreIds: [], createdAt: now, updatedAt: now });
    setName('');
    window.location.hash = hrefFor({ name: 'setlist', id });
  };

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Setlists</h1>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <TextField
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New setlist name"
          aria-label="New setlist name"
          className="min-h-[3.25rem] text-lg"
        />
        <Button type="submit" size="lg" variant="primary" disabled={!name.trim()}>
          Create
        </Button>
      </form>

      {setlists === undefined ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-8 w-8 text-moss-500" />
        </div>
      ) : setlists.length === 0 ? (
        <EmptyState
          title="No setlists yet"
          body="A setlist plays straight through: the last page of one score turns to the first page of the next."
        />
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {setlists.map((setlist) => (
            <li
              key={setlist.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-ink-300 bg-white p-3 dark:border-ink-700 dark:bg-ink-850"
            >
              <a
                href={hrefFor({ name: 'setlist', id: setlist.id })}
                className="min-w-0 flex-1 rounded"
              >
                <span className="block truncate text-xl font-bold hover:underline">
                  {setlist.name}
                </span>
                <span className="block text-base text-ink-700 dark:text-ink-200">
                  {setlist.scoreIds.length} {setlist.scoreIds.length === 1 ? 'score' : 'scores'} ·
                  updated {new Date(setlist.updatedAt).toLocaleDateString()}
                </span>
              </a>
              <Button
                size="lg"
                variant="primary"
                disabled={setlist.scoreIds.length === 0}
                onClick={() => {
                  window.location.hash = hrefFor({
                    name: 'perform',
                    setlistId: setlist.id,
                    index: 0,
                  });
                }}
              >
                Play set
              </Button>
              <Button
                size="lg"
                onClick={() => {
                  window.location.hash = hrefFor({ name: 'setlist', id: setlist.id });
                }}
              >
                Edit
              </Button>
              <Button size="lg" variant="danger" onClick={() => setPendingDelete(setlist)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this setlist?"
        body={`"${pendingDelete?.name ?? ''}" will be removed. The scores in it stay in your library.`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) await db.setlists.delete(target.id);
        }}
      />
    </div>
  );
}
