import { useMemo, useState } from 'react';
import { newId } from '../../db/db';
import { useScores } from '../library/useLibrary';
import {
  useAssignments,
  useEnsembleActions,
  useEnsembleMembers,
  useEnsembles,
} from '../../sync/ensembleClient';
import { SYNC_ENABLED, isSyncConfigured } from '../../sync/flags';
import { useSyncStatus } from '../../sync/useSync';
import type { Assignment, Ensemble } from '../../types';
import { Button, EmptyState, Field, TextField, cx } from '../ui/controls';
import { ConfirmDialog, Modal } from '../ui/Modal';

function AssignmentEditor({
  ensemble,
  memberId,
  memberName,
  existing,
  onClose,
}: {
  ensemble: Ensemble;
  memberId: string;
  memberName: string;
  existing: Assignment | null;
  onClose: () => void;
}) {
  const actions = useEnsembleActions();
  const scores = useScores() ?? [];
  const [title, setTitle] = useState(existing?.title ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [bar, setBar] = useState(existing?.barReference ?? '');
  const [contentHash, setContentHash] = useState(existing?.contentHash ?? '');
  const [due, setDue] = useState(
    existing?.dueDate ? new Date(existing.dueDate).toISOString().slice(0, 10) : '',
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const now = Date.now();
    try {
      await actions.saveAssignment({
        id: existing?.id ?? newId(),
        ensembleId: ensemble.id,
        memberId,
        title: title.trim(),
        notes: notes.trim(),
        contentHash: contentHash || undefined,
        barReference: bar.trim() || undefined,
        dueDate: due ? new Date(`${due}T12:00:00`).getTime() : undefined,
        completedAt: existing?.completedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${existing ? 'Edit' : 'New'} assignment for ${memberName}`}
      footer={
        <>
          <Button size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" disabled={busy || !title.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What to practise">
          <TextField
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Bars 40–56, slowly"
            autoFocus
          />
        </Field>
        <Field label="Notes" hint="Optional. This is about the music, not a message thread.">
          <TextField value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Score">
            <select
              value={contentHash}
              onChange={(e) => setContentHash(e.target.value)}
              className="min-h-[2.75rem] w-full px-3 text-base"
            >
              <option value="">Not tied to a score</option>
              {scores.map((score) => (
                <option key={score.id} value={score.contentHash}>
                  {score.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bars">
            <TextField value={bar} onChange={(e) => setBar(e.target.value)} placeholder="40–56" />
          </Field>
        </div>
        <Field label="Due">
          <TextField type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function EnsembleCard({ ensemble }: { ensemble: Ensemble }) {
  const actions = useEnsembleActions();
  const members = useEnsembleMembers(ensemble.id);
  const assignments = useAssignments();
  const status = useSyncStatus();
  const scores = useScores() ?? [];
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const [editing, setEditing] = useState<{ memberId: string; name: string; existing: Assignment | null } | null>(null);
  const [publishFor, setPublishFor] = useState('');
  const [published, setPublished] = useState<string | null>(null);

  const isDirector = ensemble.role === 'director';
  const mine = assignments.filter(
    (a) => a.ensembleId === ensemble.id && a.memberId === status.user?.id,
  );
  const roster = members.filter((m) => m.role === 'member');

  return (
    <li className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="truncate text-2xl font-bold">{ensemble.name}</h3>
          <p className="text-base text-ink-700 dark:text-ink-200">
            {isDirector ? 'You direct this group' : 'You are a member'}
            {isDirector ? ` · ${roster.length} ${roster.length === 1 ? 'member' : 'members'}` : ''}
          </p>
        </div>
        {isDirector ? (
          <Button variant="danger" onClick={() => setConfirm('delete')}>
            Delete group
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setConfirm('leave')}>
            Leave
          </Button>
        )}
      </div>

      {isDirector && ensemble.joinCode ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
              Join code
            </p>
            <p className="font-mono text-3xl font-bold tracking-[0.2em]">{ensemble.joinCode}</p>
          </div>
          <Button className="ml-auto" onClick={() => void actions.rotateCode(ensemble.id)}>
            New code
          </Button>
        </div>
      ) : null}

      {isDirector ? (
        <>
          <h4 className="mt-5 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
            Publish markings
          </h4>
          <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
            Sends a copy of your own markings for one score to everyone in the group. They can see
            them but never edit them, and their own markings stay private to them.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <select
              value={publishFor}
              onChange={(e) => setPublishFor(e.target.value)}
              className="min-h-[3rem] px-3 text-base"
              aria-label="Score to publish"
            >
              <option value="">Choose a score…</option>
              {scores.map((score) => (
                <option key={score.id} value={score.contentHash}>
                  {score.title}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              disabled={!publishFor}
              onClick={() => {
                void actions.publish(ensemble.id, publishFor).then((n) => {
                  setPublished(
                    n === 0 ? 'That score has no markings to publish yet.' : `Published ${n} markings.`,
                  );
                });
              }}
            >
              Publish
            </Button>
            {published ? <span className="font-semibold text-moss-500">{published}</span> : null}
          </div>

          <h4 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
            Members
          </h4>
          {roster.length === 0 ? (
            <p className="mt-2 text-base text-ink-700 dark:text-ink-200">
              Nobody has joined yet. Read them the code above.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {roster.map((member) => {
                const theirs = assignments.filter(
                  (a) => a.ensembleId === ensemble.id && a.memberId === member.userId,
                );
                const done = theirs.filter((a) => a.completedAt).length;
                return (
                  <li
                    key={member.userId}
                    className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-ink-300 p-3 dark:border-ink-600"
                  >
                    <span className="mr-auto min-w-0">
                      <span className="block truncate text-lg font-semibold">{member.displayName}</span>
                      <span className="block text-sm text-ink-600 dark:text-ink-300">
                        {theirs.length === 0
                          ? 'No assignments'
                          : `${done} of ${theirs.length} done`}
                      </span>
                    </span>
                    <Button
                      onClick={() =>
                        setEditing({ memberId: member.userId, name: member.displayName, existing: null })
                      }
                    >
                      Assign
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      {!isDirector ? (
        <>
          <h4 className="mt-5 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
            Your assignments
          </h4>
          {mine.length === 0 ? (
            <p className="mt-2 text-base text-ink-700 dark:text-ink-200">Nothing set right now.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {mine.map((assignment) => (
                <li
                  key={assignment.id}
                  className={cx(
                    'flex flex-wrap items-center gap-3 rounded-xl border-2 p-3',
                    assignment.completedAt
                      ? 'border-moss-500 bg-moss-500/10'
                      : 'border-ink-300 dark:border-ink-600',
                  )}
                >
                  <span className="mr-auto min-w-0">
                    <span className="block text-lg font-semibold">{assignment.title}</span>
                    {assignment.notes ? (
                      <span className="block text-base text-ink-700 dark:text-ink-200">
                        {assignment.notes}
                      </span>
                    ) : null}
                    <span className="block text-sm text-ink-600 dark:text-ink-300">
                      {[
                        assignment.barReference ? `Bars ${assignment.barReference}` : null,
                        assignment.dueDate
                          ? `Due ${new Date(assignment.dueDate).toLocaleDateString()}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Button
                    variant={assignment.completedAt ? 'secondary' : 'primary'}
                    onClick={() => void actions.setDone(assignment.id, !assignment.completedAt)}
                  >
                    {assignment.completedAt ? 'Done' : 'Mark done'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {editing ? (
        <AssignmentEditor
          ensemble={ensemble}
          memberId={editing.memberId}
          memberName={editing.name}
          existing={editing.existing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'delete' ? 'Delete this group?' : 'Leave this group?'}
        body={
          confirm === 'delete'
            ? 'The group, its members, its setlists, its assignments and everything published to it will be permanently deleted for everyone. Your own personal markings are not affected.'
            : 'You will stop receiving this group’s markings and assignments, and your membership will be deleted. Your own personal markings stay exactly as they are.'
        }
        confirmLabel={confirm === 'delete' ? 'Delete group' : 'Leave'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const which = confirm;
          setConfirm(null);
          if (which === 'delete') void actions.remove(ensemble.id);
          else void actions.leave(ensemble.id);
        }}
      />
    </li>
  );
}

export default function EnsemblesView() {
  const ensembles = useEnsembles();
  const actions = useEnsembleActions();
  const status = useSyncStatus();
  const [joinCode, setJoinCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const signedIn = Boolean(status.user);
  const sorted = useMemo(
    () => [...ensembles].sort((a, b) => a.name.localeCompare(b.name)),
    [ensembles],
  );

  if (!SYNC_ENABLED || !isSyncConfigured()) {
    return (
      <EmptyState
        title="Ensembles need a sync server"
        body="This build is local-only, so there is nothing to join. Everything else in Sound Garden works exactly as it does now."
      />
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Ensembles</h1>
      <p className="mt-1 max-w-2xl text-base text-ink-700 dark:text-ink-200">
        A director publishes markings and setlists to the group. Your own markings stay private —
        nobody else can see them, including your director.
      </p>

      {actions.error ? (
        <p className="mt-4 rounded-xl border-2 border-amber-400 bg-amber-400/10 px-4 py-3 font-semibold">
          {actions.error}
        </p>
      ) : null}

      {!signedIn ? (
        <form
          className="mt-5 flex max-w-lg flex-col gap-4 rounded-2xl border-2 border-ink-300 p-5 dark:border-ink-700"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void actions
              .joinEnsemble(joinCode, displayName)
              .finally(() => setBusy(false));
          }}
        >
          <h2 className="text-xl font-bold">Join a group</h2>
          <p className="text-base text-ink-700 dark:text-ink-200">
            You need a code from your director and a name to appear as. No email, no phone number,
            nothing else — and you can pick any name you like.
          </p>
          <Field label="Join code">
            <TextField
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABC234"
              maxLength={6}
              className="font-mono text-2xl tracking-[0.2em]"
            />
          </Field>
          <Field label="Your name in this group">
            <TextField
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ben R"
            />
          </Field>
          <Button
            type="submit"
            size="lg"
            variant="primary"
            disabled={busy || joinCode.length < 6 || !displayName.trim()}
            className="w-fit"
          >
            Join
          </Button>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            Directing a group instead? Sign in from Settings first.
          </p>
        </form>
      ) : (
        <form
          className="mt-5 flex max-w-lg flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void actions
              .createEnsemble(newName.trim(), status.user?.displayName ?? 'Director')
              .then(() => setNewName(''))
              .finally(() => setBusy(false));
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <Field label="Start a group">
              <TextField
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="School Orchestra"
              />
            </Field>
          </div>
          <Button type="submit" size="lg" variant="primary" disabled={busy || !newName.trim()}>
            Create
          </Button>
        </form>
      )}

      {sorted.length === 0 ? (
        <EmptyState
          title="No groups yet"
          body={
            signedIn
              ? 'Create one above, then read the join code out to your players.'
              : 'Enter a code from your director to join one.'
          }
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {sorted.map((ensemble) => (
            <EnsembleCard key={ensemble.id} ensemble={ensemble} />
          ))}
        </ul>
      )}
    </div>
  );
}
