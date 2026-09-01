import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FOLLOW_PROTOCOL_VERSION,
  newGate,
  receive,
  resume as resumeGate,
  takeControl as releaseGate,
  type FollowGate,
  type FollowPosition,
} from './followGate';
import type { EnsembleRole } from '../types';
import type { FollowSession, SyncTransport } from './transport';

export type FollowState =
  /** Not in a session. */
  | 'off'
  /** Connecting, or the channel has dropped. Manual turns work as always. */
  | 'disconnected'
  /** Receiving and moving with the director. */
  | 'following'
  /** In a session, but this musician turned a page and took control. */
  | 'released'
  /** This device is broadcasting. */
  | 'leading';

export interface FollowController {
  state: FollowState;
  ensembleId: string | null;
  /** Where the director last said they were, applied or not. */
  lastPosition: FollowPosition | null;
  /** Members following the director. Directors only; a count, never names. */
  listeners: number;
  start: (ensembleId: string, role: EnsembleRole) => void;
  stop: () => void;
  /** Re-arm after taking manual control. */
  resume: () => void;
  /** Any local page-turn intent. Instant, silent, no confirmation. */
  takeControl: () => void;
  /** Director side: report the current page. Coalesced and fire-and-forget. */
  report: (contentHash: string, page: number, title: string) => void;
}

/** At most ten broadcasts a second, however fast pages are turned. */
const BROADCAST_INTERVAL_MS = 100;
/** A director's session ends if their app stays backgrounded this long. */
const BACKGROUND_TIMEOUT_MS = 2 * 60 * 1000;

export interface PageFollowOptions {
  transport: SyncTransport | null;
  /** Called when an inbound position should move this device. */
  onFollowPage: (contentHash: string, page: number, position: FollowPosition) => void;
}

/**
 * Live page follow for a rehearsal.
 *
 * The rule that shapes everything: **any local page turn wins, immediately.**
 * Pedal, tap, button or key — the device leaves follow mode with no
 * confirmation and no delay, and stays out until the musician asks to rejoin.
 * A reader who is lost needs their own place more than they need to agree with
 * the director, and a device that fights the person holding it is worse than
 * one that is briefly out of step. The ordering guarantees live in
 * followGate.ts, which is tested directly.
 *
 * Losing the connection is not an error either: it shows as "not following"
 * and changes nothing else. Manual turns keep working the instant the socket
 * dies, because nothing about turning a page ever goes through here.
 */
export function usePageFollow({ transport, onFollowPage }: PageFollowOptions): FollowController {
  const [state, setState] = useState<FollowState>('off');
  const [ensembleId, setEnsembleId] = useState<string | null>(null);
  const [lastPosition, setLastPosition] = useState<FollowPosition | null>(null);
  const [listeners, setListeners] = useState(0);

  const session = useRef<FollowSession | null>(null);
  const gate = useRef<FollowGate>(newGate());
  const role = useRef<EnsembleRole | null>(null);
  const seq = useRef(0);
  const onFollowPageRef = useRef(onFollowPage);
  onFollowPageRef.current = onFollowPage;

  // Director-side coalescing.
  const pendingSend = useRef<FollowPosition | null>(null);
  const sendTimer = useRef<number | null>(null);
  const backgroundTimer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (sendTimer.current !== null) {
      window.clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
    if (backgroundTimer.current !== null) {
      window.clearTimeout(backgroundTimer.current);
      backgroundTimer.current = null;
    }
    pendingSend.current = null;
    session.current?.close();
    session.current = null;
    role.current = null;
    gate.current = newGate();
    seq.current = 0;
    setEnsembleId(null);
    setListeners(0);
    setLastPosition(null);
    setState('off');
  }, []);

  const start = useCallback(
    (id: string, memberRole: EnsembleRole) => {
      if (!transport) return;
      session.current?.close();
      gate.current = newGate();
      seq.current = 0;
      role.current = memberRole;
      setEnsembleId(id);
      setListeners(0);
      setState(memberRole === 'director' ? 'leading' : 'disconnected');

      session.current = transport.openFollowSession({
        ensembleId: id,
        role: memberRole,
        onPosition: (position) => {
          setLastPosition(position);
          const decision = receive(gate.current, position);
          gate.current = decision.gate;
          if (!decision.apply) return;
          onFollowPageRef.current(position.contentHash, decision.page, position);
        },
        onConnectionChange: (connected) => {
          if (role.current === 'director') {
            setState(connected ? 'leading' : 'disconnected');
            return;
          }
          // Someone who has taken control stays in control, whatever the
          // socket does underneath.
          if (gate.current.released) {
            setState('released');
            return;
          }
          setState(connected ? 'following' : 'disconnected');
        },
        onListenerCount: memberRole === 'director' ? setListeners : undefined,
      });
    },
    [transport],
  );

  const takeControl = useCallback(() => {
    if (role.current !== 'member') return;
    if (gate.current.released) return;
    gate.current = releaseGate(gate.current);
    setState('released');
  }, []);

  const resume = useCallback(() => {
    if (role.current !== 'member') return;
    gate.current = resumeGate(gate.current);
    setState('following');
    // Deliberately does not replay the last position: rejoining means "take me
    // from here on", and the director's next turn is at most a few bars away.
  }, []);

  const report = useCallback((contentHash: string, page: number, title: string) => {
    if (role.current !== 'director' || !session.current) return;
    seq.current += 1;
    pendingSend.current = {
      v: FOLLOW_PROTOCOL_VERSION,
      contentHash,
      title,
      page,
      seq: seq.current,
      sentAt: Date.now(),
    };
    if (sendTimer.current !== null) return;
    // Send the leading edge immediately so a single turn is not delayed, then
    // hold the window open to coalesce a flurry of them.
    const flush = () => {
      const payload = pendingSend.current;
      pendingSend.current = null;
      if (payload) session.current?.broadcast(payload);
      if (pendingSend.current === null) {
        sendTimer.current = null;
        return;
      }
      sendTimer.current = window.setTimeout(flush, BROADCAST_INTERVAL_MS);
    };
    flush();
    sendTimer.current = window.setTimeout(flush, BROADCAST_INTERVAL_MS);
  }, []);

  // A director who backgrounds the app for two minutes has left the rehearsal.
  useEffect(() => {
    const onVisibility = () => {
      if (role.current !== 'director') return;
      if (document.visibilityState === 'visible') {
        if (backgroundTimer.current !== null) {
          window.clearTimeout(backgroundTimer.current);
          backgroundTimer.current = null;
        }
        return;
      }
      backgroundTimer.current = window.setTimeout(stop, BACKGROUND_TIMEOUT_MS);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    state,
    ensembleId,
    lastPosition,
    listeners,
    start,
    stop,
    resume,
    takeControl,
    report,
  };
}
