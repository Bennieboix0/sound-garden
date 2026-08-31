import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '../../db/db';
import { captureNextKey, describeKey, matchBinding, usePedal } from '../../hooks/usePedal';
import { useSettings } from '../../state/SettingsProvider';
import type { PedalAction, PedalBinding } from '../../types';
import { Button, cx } from '../ui/controls';
import { Modal } from '../ui/Modal';

const ACTION_LABEL: Record<PedalAction, string> = {
  next: 'Next page',
  prev: 'Previous page',
};

export default function PedalSettings() {
  const { settings, update } = useSettings();
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<{ code: string; key: string } | null>(null);
  const [lastFired, setLastFired] = useState<{ action: PedalAction; at: number } | null>(null);

  // Live tester: while this screen is open, mapped keys light up rather than
  // turning pages, so the musician can confirm the pedal before the gig.
  usePedal({
    enabled: !capturing,
    bindings: settings.pedalBindings,
    debounceMs: settings.debounceMs,
    onAction: (action) => setLastFired({ action, at: Date.now() }),
  });

  useEffect(() => {
    if (!lastFired) return;
    const timer = window.setTimeout(() => setLastFired(null), 900);
    return () => window.clearTimeout(timer);
  }, [lastFired]);

  useEffect(() => {
    if (!capturing) return;
    return captureNextKey((result) => {
      setCaptured(result);
      setCapturing(false);
    });
  }, [capturing]);

  const assign = (action: PedalAction) => {
    if (!captured) return;
    const without = settings.pedalBindings.filter(
      (binding) => binding.code !== captured.code,
    );
    update({
      pedalBindings: [...without, { code: captured.code, key: captured.key, action }],
    });
    setCaptured(null);
  };

  const remove = (binding: PedalBinding) => {
    update({
      pedalBindings: settings.pedalBindings.filter(
        (b) => !(b.code === binding.code && b.action === binding.action),
      ),
    });
  };

  const setDebounce = (value: number) => {
    update({ debounceMs: Math.max(0, Math.min(1000, value)) });
  };

  const existingForCaptured = captured
    ? matchBinding(settings.pedalBindings, captured)
    : undefined;

  return (
    <section className="rounded-2xl border-2 border-ink-300 bg-white p-5 dark:border-ink-700 dark:bg-ink-850">
      <h2 className="text-2xl font-bold">Foot pedal</h2>
      <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
        Bluetooth page turners pair as keyboards. Pair yours with this device, then press a pedal
        below to learn whatever key it actually sends.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="lg" variant="primary" onClick={() => setCapturing(true)}>
          Press a pedal to map it
        </Button>
        <Button
          size="lg"
          onClick={() => update({ pedalBindings: DEFAULT_SETTINGS.pedalBindings })}
        >
          Restore defaults
        </Button>
      </div>

      <div
        className={cx(
          'mt-4 flex min-h-[4.5rem] items-center justify-center rounded-xl border-2 px-4 text-xl font-bold transition-colors',
          lastFired
            ? 'border-moss-500 bg-moss-500 text-white'
            : 'border-ink-300 text-ink-700 dark:border-ink-600 dark:text-ink-200',
        )}
        role="status"
      >
        {lastFired
          ? `${ACTION_LABEL[lastFired.action]} — pedal working`
          : 'Press your pedal now to test it'}
      </div>

      <h3 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        Mapped keys
      </h3>
      {settings.pedalBindings.length === 0 ? (
        <p className="mt-2 text-lg font-semibold text-amber-500">
          Nothing is mapped — page turns will not work.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {settings.pedalBindings.map((binding) => (
            <li
              key={`${binding.code}:${binding.action}`}
              className="flex items-center gap-3 rounded-xl border-2 border-ink-300 p-3 dark:border-ink-600"
            >
              <span className="min-w-[7rem] rounded-lg bg-ink-200 px-3 py-1.5 text-center text-lg font-bold dark:bg-ink-700">
                {describeKey(binding)}
              </span>
              <span className="flex-1 text-lg font-semibold">{ACTION_LABEL[binding.action]}</span>
              <Button variant="danger" onClick={() => remove(binding)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-lg font-bold uppercase tracking-wide text-ink-600 dark:text-ink-300">
        Debounce
      </h3>
      <p className="mt-1 text-base text-ink-700 dark:text-ink-200">
        Ignores a second press inside this window, so one stomp never turns two pages. The first
        press always acts immediately.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="lg" onClick={() => setDebounce(settings.debounceMs - 50)} aria-label="Less debounce">
          −50 ms
        </Button>
        <span className="min-w-[7rem] text-center text-2xl font-bold tabular-nums">
          {settings.debounceMs} ms
        </span>
        <Button size="lg" onClick={() => setDebounce(settings.debounceMs + 50)} aria-label="More debounce">
          +50 ms
        </Button>
      </div>

      <Modal
        open={capturing}
        onClose={() => setCapturing(false)}
        title="Press your pedal"
        footer={
          <Button size="lg" onClick={() => setCapturing(false)}>
            Cancel
          </Button>
        }
      >
        <p className="py-6 text-center text-2xl font-bold">Waiting for a key…</p>
        <p className="text-center text-base text-ink-700 dark:text-ink-200">
          Press the pedal you want to map. Escape cancels.
        </p>
      </Modal>

      <Modal
        open={captured !== null}
        onClose={() => setCaptured(null)}
        title="What should this do?"
        footer={
          <Button size="lg" onClick={() => setCaptured(null)}>
            Cancel
          </Button>
        }
      >
        <p className="text-center text-lg">Your pedal sent</p>
        <p className="mt-2 text-center text-3xl font-bold">
          {captured ? describeKey(captured) : ''}
        </p>
        <p className="mt-1 text-center text-sm text-ink-600 dark:text-ink-300">
          code: {captured?.code}
        </p>
        {existingForCaptured ? (
          <p className="mt-4 rounded-xl border-2 border-amber-400 bg-amber-400/10 px-4 py-3 text-center font-semibold">
            Already mapped to {ACTION_LABEL[existingForCaptured.action]}. Choosing below will
            replace it.
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-3">
          <Button size="xl" variant="primary" onClick={() => assign('next')}>
            Next page
          </Button>
          <Button size="xl" variant="primary" onClick={() => assign('prev')}>
            Previous page
          </Button>
        </div>
      </Modal>
    </section>
  );
}
