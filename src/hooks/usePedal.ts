import { useEffect, useRef } from 'react';
import type { PedalAction, PedalBinding } from '../types';

/** Keys we must never swallow, whatever the user has mapped. */
const RESERVED = new Set(['Escape', 'Tab', 'F5', 'F11', 'F12']);

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function matchBinding(
  bindings: PedalBinding[],
  event: { code: string; key: string },
): PedalBinding | undefined {
  // `code` is the physical key and is what an HID pedal reports consistently.
  // `key` is the fallback for the rare pedal that reports no usable code.
  return (
    bindings.find((b) => b.code && b.code === event.code) ??
    bindings.find((b) => b.key && b.key === event.key)
  );
}

export interface PedalOptions {
  enabled: boolean;
  bindings: PedalBinding[];
  /** Ignore a repeat action inside this window. Leading edge, so no added latency. */
  debounceMs: number;
  onAction: (action: PedalAction) => void;
}

/**
 * Global page-turn key handling for the performance view.
 *
 * Bluetooth page turners enumerate as HID keyboards, so this is just a keydown
 * listener — but a careful one: it fires on the leading edge (a turn is never
 * delayed by the debounce), ignores auto-repeat from a held pedal, and stays
 * out of the way while a text field has focus.
 */
export function usePedal({ enabled, bindings, debounceMs, onAction }: PedalOptions): void {
  const lastFiredAt = useRef(0);
  const onActionRef = useRef(onAction);
  const bindingsRef = useRef(bindings);
  const debounceRef = useRef(debounceMs);

  onActionRef.current = onAction;
  bindingsRef.current = bindings;
  debounceRef.current = debounceMs;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // A held pedal must not machine-gun through the score.
      if (event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (RESERVED.has(event.code)) return;
      // Chorded presses are the user driving the browser, not the pedal.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const binding = matchBinding(bindingsRef.current, event);
      if (!binding) return;

      // Always swallow the key: Space and the arrows would otherwise scroll.
      event.preventDefault();

      const now = performance.now();
      if (now - lastFiredAt.current < debounceRef.current) return;
      lastFiredAt.current = now;

      onActionRef.current(binding.action);
    };

    // Capture phase, so a focused button cannot eat the pedal press.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled]);
}

export interface CaptureResult {
  code: string;
  key: string;
}

/**
 * Listens for a single keypress so the settings screen can learn whatever the
 * pedal actually sends. Returns a cleanup that stops listening.
 */
export function captureNextKey(onCapture: (result: CaptureResult) => void): () => void {
  const handler = (event: KeyboardEvent) => {
    if (event.code === 'Escape' || event.key === 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCapture({ code: event.code || event.key, key: event.key });
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}

/** Human-readable name for a captured key, for the settings list. */
export function describeKey(binding: { code: string; key: string }): string {
  const pretty: Record<string, string> = {
    Space: 'Space',
    ' ': 'Space',
    ArrowUp: 'Up arrow',
    ArrowDown: 'Down arrow',
    ArrowLeft: 'Left arrow',
    ArrowRight: 'Right arrow',
    PageUp: 'Page Up',
    PageDown: 'Page Down',
    Enter: 'Enter',
    NumpadEnter: 'Numpad Enter',
    Backspace: 'Backspace',
  };
  if (pretty[binding.code]) return pretty[binding.code];
  if (pretty[binding.key]) return pretty[binding.key];
  if (/^Key[A-Z]$/.test(binding.code)) return binding.code.slice(3);
  if (/^Digit\d$/.test(binding.code)) return binding.code.slice(5);
  if (binding.key && binding.key.length === 1) return binding.key.toUpperCase();
  return binding.code || binding.key || 'Unknown';
}
