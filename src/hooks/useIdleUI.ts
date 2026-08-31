import { useCallback, useEffect, useRef, useState } from 'react';

export interface IdleUI {
  visible: boolean;
  /** Show the UI and restart the countdown. */
  bump: () => void;
  hide: () => void;
  toggle: () => void;
}

/**
 * Shows chrome on interaction and hides it again after a period of quiet.
 *
 * Deliberately does *not* treat page turns as activity: a pedal press mid-song
 * should not pop the toolbar back over the score. Only pointer and wheel input
 * counts, plus whatever the view reports explicitly through `bump`.
 */
export function useIdleUI(timeoutMs = 3000, enabled = true): IdleUI {
  const [visible, setVisible] = useState(true);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const bump = useCallback(() => {
    clear();
    setVisible(true);
    timer.current = window.setTimeout(() => setVisible(false), timeoutMs);
  }, [clear, timeoutMs]);

  const hide = useCallback(() => {
    clear();
    setVisible(false);
  }, [clear]);

  const toggle = useCallback(() => {
    setVisible((wasVisible) => {
      clear();
      if (!wasVisible) {
        timer.current = window.setTimeout(() => setVisible(false), timeoutMs);
      }
      return !wasVisible;
    });
  }, [clear, timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      clear();
      setVisible(true);
      return;
    }

    // Only a mouse counts. On a touchscreen every tap emits pointermove, which
    // would pop the toolbar open on each page turn; taps are handled explicitly
    // by the tap zones instead. Deliberately does not also test movementX/Y —
    // some setups report zero movement, and failing to summon the controls is
    // far worse than summoning them slightly too eagerly.
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      bump();
    };
    const onWheel = () => bump();

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });

    bump();

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('wheel', onWheel);
      clear();
    };
  }, [enabled, bump, clear]);

  return { visible, bump, hide, toggle };
}
