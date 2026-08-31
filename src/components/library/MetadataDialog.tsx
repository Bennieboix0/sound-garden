import { useEffect, useState } from 'react';
import { db } from '../../db/db';
import type { Score } from '../../types';
import { Button, Field, TextField } from '../ui/controls';
import { Modal } from '../ui/Modal';
import { parseTags } from './useLibrary';

interface Draft {
  title: string;
  artist: string;
  key: string;
  tempo: string;
  tags: string;
}

function toDraft(score: Score): Draft {
  return {
    title: score.title,
    artist: score.artist,
    key: score.key,
    tempo: score.tempo,
    tags: score.tags.join(', '),
  };
}

export default function MetadataDialog({
  score,
  onClose,
}: {
  score: Score | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(score ? toDraft(score) : null);
  }, [score]);

  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => (current ? { ...current, [field]: event.target.value } : current));

  const save = async () => {
    if (!score || !draft) return;
    setSaving(true);
    try {
      await db.scores.update(score.id, {
        title: draft.title.trim() || score.fileName,
        artist: draft.artist.trim(),
        key: draft.key.trim(),
        tempo: draft.tempo.trim(),
        tags: parseTags(draft.tags),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={score !== null && draft !== null}
      onClose={onClose}
      title="Edit details"
      footer={
        <>
          <Button size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {draft ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Title">
            <TextField value={draft.title} onChange={set('title')} autoFocus />
          </Field>
          <Field label="Composer or artist">
            <TextField value={draft.artist} onChange={set('artist')} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Key">
              <TextField value={draft.key} onChange={set('key')} placeholder="E♭ major" />
            </Field>
            <Field label="Tempo">
              <TextField value={draft.tempo} onChange={set('tempo')} placeholder="♩ = 120" />
            </Field>
          </div>
          <Field label="Tags" hint="Comma separated. Used for search and filtering.">
            <TextField value={draft.tags} onChange={set('tags')} placeholder="jazz, trio, book 2" />
          </Field>
          {score ? (
            <p className="text-sm text-ink-600 dark:text-ink-300">
              {score.fileName} · {score.pageCount} pages · added{' '}
              {new Date(score.dateAdded).toLocaleDateString()}
            </p>
          ) : null}
          {/* Lets Enter submit without a visible duplicate button. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      ) : null}
    </Modal>
  );
}
