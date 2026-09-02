import { useCallback, useEffect, useRef, useState } from 'react';

export interface IdleUI {
  visible: boolean;
  /** Show the UI and restart the countdown. */
  bump: () => void;
  hide: () => void;
  toggle: () => void;
}

/**
 * How far a mouse must actually travel before it counts as "the user wants the
 * controls back". A hand resting on a trackpad, a knocked stand, or the tail of
 * the gesture that just dismissed the toolbar all move the pointer a little;
 * none of them mean anything.
 */
const REVEAL_DISTANCE_PX = 60;

/**
 * Movement only accumulates while it is continuous. A pause this long resets
 * the total, so slow drift never adds up to a reveal over a whole piece.
 */
const MOVEMENT_GAP_MS = 350;

/**
 * After the UI is dismissed on purpose, ignore the pointer entirely for a
 * moment. Dismissing is usually a click, and taking your hand off a mouse or
 * trackpad almost always nudges it — which was reopening the toolbar
 * immediately, on exactly the gesture meant to close it.
 */
const DISMISS_GRACE_MS = 1200;

/**
 * Shows chrome on interaction and hides it again after a period of quiet.
 *
 * Deliberately does *not* treat page turns as activity: a pedal press mid-song
 * should not pop the toolbar back over the score. Only deliberate pointer and
 * wheel input counts, plus whatever the view reports explicitly through `bump`.
 */
export function useIdleUI(timeoutMs = 3000, enabled = true): IdleUI {
  const [visible, setVisible] = useState(true);
  const timer = useRef<number | null>(null);

  /** Pointer movement not yet judged deliberate. */
  const travelled = useRef(0);
  const lastMoveAt = useRef(0);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  /** Pointer input is ignored until this timestamp. */
  const ignoreUntil = useRef(0);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const resetMovement = useCallback(() => {
    travelled.current = 0;
    lastPoint.current = null;
  }, []);

  const bump = useCallback(() => {
    clear();
    resetMovement();
    setVisible(true);
    timer.current = window.setTimeout(() => setVisible(false), timeoutMs);
  }, [clear, resetMovement, timeoutMs]);

  /** Dismissal on purpose: start the grace period so the hand can leave. */
  const dismiss = useCallback(() => {
    clear();
    resetMovement();
    ignoreUntil.current = Date.now() + DISMISS_GRACE_MS;
    setVisible(false);
  }, [clear, resetMovement]);

  const hide = dismiss;

  const toggle = useCallback(() => {
    setVisible((wasVisible) => {
      clear();
      resetMovement();
      if (wasVisible) {
        ignoreUntil.current = Date.now() + DISMISS_GRACE_MS;
        return false;
      }
      timer.current = window.setTimeout(() => setVisible(false), timeoutMs);
      return true;
    });
  }, [clear, resetMovement, timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      clear();
      setVisible(true);
      return;
    }

    // Only a mouse counts. On a touchscreen every tap emits pointermove, which
    // would pop the toolbar open on each page turn; taps are handled explicitly
    // by the tap zones instead.
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;

      const now = Date.now();
      if (now < ignoreUntil.current) {
        // Still settling after a deliberate dismissal.
        lastPoint.current = { x: event.clientX, y: event.clientY };
        travelled.current = 0;
        return;
      }

      const previous = lastPoint.current;
      lastPoint.current = { x: event.clientX, y: event.clientY };

      // A gap in movement means a new gesture, not a continuation of the last.
      if (!previous || now - lastMoveAt.current > MOVEMENT_GAP_MS) {
        travelled.current = 0;
        lastMoveAt.current = now;
        return;
      }
      lastMoveAt.current = now;

      travelled.current += Math.hypot(event.clientX - previous.x, event.clientY - previous.y);
      if (travelled.current >= REVEAL_DISTANCE_PX) bump();
    };

    // Scrolling is unambiguous, so it reveals immediately — but still not
    // during the grace period after a dismissal.
    const onWheel = () => {
      if (Date.now() < ignoreUntil.current) return;
      bump();
    };

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
