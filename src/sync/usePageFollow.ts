import { useCallback, useEffect, useRef, useState } from 'react';
import type { PagePosition, SyncTransport } from './transport';

export type FollowState =
  /** Not participating in live page sync at all. */
  | 'off'
  /** Opted in and receiving. */
  | 'following'
  /** Opted in but the channel is down; manual turns still work normally. */
  | 'disconnected'
  /** Opted in, but the musician turned a page themselves and took control. */
  | 'released'
  /** This device is the one broadcasting. */
  | 'leading';

export interface PageFollow {
  state: FollowState;
  /** The last position the director called, whether or not we followed it. */
  lastPosition: PagePosition | null;
  /** Re-arm following after taking manual control. */
  resume: () => void;
  /**
   * Called by the performance view on any local page-turn intent — pedal, tap,
   * or button. Drops out of follow mode.
   */
  takeControl: () => void;
}

export interface PageFollowOptions {
  transport: SyncTransport | null;
  ensembleId: string | null;
  /** Directors broadcast; members receive. */
  role: 'director' | 'member' | null;
  enabled: boolean;
  onPosition: (position: PagePosition) => void;
}

/**
 * Live page following for an ensemble session.
 *
 * Two rules shape everything here.
 *
 * The pedal always wins. If a musician turns a page themselves, this device
 * leaves follow mode immediately and stays out until they ask to rejoin. A
 * reader who is lost needs to find their own place more than they need to agree
 * with the director, and a device that fights the person holding it is worse
 * than one that is merely out of step.
 *
 * A dropped connection is not an error. It shows as "not following" and
 * changes nothing else: manual turns keep working exactly as they always do.
 * This is also the one part of sync allowed to run during the performance view,
 * because it is a fire-and-forget broadcast of two numbers rather than a data
 * sync — but it still never blocks a turn.
 */
export function usePageFollow({
  transport,
  ensembleId,
  role,
  enabled,
  onPosition,
}: PageFollowOptions): PageFollow {
  const [state, setState] = useState<FollowState>('off');
  const [lastPosition, setLastPosition] = useState<PagePosition | null>(null);
  const released = useRef(false);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  const active = enabled && transport !== null && ensembleId !== null && role !== null;

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (role === 'director') {
      setState('leading');
      return;
    }

    released.current = false;
    setState('disconnected');

    const unsubscribe = transport.subscribeToPage(
      ensembleId,
      (position) => {
        setLastPosition(position);
        // Still record where the director is, but do not move a device whose
        // owner has taken over.
        if (released.current) return;
        onPositionRef.current(position);
      },
      (connected) => {
        // A musician who has taken control stays in control, whatever the
        // connection does underneath.
        if (released.current) return;
        setState(connected ? 'following' : 'disconnected');
      },
    );

    return () => {
      unsubscribe();
      setState('off');
    };
  }, [active, transport, ensembleId, role]);

  const takeControl = useCallback(() => {
    if (!active || role === 'director') return;
    if (released.current) return;
    released.current = true;
    setState('released');
  }, [active, role]);

  const resume = useCallback(() => {
    if (!active || role === 'director') return;
    released.current = false;
    setState('following');
    // Jump straight to wherever the director already is.
    if (lastPosition) onPositionRef.current(lastPosition);
  }, [active, role, lastPosition]);

  return { state, lastPosition, resume, takeControl };
}
