import { useState } from 'react';
import { syncClient } from '../../sync/client';
import { describeError } from '../../sync/ensembleClient';
import { SYNC_ENABLED, isSyncConfigured } from '../../sync/flags';
import { useSyncStatus } from '../../sync/useSync';
import { Button, Field, Spinner, TextField, cx } from '../ui/controls';
import { ConfirmDialog } from '../ui/Modal';

function relativeTime(at: number | null): string {
  if (!at) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

export default function SyncPanel() {
  const status = useSyncStatus();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!SYNC_ENABLED) return null;

  /** Set when the account exists but cannot be signed into yet. */
  const [recovery, setRecovery] = useState<'confirm' | 'password' | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setRecovery(null);
    try {
      if (mode === 'up') await syncClient.signUp(email, password, displayName.trim());
      else await syncClient.signIn(email, password);
      setEmail('');
      setPassword('');
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? '';
      const message = describeError(err);

      // "User already registered" while signing up is not really an error — the
      // account is there, they just want the other form. Sending them to it
      // with the email kept avoids the dead end of being unable to sign up and
      // not realising sign-in is the way through.
      if (code === 'user_already_exists' || /already registered/i.test(message)) {
        setMode('in');
        setPassword('');
        setNotice(
          'That email already has an account. Sign in below — and use “Forgot your password?” if you cannot remember it.',
        );
        setRecovery('password');
      } else if (code === 'email_not_confirmed' || /not confirmed/i.test(message)) {
        setError('This account has not been confirmed yet. Check your email for the link.');
        setRecovery('confirm');
      } else if (/invalid login credentials/i.test(message)) {
        setError('That email and password do not match an account.');
        setRecovery('password');
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const runRecovery = async () => {
    if (!email.trim()) {
      setError('Enter your email address first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (recovery === 'confirm') {
        await syncClient.resendConfirmation(email.trim());
        setNotice('Confirmation email sent. Follow the link, then sign in.');
      } else {
        await syncClient.sendPasswordReset(email.trim());
        setNotice('Password reset email sent. Follow the link to choose a new one.');
      }
      setRecovery(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await syncClient.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sound-garden-account-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice('Downloaded everything the server holds for this account.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">Sync</h2>
      <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
        Optional. Signing in carries your markings, setlists and per-score display settings between
        your own devices.{' '}
        <strong className="font-bold">
          Your PDFs are never uploaded — only a fingerprint that identifies them.
        </strong>{' '}
        Everything keeps working offline either way.
      </p>

      {!isSyncConfigured() ? (
        <p className="mt-4 rounded-xl border-2 border-ink-400 px-4 py-3 font-semibold dark:border-ink-600">
          This build has no sync server configured, so the app is local-only. Nothing is missing —
          every feature works exactly as it does now.
        </p>
      ) : status.user ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ['Signed in as', status.user.displayName],
              ['Status', status.state === 'syncing' ? 'Syncing…' : status.state],
              ['Last synced', relativeTime(status.lastSyncedAt)],
              ['Waiting to send', String(status.pendingChanges)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm font-semibold uppercase tracking-wide text-ink-600 dark:text-ink-300">
                  {label}
                </dt>
                <dd className="truncate text-lg font-bold">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button size="lg" variant="primary" disabled={busy} onClick={() => void syncClient.sync('manual')}>
              Sync now
            </Button>
            <Button size="lg" disabled={busy} onClick={() => void exportData()}>
              Export my data
            </Button>
            <Button size="lg" disabled={busy} onClick={() => void syncClient.signOut()}>
              Sign out
            </Button>
            <Button size="lg" variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete server data
            </Button>
          </div>
        </>
      ) : (
        <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
          <div className="inline-flex w-fit rounded-xl border-2 border-ink-400 p-1 dark:border-ink-600">
            {(['in', 'up'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
                className={cx(
                  'min-h-[2.75rem] rounded-lg px-5 text-base no-select transition-colors',
                  mode === option
                    ? 'bg-moss-500 font-semibold text-white'
                    : 'font-medium text-ink-800 dark:text-ink-200',
                )}
              >
                {option === 'in' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {mode === 'up' ? (
            <Field label="Display name" hint="This is the only name anyone else can ever see.">
              <TextField
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="nickname"
                required
              />
            </Field>
          ) : null}
          <Field label="Email">
            <TextField
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Password">
            <TextField
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              required
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" variant="primary" disabled={busy} className="w-fit">
              {busy ? <Spinner /> : mode === 'up' ? 'Create account' : 'Sign in'}
            </Button>
            {/* A way out of the two states that otherwise strand you: an account
                that exists but whose password you have lost, and one that was
                never confirmed. */}
            {mode === 'in' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecovery('password');
                  void runRecovery();
                }}
                className="min-h-touch text-base font-semibold underline decoration-dotted underline-offset-4 disabled:opacity-50"
              >
                Forgot your password?
              </button>
            ) : null}
            {recovery === 'confirm' ? (
              <Button size="lg" disabled={busy} onClick={() => void runRecovery()}>
                Resend confirmation email
              </Button>
            ) : null}
          </div>
        </form>
      )}

      {notice ? (
        <p className="mt-4 rounded-xl border-2 border-moss-500 bg-moss-500/10 px-4 py-3 font-semibold">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-xl border-2 border-red-500 bg-red-500/10 px-4 py-3 font-semibold">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete everything on the server?"
        body="Your markings, setlists and display preferences will be permanently deleted from the server. The rows are really removed, not just flagged. Everything on this device stays exactly as it is."
        confirmLabel="Delete server data"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          setBusy(true);
          void syncClient
            .deleteMyServerData()
            .then(() => setNotice('Server data deleted.'))
            .catch((err: unknown) =>
              setError(err instanceof Error ? err.message : 'Delete failed.'),
            )
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}
